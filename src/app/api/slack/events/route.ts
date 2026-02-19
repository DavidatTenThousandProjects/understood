import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { supabase } from "@/lib/supabase";
import {
  getSlackClient,
  postMessage,
  updateMessage,
  getFileInfo,
  downloadFile,
  getMessage,
  pinMessage,
} from "@/lib/slack";
import { transcribeVideo } from "@/lib/openai";
import { analyzeAdImage } from "@/lib/analyze-image";
import { friendlyError } from "@/lib/anthropic";
import { extractUrl, fetchMediaFromUrl } from "@/lib/fetch-url-media";
import {
  normalizeEvent,
  buildFileContext,
  isSupportedMedia,
  routeEvent,
  dispatch,
  registerAgent,
  classifyFileUploadIntent,
  // Agents
  commandAgent,
  welcomeAgent,
  brandContextAgent,
  copyGenerationAgent,
  competitorAnalysisAgent,
  conversationAgent,
  onboardingAgent,
  startOnboardingInThread,
  learningAgent,
} from "@/lib/agents";
import type { SlackUrlVerification, SlackEventCallback } from "@/lib/types";

export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];

// ─── Register all agents ───

registerAgent("command", commandAgent);
registerAgent("welcome", welcomeAgent);
registerAgent("brand_context", brandContextAgent);
registerAgent("copy_generation", copyGenerationAgent);
registerAgent("competitor_analysis", competitorAnalysisAgent);
registerAgent("conversation", conversationAgent);
registerAgent("onboarding", onboardingAgent);
registerAgent("learning", learningAgent);

// ─── Deduplication ───

async function isDuplicate(eventId: string, teamId?: string): Promise<boolean> {
  const { error } = await supabase
    .from("processed_events")
    .insert({ event_id: eventId, ...(teamId ? { team_id: teamId } : {}) });

  if (error?.code === "23505") return true;
  if (error) console.error("Dedup check error:", error.message);
  return false;
}

// ─── Main handler ───

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as SlackUrlVerification | SlackEventCallback;

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback") {
    const { event, event_id, team_id } = body;

    if (await isDuplicate(event_id, team_id)) {
      return NextResponse.json({ ok: true });
    }

    // Look up workspace to get botUserId
    const { botUserId } = await getSlackClient(team_id);

    after(async () => {
      try {
        await processEvent(event, event_id, team_id, botUserId);
      } catch (err) {
        console.error("Event processing error:", err);
      }
    });
  }

  return NextResponse.json({ ok: true });
}

// ─── Event processing pipeline ───

async function processEvent(
  event: unknown,
  eventId: string,
  teamId: string,
  botUserId: string
): Promise<void> {
  // 1. Normalize
  const ctx = normalizeEvent(event as import("@/lib/types").SlackEvent, teamId, botUserId);
  if (!ctx) return;

  // 2. Handle file uploads with enrichment (special path — needs file download + transcription)
  if (ctx.type === "file_upload") {
    const rawEvent = ctx.rawEvent as { file_id: string; user_id: string; channel_id: string; event_ts: string };
    await handleFileUpload(teamId, botUserId, rawEvent.file_id, ctx.userId, ctx.channelId, rawEvent.event_ts);
    return;
  }

  // 3. Handle competitor links (special path — needs URL fetching)
  if (ctx.type === "message" && !ctx.isThread && !ctx.isDM) {
    const url = extractUrl(ctx.text);
    if (url && ctx.text.trim().length > 10) {
      const competitorSignals = /love\s*(this|the|that)|inspired|competitor|saw\s*this|how\s*would|break.*down|analy[zs]|style|this\s*ad/i;
      if (competitorSignals.test(ctx.text)) {
        await handleCompetitorLink(teamId, botUserId, ctx.userId, ctx.channelId, ctx.text, url, ctx.parentTs || "");
        return;
      }
    }
  }

  // 4. Handle setup/new_setup commands (need to start onboarding thread)
  if (ctx.type === "message" && !ctx.isThread && !ctx.isDM) {
    const lower = ctx.text.toLowerCase().trim();
    if (lower === "setup" || lower === "new setup") {
      await handleSetupCommand(teamId, botUserId, ctx.userId, ctx.channelId, ctx.parentTs || "", lower === "new setup");
      return;
    }
  }

  // 5. Standard pipeline: Route → Dispatch
  const route = await routeEvent(ctx);
  if (!route) return;

  // Handle welcome with pinning
  if (route.agent === "welcome" && route.meta?.isBotJoin) {
    const result = await welcomeAgent(ctx, { profile: null, brandNotes: "", threadHistory: null, generation: null, learnings: null, channelMaturity: "new" });
    for (const msg of result.messages) {
      const posted = await postMessage(teamId, msg.channel, msg.text, msg.threadTs);
      if (posted?.ts) {
        try { await pinMessage(teamId, msg.channel, posted.ts); } catch {}
      }
    }
    return;
  }

  await dispatch(ctx, route);
}

// ─── File upload handler (needs enrichment before routing) ───

async function handleFileUpload(
  teamId: string,
  botUserId: string,
  fileId: string,
  userId: string,
  channelId: string,
  eventTs: string
): Promise<void> {
  let statusTs: string | undefined;
  let messageTs = eventTs;

  try {
    const file = await getFileInfo(teamId, fileId);
    if (!file) return;

    // Get actual message ts from file shares
    const fileShares = (file as Record<string, unknown>).shares as
      | { public?: Record<string, { ts: string }[]>; private?: Record<string, { ts: string }[]> }
      | undefined;
    const shareList = fileShares?.public?.[channelId] || fileShares?.private?.[channelId];
    messageTs = shareList?.[0]?.ts || eventTs;

    // Get user notes from the message
    let userNotes = "";
    try {
      const msg = await getMessage(teamId, channelId, messageTs);
      if (msg?.text && msg.text.trim().length > 0) {
        userNotes = msg.text;
      }
    } catch {}

    const filename = file.name || "unknown";
    if (!isSupportedMedia(filename)) return;

    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const isImage = IMAGE_EXTENSIONS.includes(ext);

    const sizeMB = (file.size || 0) / (1024 * 1024);
    const maxSize = isImage ? 20 : 500;
    if (sizeMB > maxSize) {
      await postMessage(teamId, channelId, `That file is ${sizeMB.toFixed(0)}MB — too large to process. Try a file under ${maxSize}MB.`, messageTs);
      return;
    }

    // Check voice profile
    const { data: profile } = await supabase
      .from("voice_profiles")
      .select("id")
      .eq("channel_id", channelId)
      .limit(1)
      .single();

    if (!profile) {
      await postMessage(teamId, channelId, "I don't have a brand profile for this channel yet. Say *setup* in this channel to get started — it takes about 3 minutes.", messageTs);
      return;
    }

    // Post status
    const statusMsg = await postMessage(teamId, channelId, isImage ? "Analyzing your ad creative..." : "Processing your video...", messageTs);
    statusTs = statusMsg?.ts;

    // Download file
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Couldn't access that file.").catch(() => {});
      return;
    }
    const fileBuffer = await downloadFile(teamId, downloadUrl as string);

    // Analyze/Transcribe
    let contentDescription: string;
    let sourceType: "video" | "image";

    if (isImage) {
      contentDescription = await analyzeAdImage(fileBuffer, filename);
      sourceType = "image";
    } else {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Transcribing audio...").catch(() => {});
      const transcript = await transcribeVideo(fileBuffer, filename);
      if (!transcript || transcript.trim().length === 0) {
        if (statusTs) await updateMessage(teamId, channelId, statusTs, "I couldn't detect any speech in that video. Try a video with clear audio.").catch(() => {});
        return;
      }
      contentDescription = transcript;
      sourceType = "video";
    }

    // Classify intent
    const intent = await classifyFileUploadIntent(userNotes);

    if (intent === "competitor") {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Analyzing this competitor ad...").catch(() => {});

      const ctx = {
        type: "file_upload" as const,
        teamId,
        botUserId,
        userId,
        channelId,
        text: userNotes,
        threadTs: null,
        parentTs: messageTs,
        fileInfo: buildFileContext(file as Record<string, unknown>),
        isThread: false,
        isDM: false,
        rawEvent: {},
      };

      await dispatch(ctx, {
        agent: "competitor_analysis",
        meta: { transcript: contentDescription, sourceType, userNotes, filename, messageTs },
      });
    } else {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Writing copy in your brand voice...").catch(() => {});

      const ctx = {
        type: "file_upload" as const,
        teamId,
        botUserId,
        userId,
        channelId,
        text: userNotes,
        threadTs: null,
        parentTs: messageTs,
        fileInfo: buildFileContext(file as Record<string, unknown>),
        isThread: false,
        isDM: false,
        rawEvent: {},
      };

      await dispatch(ctx, {
        agent: "copy_generation",
        meta: { transcript: contentDescription, sourceType, userNotes, filename, messageTs },
      });
    }

    if (statusTs) await updateMessage(teamId, channelId, statusTs, "Done!").catch(() => {});
  } catch (error) {
    console.error("Error processing file:", error);
    const userMsg = friendlyError(error);
    if (statusTs) await updateMessage(teamId, channelId, statusTs, userMsg).catch(() => {});
    else await postMessage(teamId, channelId, userMsg, messageTs).catch(() => {});
  }
}

// ─── Competitor link handler (needs URL fetching) ───

async function handleCompetitorLink(
  teamId: string,
  botUserId: string,
  userId: string,
  channelId: string,
  text: string,
  url: string,
  messageTs: string
): Promise<void> {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("id")
    .eq("channel_id", channelId)
    .limit(1)
    .single();

  if (!profile) {
    await postMessage(teamId, channelId, "I don't have a brand profile for this channel yet. Say *setup* to get started — it takes about 3 minutes.", messageTs);
    return;
  }

  const statusMsg = await postMessage(teamId, channelId, "Fetching that ad...", messageTs);
  const statusTs = statusMsg?.ts;

  try {
    const media = await fetchMediaFromUrl(url);

    if (!media) {
      const fallbackMsg = "I couldn't grab the media from that link (the platform may have blocked it). Upload the ad directly instead:\n\n• *Image ad* — screenshot it and drop it here\n• *Video ad* — screen-record it and drop the recording here\n\n_On iPhone: swipe into Control Center → tap the screen record button → play the ad → stop recording → share to Slack._";
      if (statusTs) await updateMessage(teamId, channelId, statusTs, fallbackMsg).catch(() => {});
      else await postMessage(teamId, channelId, fallbackMsg, messageTs);
      return;
    }

    let contentDescription: string;
    const sourceType = media.type;

    if (media.type === "image") {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Analyzing the ad creative...").catch(() => {});
      contentDescription = await analyzeAdImage(media.buffer, media.filename);
    } else {
      if (statusTs) await updateMessage(teamId, channelId, statusTs, "Transcribing the video...").catch(() => {});
      const transcript = await transcribeVideo(media.buffer, media.filename);
      if (!transcript || transcript.trim().length === 0) {
        if (media.pageDescription) {
          contentDescription = `Video ad (no speech detected). Page description: ${media.pageDescription}`;
        } else {
          const msg = "I got the video but couldn't detect any speech. Try screen-recording it so I can capture the audio better.";
          if (statusTs) await updateMessage(teamId, channelId, statusTs, msg).catch(() => {});
          return;
        }
      } else {
        contentDescription = transcript;
      }
    }

    if (media.pageTitle || media.pageDescription) {
      contentDescription += `\n\nPage context:\nTitle: ${media.pageTitle || "N/A"}\nDescription: ${media.pageDescription || "N/A"}`;
    }

    const userCommentary = text.replace(/https?:\/\/[^\s>]+/gi, "").trim();

    if (statusTs) await updateMessage(teamId, channelId, statusTs, "Analyzing this competitor ad...").catch(() => {});

    const ctx = {
      type: "message" as const,
      teamId,
      botUserId,
      userId,
      channelId,
      text: userCommentary,
      threadTs: null,
      parentTs: messageTs,
      fileInfo: null,
      isThread: false,
      isDM: false,
      rawEvent: {},
    };

    await dispatch(ctx, {
      agent: "competitor_analysis",
      meta: { transcript: contentDescription, sourceType, userNotes: userCommentary, filename: url, messageTs },
    });

    if (statusTs) await updateMessage(teamId, channelId, statusTs, "Done — here's your competitive analysis:").catch(() => {});
  } catch (error) {
    console.error("Error handling competitor link:", error);
    const errMsg = friendlyError(error);
    if (statusTs) await updateMessage(teamId, channelId, statusTs, errMsg).catch(() => {});
    else await postMessage(teamId, channelId, errMsg, messageTs).catch(() => {});
  }
}

// ─── Setup command handler ───

async function handleSetupCommand(
  teamId: string,
  botUserId: string,
  userId: string,
  channelId: string,
  messageTs: string,
  isNewSetup: boolean
): Promise<void> {
  if (!isNewSetup) {
    // Check if profile exists
    const { data: profile } = await supabase
      .from("voice_profiles")
      .select("id")
      .eq("channel_id", channelId)
      .limit(1)
      .single();

    if (profile) {
      // Profile exists — dispatch to command agent which shows the "already set up" message
      const ctx = {
        type: "message" as const,
        teamId,
        botUserId,
        userId,
        channelId,
        text: "setup",
        threadTs: null,
        parentTs: messageTs,
        fileInfo: null,
        isThread: false,
        isDM: false,
        rawEvent: {},
      };
      await dispatch(ctx, { agent: "command", meta: { command: "setup" } });
      return;
    }
  }

  // Start onboarding
  const ctx = {
    type: "message" as const,
    teamId,
    botUserId,
    userId,
    channelId,
    text: isNewSetup ? "new setup" : "setup",
    threadTs: null,
    parentTs: messageTs,
    fileInfo: null,
    isThread: false,
    isDM: false,
    rawEvent: {},
  };

  const result = await startOnboardingInThread(ctx);
  for (const msg of result.messages) {
    await postMessage(teamId, msg.channel, msg.text, msg.threadTs);
  }
}
