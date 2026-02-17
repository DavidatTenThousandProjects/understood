import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { postMessage, getFileInfo, downloadFile } from "@/lib/slack";
import { transcribeVideo } from "@/lib/openai";
import type { SlackUrlVerification, SlackEventCallback } from "@/lib/types";

// Force dynamic — this is an API route, not static
export const dynamic = "force-dynamic";

// Supported video/audio file extensions
const MEDIA_EXTENSIONS = [
  "mp4",
  "mp3",
  "m4a",
  "wav",
  "webm",
  "mov",
  "ogg",
  "flac",
];

// Track processed events to prevent duplicate handling (Slack retries)
const processedEvents = new Set<string>();

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  // Verify the request is from Slack
  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as
    | SlackUrlVerification
    | SlackEventCallback;

  // Handle Slack's URL verification challenge (required during app setup)
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle event callbacks
  if (body.type === "event_callback") {
    const { event, event_id } = body;

    // Deduplicate: Slack retries events if we don't respond in 3 seconds
    if (processedEvents.has(event_id)) {
      return NextResponse.json({ ok: true });
    }
    processedEvents.add(event_id);

    // Clean up old events (keep set from growing forever)
    if (processedEvents.size > 1000) {
      const entries = Array.from(processedEvents);
      entries.slice(0, 500).forEach((id) => processedEvents.delete(id));
    }

    // Handle file_shared event
    if (event.type === "file_shared") {
      // Use after() to keep the function alive after responding to Slack
      after(async () => {
        try {
          await handleFileShared(
            event.file_id,
            event.channel_id,
            event.event_ts
          );
        } catch (err) {
          console.error("Error handling file_shared:", err);
        }
      });

      return NextResponse.json({ ok: true });
    }

    // Handle DM messages (Phase 2: onboarding flow)
    if (event.type === "message" && !event.subtype) {
      // Phase 2 will handle DM onboarding here
      return NextResponse.json({ ok: true });
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * Handle a file_shared event:
 * 1. Get file info from Slack
 * 2. Check if it's a video/audio file
 * 3. Download it
 * 4. Transcribe with Whisper
 * 5. Post transcript as a thread reply
 */
async function handleFileShared(
  fileId: string,
  channelId: string,
  eventTs: string
) {
  try {
    // 1. Get file info
    const file = await getFileInfo(fileId);
    if (!file) {
      console.error("Could not get file info for:", fileId);
      return;
    }

    const filename = file.name || "unknown";
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    // 2. Check if it's a supported media file
    if (!MEDIA_EXTENSIONS.includes(extension)) {
      // Not a media file — ignore silently
      return;
    }

    // 3. Check file size (Slack free plan limit is ~1GB, but be reasonable)
    const sizeMB = (file.size || 0) / (1024 * 1024);
    if (sizeMB > 500) {
      await postMessage(
        channelId,
        `That file is ${sizeMB.toFixed(0)}MB — too large to process. Try a file under 500MB.`,
        eventTs
      );
      return;
    }

    // Let the user know we're working on it
    await postMessage(channelId, "Processing your video...", eventTs);

    // 4. Download the file
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      await postMessage(
        channelId,
        "Sorry, I couldn't access that file. Make sure I have the right permissions.",
        eventTs
      );
      return;
    }
    const fileBuffer = await downloadFile(downloadUrl as string);

    // 5. Transcribe
    const transcript = await transcribeVideo(fileBuffer, filename);

    if (!transcript || transcript.trim().length === 0) {
      await postMessage(
        channelId,
        "I couldn't detect any speech in that video. Try a video with clear audio.",
        eventTs
      );
      return;
    }

    // 6. Post transcript as thread reply
    await postMessage(
      channelId,
      `*Transcript for ${filename}:*\n\n${transcript}`,
      eventTs
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error processing file:", errMsg);
    await postMessage(
      channelId,
      `Error: ${errMsg}`,
      eventTs
    ).catch(() => {});
  }
}
