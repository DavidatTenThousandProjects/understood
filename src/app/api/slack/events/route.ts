import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { postMessage, getFileInfo, downloadFile, pinMessage } from "@/lib/slack";
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
import {
  formatVariantsForSlack,
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
    } else {
      await executeCommand(command, userId, channelId, messageTs);
    }
    return;
  }

  // Not a command — treat as brand context if substantial
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
      "Your brand profile is ready. Upload any video or audio ad to this channel and I'll generate 4 copy variants in your voice.\n\nYou can also send me context anytime — pricing changes, new taglines, words to avoid. I learn from every message and get better over time.",
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
 * Handle a file upload — video/audio (transcribe) or image (vision analyze) → generate copy.
 */
async function handleFileShared(
  fileId: string,
  userId: string,
  channelId: string,
  eventTs: string
) {
  try {
    const file = await getFileInfo(fileId);
    if (!file) return;

    // Get the actual message ts from file shares for threading
    const fileShares = (file as Record<string, unknown>).shares as
      | { public?: Record<string, { ts: string }[]>; private?: Record<string, { ts: string }[]> }
      | undefined;
    const shareList = fileShares?.public?.[channelId] || fileShares?.private?.[channelId];
    const messageTs = shareList?.[0]?.ts || eventTs;

    // Capture any notes the user typed alongside the upload
    const initialComment = (file as Record<string, unknown>).initial_comment as
      | { comment?: string }
      | undefined;
    const userNotes = initialComment?.comment || "";

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

    await postMessage(
      channelId,
      isImage ? "Analyzing your ad creative..." : "Processing your video...",
      messageTs
    );

    // Download
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      await postMessage(channelId, "Couldn't access that file.", messageTs);
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
      const transcript = await transcribeVideo(fileBuffer, filename);
      if (!transcript || transcript.trim().length === 0) {
        await postMessage(
          channelId,
          "I couldn't detect any speech in that video. Try a video with clear audio.",
          messageTs
        );
        return;
      }
      contentDescription = transcript;
      sourceType = "video";
    }

    // Generate copy
    const variants = await generateCopy(
      userId,
      contentDescription,
      filename,
      channelId,
      messageTs,
      sourceType,
      userNotes || undefined
    );

    // Post formatted variants with feedback instructions
    const formatted = formatVariantsForSlack(variants, filename);
    await postMessage(channelId, formatted, messageTs);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error processing file:", errMsg);

    if (errMsg === "NO_PROFILE") {
      await postMessage(
        channelId,
        "I don't have a brand profile for this channel yet. Say *setup* to get started.",
        eventTs
      ).catch(() => {});
    } else {
      await postMessage(channelId, `Error: ${errMsg}`, eventTs).catch(() => {});
    }
  }
}
