import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { postMessage, updateMessage, getFileInfo, downloadFile, pinMessage, getMessage } from "@/lib/slack";
import { transcribeVideo } from "@/lib/openai";
import { analyzeAdImage } from "@/lib/analyze-image";
import {
  handleOnboardingMessage,
  startOnboardingInThread,
  isOnboardingThread,
} from "@/lib/onboarding";
import { parseCommand, executeCommand, shouldStartOnboarding } from "@/lib/commands";
import { addBrandNote } from "@/lib/context";
import { handleCopyFeedback, isCopyThread } from "@/lib/copy-feedback";
import { supabase } from "@/lib/supabase";
import { extractVoiceProfile, getVoiceProfileByChannel } from "@/lib/voice-profile";
import { generateCopy } from "@/lib/generate-copy";
import { classifyUploadIntent, analyzeCompetitorAd } from "@/lib/analyze-competitor";
import { extractUrl, fetchMediaFromUrl } from "@/lib/fetch-url-media";
import { friendlyError } from "@/lib/anthropic";
import {
  formatVariantsForSlack,
  formatCompetitorAnalysisForSlack,
  formatWelcomeMessage,
  formatTeamMemberWelcome,
} from "@/lib/format-slack";
import type { SlackUrlVerification, SlackEventCallback } from "@/lib/types";

export const dynamic = "force-dynamic";

const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";

const VIDEO_EXTENSIONS = [
  "mp4", "mp3", "m4a", "wav", "webm", "mov", "ogg", "flac",
];

const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "webp",
];

const ALL_MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

/**
 * Deduplicate events using Supabase.
 */
async function isDuplicate(eventId: string): Promise<boolean> {
  const { error } = await supabase
    .from("processed_events")
    .insert({ event_id: eventId });

  if (error?.code === "23505") return true;
  if (error) console.error("Dedup check error:", error.message);
  return false;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as
    | SlackUrlVerification
    | SlackEventCallback;

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback") {
    const { event, event_id } = body;

    if (await isDuplicate(event_id)) {
      return NextResponse.json({ ok: true });
    }

    // ─── Bot joined a channel → post & pin welcome message ───
    if (event.type === "member_joined_channel") {
      if (event.user === BOT_USER_ID) {
        after(async () => {
          try {
            await handleBotJoined(event.channel);
          } catch (err) {
            console.error("Error handling bot join:", err);
          }
        });
      } else {
        // Human joined → welcome with profile overview if available
        after(async () => {
          try {
            await handleMemberJoined(event.user, event.channel);
          } catch (err) {
            console.error("Error handling member join:", err);
          }
        });
      }
      return NextResponse.json({ ok: true });
    }

    // ─── File shared → video processing ───
    if (event.type === "file_shared") {
      after(async () => {
        try {
          await handleFileShared(
            event.file_id,
            event.user_id,
            event.channel_id,
            event.event_ts
          );
        } catch (err) {
          console.error("Error handling file_shared:", err);
        }
      });
      return NextResponse.json({ ok: true });
    }

    // ─── Messages (skip bot messages) ───
    if (
      event.type === "message" &&
      !event.subtype &&
      !event.bot_id
    ) {
      // --- DM messages ---
      if (event.channel_type === "im") {
        after(async () => {
          try {
            await handleDM(event.user, event.channel, event.text);
          } catch (err) {
            console.error("Error handling DM:", err);
          }
        });
        return NextResponse.json({ ok: true });
      }

      // --- Channel/group thread messages ---
      if (
        (event.channel_type === "channel" || event.channel_type === "group") &&
        event.thread_ts
      ) {
        after(async () => {
          try {
            await handleChannelThread(
              event.user,
              event.channel,
              event.text,
              event.thread_ts!
            );
          } catch (err) {
            console.error("Error handling channel thread:", err);
          }
        });
        return NextResponse.json({ ok: true });
      }

      // --- Top-level channel messages (no thread) ---
      if (
        (event.channel_type === "channel" || event.channel_type === "group") &&
        !event.thread_ts
      ) {
        after(async () => {
          try {
            await handleChannelMessage(
              event.user,
              event.channel,
              event.text,
              event.ts
            );
          } catch (err) {
            console.error("Error handling channel message:", err);
          }
        });
        return NextResponse.json({ ok: true });
      }
    }
  }

  return NextResponse.json({ ok: true });
}

// ─────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────

/**
 * Bot was added to a channel → post welcome and pin it.
 */
async function handleBotJoined(channelId: string) {
  const result = await postMessage(channelId, formatWelcomeMessage());
  if (result?.ts) {
    try {
      await pinMessage(channelId, result.ts);
    } catch (err) {
      console.error("Failed to pin welcome message:", err);
    }
  }
}

/**
 * A human joined a channel → welcome with profile overview if available.
 */
async function handleMemberJoined(userId: string, channelId: string) {
  const profile = await getVoiceProfileByChannel(channelId);

  if (profile) {
    await postMessage(channelId, formatTeamMemberWelcome(profile));
  } else {
    await postMessage(
      channelId,
      "Welcome! Check the pinned message to see how Understood works."
    );
  }
}

/**
 * Handle a DM — onboarding or general help.
 */
async function handleDM(
  userId: string,
  channelId: string,
  text: string
) {
  if (!text) return;

  const result = await handleOnboardingMessage(userId, channelId, text);

  if (result === "done") {
    await finishOnboarding(userId, channelId);
    return;
  }

  if (result === "handled") return;

  // Post-onboarding: check for commands
  const command = parseCommand(text);
  if (command === "help") {
    const { formatHelpMessage } = await import("@/lib/format-slack");
    await postMessage(channelId, formatHelpMessage());
    return;
  }

  // Fallback
  await postMessage(
    channelId,
    "Not sure what you need. You can upload a video to a channel I'm in for ad copy, or say *help* for more info."
  );
}

/**
 * Handle a message in a channel thread.
 * Routes to: onboarding thread, copy feedback thread, or ignore.
 */
async function handleChannelThread(
  userId: string,
  channelId: string,
  text: string,
  threadTs: string
) {
  if (!text) return;

  // Check if it's an onboarding thread
  const inOnboarding = await isOnboardingThread(userId, channelId, threadTs);
  if (inOnboarding) {
    const result = await handleOnboardingMessage(userId, channelId, text, threadTs);
    if (result === "done") {
      await finishOnboarding(userId, channelId, threadTs);
    }
    return;
  }

  // Check if it's a copy generation thread (for feedback)
  const isCopy = await isCopyThread(channelId, threadTs);
  if (isCopy) {
    await handleCopyFeedback(userId, channelId, text, threadTs);
    return;
  }

  // Otherwise ignore thread messages
}

/**
 * Handle a top-level channel message (not in a thread).
 * Routes to: commands, brand context, or helpful fallback.
 */
async function handleChannelMessage(
  userId: string,
  channelId: string,
  text: string,
  messageTs: string
) {
  if (!text) return;

  // Check for commands
  const command = parseCommand(text);
  if (command) {
    if (command === "setup") {
      // Check if we should start onboarding
      const shouldStart = await shouldStartOnboarding(userId, channelId);
      if (shouldStart) {
        await startOnboardingInThread(userId, channelId, messageTs);
      } else {
        await executeCommand(command, userId, channelId, messageTs);
      }
    } else if (command === "new_setup") {
      // Force a fresh setup even if a profile exists
      await startOnboardingInThread(userId, channelId, messageTs);
    } else {
      await executeCommand(command, userId, channelId, messageTs);
    }
    return;
  }

  // Check if the message contains a URL + competitor analysis intent
  const urlInMessage = extractUrl(text);
  if (urlInMessage && text.trim().length > 10) {
    const intent = await classifyUploadIntent(text);
    if (intent === "competitor") {
      // Try to fetch media directly from the URL
      await handleCompetitorLink(userId, channelId, text, urlInMessage, messageTs);
      return;
    }
  }

  // Not a command or competitor link — treat as brand context if substantial
  if (text.trim().length > 10) {
    await addBrandNote(channelId, userId, text);
    await postMessage(
      channelId,
      "Noted — I'll keep this in mind for future copy.",
      messageTs
    );
    return;
  }

  // Too short — helpful fallback
  await postMessage(
    channelId,
    "Not sure what you mean. You can upload a video for ad copy, or send me brand context (pricing, tone, phrases to use or avoid) to improve my output.",
    messageTs
  );
}

/**
 * Finish onboarding — extract voice profile and notify user.
 */
async function finishOnboarding(
  userId: string,
  channelId: string,
  threadTs?: string
) {
  try {
    const { summary } = await extractVoiceProfile(userId, channelId);
    await postMessage(channelId, summary, threadTs);

    // Post the "you're ready" confirmation
    await postMessage(
      channelId,
      "Your brand profile is ready. Upload any video, audio, or image ad to this channel and I'll generate 4 copy variants in your voice.\n\nYou can also send competitor ads with a message about what you like — I'll break them down and create a brief your team can execute in your style.\n\nSend me brand context anytime — pricing changes, new taglines, words to avoid. I learn from every message and get better over time.",
      threadTs
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postMessage(
      channelId,
      `I had trouble analyzing your examples: ${msg}\n\nTry sending me more examples and say "done" again.`,
      threadTs
    );
    // Reset to step 7 so they can try again
    await supabase
      .from("customers")
      .update({ onboarding_step: 7, onboarding_complete: false, active_thread_type: "onboarding" })
      .eq("slack_user_id", userId);
  }
}

/**
 * Handle a competitor ad link — try to fetch media from the URL,
 * fall back to asking user to screenshot/screen-record.
 */
async function handleCompetitorLink(
  userId: string,
  channelId: string,
  text: string,
  url: string,
  messageTs: string
) {
  // Check voice profile first
  const profile = await getVoiceProfileByChannel(channelId);
  if (!profile) {
    await postMessage(
      channelId,
      "I don't have a brand profile for this channel yet. Say *setup* to get started — it takes about 3 minutes.",
      messageTs
    );
    return;
  }

  const statusMsg = await postMessage(channelId, "Fetching that ad...", messageTs);
  const statusTs = statusMsg?.ts;

  try {
    const media = await fetchMediaFromUrl(url);

    if (!media) {
      // Couldn't fetch — fall back to screenshot guidance
      const fallbackMsg = "I couldn't grab the media from that link (the platform may have blocked it). Upload the ad directly instead:\n\n• *Image ad* — screenshot it and drop it here\n• *Video ad* — screen-record it and drop the recording here\n\n_On iPhone: swipe into Control Center → tap the screen record button → play the ad → stop recording → share to Slack._";
      if (statusTs) await updateMessage(channelId, statusTs, fallbackMsg).catch(() => {});
      else await postMessage(channelId, fallbackMsg, messageTs);
      return;
    }

    // We got media — process it through the competitor analysis pipeline
    let contentDescription: string;
    const sourceType = media.type;

    if (media.type === "image") {
      if (statusTs) await updateMessage(channelId, statusTs, "Analyzing the ad creative...").catch(() => {});
      contentDescription = await analyzeAdImage(media.buffer, media.filename);
    } else {
      if (statusTs) await updateMessage(channelId, statusTs, "Transcribing the video...").catch(() => {});
      const transcript = await transcribeVideo(media.buffer, media.filename);
      if (!transcript || transcript.trim().length === 0) {
        // No speech — try to use the page description + any thumbnail analysis as fallback
        if (media.pageDescription) {
          contentDescription = `Video ad (no speech detected). Page description: ${media.pageDescription}`;
        } else {
          const msg = "I got the video but couldn't detect any speech. Try screen-recording it so I can capture the audio better.";
          if (statusTs) await updateMessage(channelId, statusTs, msg).catch(() => {});
          else await postMessage(channelId, msg, messageTs);
          return;
        }
      } else {
        contentDescription = transcript;
      }
    }

    // Add page metadata to enrich the analysis
    if (media.pageTitle || media.pageDescription) {
      contentDescription += `\n\nPage context:\nTitle: ${media.pageTitle || "N/A"}\nDescription: ${media.pageDescription || "N/A"}`;
    }

    // Strip the URL from the user's text to get just their commentary
    const userCommentary = text.replace(/https?:\/\/[^\s>]+/gi, "").trim();

    if (statusTs) await updateMessage(channelId, statusTs, "Analyzing this competitor ad...").catch(() => {});

    const analysis = await analyzeCompetitorAd(
      contentDescription,
      sourceType,
      userCommentary,
      channelId,
      userId,
      messageTs,
      media.filename
    );

    if (statusTs) await updateMessage(channelId, statusTs, "Done — here's your competitive analysis:").catch(() => {});

    const formatted = formatCompetitorAnalysisForSlack(analysis, url);
    await postMessage(channelId, formatted, messageTs);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error handling competitor link:", errMsg);

    const userMsg = friendlyError(error);
    if (statusTs) await updateMessage(channelId, statusTs, userMsg).catch(() => {});
    else await postMessage(channelId, userMsg, messageTs).catch(() => {});
  }
}

/**
 * Handle a reply in a thread where the user was asked what they want to do with their upload.
 */
async function handlePendingUploadReply(
  userId: string,
  channelId: string,
  text: string,
  threadTs: string,
  pendingUpload: Record<string, unknown>
) {
  const lowerText = text.toLowerCase().trim();

  // Determine intent from the reply
  const wantsCopy = /write\s*copy|copy|captions?/i.test(lowerText);
  const wantsAnalysis = /analy[zs]|competitor|break.*down|brief|how.*would|love.*this|style/i.test(lowerText);

  if (!wantsCopy && !wantsAnalysis) {
    // Use AI to classify if the text doesn't match simple patterns
    const intent = await classifyUploadIntent(text);
    if (intent === "competitor") {
      await processPendingAsCompetitor(userId, channelId, text, threadTs, pendingUpload);
    } else {
      await processPendingAsCopy(userId, channelId, text, threadTs, pendingUpload);
    }
    return;
  }

  if (wantsAnalysis) {
    await processPendingAsCompetitor(userId, channelId, text, threadTs, pendingUpload);
  } else {
    await processPendingAsCopy(userId, channelId, text, threadTs, pendingUpload);
  }
}

async function processPendingAsCompetitor(
  userId: string,
  channelId: string,
  userMessage: string,
  threadTs: string,
  pending: Record<string, unknown>
) {
  const statusMsg = await postMessage(channelId, "Analyzing this competitor ad...", threadTs);
  const statusTs = statusMsg?.ts;

  try {
    const filename = pending.video_filename as string;
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const sourceType = IMAGE_EXTENSIONS.includes(ext) ? "image" as const : "video" as const;

    // Delete the pending record — analyzeCompetitorAd will create the real one
    await supabase.from("generations").delete().eq("id", pending.id);

    const analysis = await analyzeCompetitorAd(
      pending.transcript as string,
      sourceType,
      userMessage,
      channelId,
      userId,
      threadTs,
      filename
    );

    if (statusTs) await updateMessage(channelId, statusTs, "Done — here's your competitive analysis:").catch(() => {});

    const formatted = formatCompetitorAnalysisForSlack(analysis, filename);
    await postMessage(channelId, formatted, threadTs);
  } catch (error) {
    console.error("Error processing pending as competitor:", error);
    const msg = friendlyError(error);
    if (statusTs) await updateMessage(channelId, statusTs, msg).catch(() => {});
    else await postMessage(channelId, msg, threadTs);
  }
}

async function processPendingAsCopy(
  userId: string,
  channelId: string,
  userMessage: string,
  threadTs: string,
  pending: Record<string, unknown>
) {
  const statusMsg = await postMessage(channelId, "Writing copy in your brand voice...", threadTs);
  const statusTs = statusMsg?.ts;

  try {
    const filename = pending.video_filename as string;
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const sourceType = IMAGE_EXTENSIONS.includes(ext) ? "image" as const : "video" as const;

    // Delete the pending record — generateCopy will create its own
    await supabase.from("generations").delete().eq("id", pending.id);

    const variants = await generateCopy(
      userId,
      pending.transcript as string,
      filename,
      channelId,
      threadTs,
      sourceType,
      userMessage || undefined
    );

    if (statusTs) await updateMessage(channelId, statusTs, "Done — here's your copy:").catch(() => {});

    const formatted = formatVariantsForSlack(variants, filename);
    await postMessage(channelId, formatted, threadTs);
  } catch (error) {
    console.error("Error processing pending as copy:", error);
    const msg = friendlyError(error);
    if (statusTs) await updateMessage(channelId, statusTs, msg).catch(() => {});
    else await postMessage(channelId, msg, threadTs);
  }
}

/**
 * Handle a file upload — video/audio (transcribe) or image (vision analyze) → generate copy.
 */
async function handleFileShared(
  fileId: string,
  userId: string,
  channelId: string,
  eventTs: string
) {
  let statusTs: string | undefined;
  let messageTs = eventTs;

  try {
    const file = await getFileInfo(fileId);
    if (!file) return;

    // Get the actual message ts from file shares for threading
    const fileShares = (file as Record<string, unknown>).shares as
      | { public?: Record<string, { ts: string }[]>; private?: Record<string, { ts: string }[]> }
      | undefined;
    const shareList = fileShares?.public?.[channelId] || fileShares?.private?.[channelId];
    messageTs = shareList?.[0]?.ts || eventTs;

    // Capture any notes the user typed alongside the upload
    // Fetch the actual message to get its text (file_shared event doesn't include it)
    let userNotes = "";
    try {
      const msg = await getMessage(channelId, messageTs);
      if (msg?.text && msg.text.trim().length > 0) {
        userNotes = msg.text;
      }
    } catch {
      // Couldn't fetch message text — proceed without notes
    }

    const filename = file.name || "unknown";
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    if (!ALL_MEDIA_EXTENSIONS.includes(extension)) return;

    const isImage = IMAGE_EXTENSIONS.includes(extension);

    const sizeMB = (file.size || 0) / (1024 * 1024);
    const maxSize = isImage ? 20 : 500;
    if (sizeMB > maxSize) {
      await postMessage(
        channelId,
        `That file is ${sizeMB.toFixed(0)}MB — too large to process. Try a file under ${maxSize}MB.`,
        messageTs
      );
      return;
    }

    // Check if channel has a voice profile
    const profile = await getVoiceProfileByChannel(channelId);
    if (!profile) {
      await postMessage(
        channelId,
        "I don't have a brand profile for this channel yet. Say *setup* in this channel to get started — it takes about 3 minutes.",
        messageTs
      );
      return;
    }

    // Post initial status message and capture ts for updates
    const statusMsg = await postMessage(
      channelId,
      isImage ? "Analyzing your ad creative..." : "Processing your video...",
      messageTs
    );
    statusTs = statusMsg?.ts;

    // Download
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      if (statusTs) await updateMessage(channelId, statusTs, "Couldn't access that file.").catch(() => {});
      else await postMessage(channelId, "Couldn't access that file.", messageTs);
      return;
    }
    const fileBuffer = await downloadFile(downloadUrl as string);

    let contentDescription: string;
    let sourceType: "video" | "image";

    if (isImage) {
      // Analyze image with Claude Vision
      contentDescription = await analyzeAdImage(fileBuffer, filename);
      sourceType = "image";
    } else {
      // Transcribe video/audio
      if (statusTs) await updateMessage(channelId, statusTs, "Transcribing audio...").catch(() => {});
      const transcript = await transcribeVideo(fileBuffer, filename);
      if (!transcript || transcript.trim().length === 0) {
        if (statusTs) await updateMessage(channelId, statusTs, "I couldn't detect any speech in that video. Try a video with clear audio.").catch(() => {});
        else await postMessage(channelId, "I couldn't detect any speech in that video. Try a video with clear audio.", messageTs);
        return;
      }
      contentDescription = transcript;
      sourceType = "video";
    }

    // Detect intent: is this a competitor ad or the user's own creative?
    const intent = await classifyUploadIntent(userNotes);

    if (intent === "competitor") {
      // ─── Competitor Ad Analysis flow ───
      if (statusTs) await updateMessage(channelId, statusTs, "Analyzing this competitor ad...").catch(() => {});

      const analysis = await analyzeCompetitorAd(
        contentDescription,
        sourceType,
        userNotes,
        channelId,
        userId,
        messageTs,
        filename
      );

      if (statusTs) await updateMessage(channelId, statusTs, "Done — here's your competitive analysis:").catch(() => {});

      const formatted = formatCompetitorAnalysisForSlack(analysis, filename);
      await postMessage(channelId, formatted, messageTs);
    } else {
      // ─── Standard Copy Generation flow (existing behavior) ───
      if (statusTs) await updateMessage(channelId, statusTs, "Writing copy in your brand voice...").catch(() => {});

      const variants = await generateCopy(
        userId,
        contentDescription,
        filename,
        channelId,
        messageTs,
        sourceType,
        userNotes || undefined
      );

      if (statusTs) await updateMessage(channelId, statusTs, "Done — here's your copy:").catch(() => {});

      const formatted = formatVariantsForSlack(variants, filename);
      await postMessage(channelId, formatted, messageTs);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error processing file:", errMsg);

    let userMsg: string;
    if (errMsg === "NO_PROFILE") {
      userMsg = "I don't have a brand profile for this channel yet. Say *setup* to get started.";
    } else {
      userMsg = friendlyError(error);
    }

    // Update the status message if we have one, otherwise post new
    if (statusTs) {
      await updateMessage(channelId, statusTs, userMsg).catch(() => {});
    } else {
      await postMessage(channelId, userMsg, messageTs).catch(() => {});
    }
  }
}
