import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { postMessage, getFileInfo, downloadFile } from "@/lib/slack";
import { transcribeVideo } from "@/lib/openai";
import { handleOnboardingMessage } from "@/lib/onboarding";
import { supabase } from "@/lib/supabase";
import { extractVoiceProfile, getVoiceProfile } from "@/lib/voice-profile";
import { generateCopy } from "@/lib/generate-copy";
import { formatVariantsForSlack } from "@/lib/format-slack";
import type { SlackUrlVerification, SlackEventCallback } from "@/lib/types";

export const dynamic = "force-dynamic";

const MEDIA_EXTENSIONS = [
  "mp4", "mp3", "m4a", "wav", "webm", "mov", "ogg", "flac",
];

/**
 * Deduplicate events using Supabase.
 * Serverless functions can't use in-memory Sets because each invocation may be a different instance.
 */
async function isDuplicate(eventId: string): Promise<boolean> {
  const { error } = await supabase
    .from("processed_events")
    .insert({ event_id: eventId });

  // If insert fails with unique violation, it's a duplicate
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

    // Deduplicate using Supabase (persists across serverless invocations)
    if (await isDuplicate(event_id)) {
      return NextResponse.json({ ok: true });
    }

    // Handle file_shared event (video upload → transcribe → generate copy)
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

    // Handle DM messages (onboarding flow)
    if (event.type === "message" && !event.subtype && event.channel_type === "im") {
      after(async () => {
        try {
          await handleDM(event.user, event.channel, event.text);
        } catch (err) {
          console.error("Error handling DM:", err);
        }
      });
      return NextResponse.json({ ok: true });
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * Handle a DM from a user — either onboarding or general help.
 */
async function handleDM(
  userId: string,
  channelId: string,
  text: string
) {
  if (!text) return;

  const result = await handleOnboardingMessage(userId, channelId, text);

  if (result === "done") {
    // User said "done" — extract voice profile
    try {
      const { summary } = await extractVoiceProfile(userId);
      await postMessage(channelId, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await postMessage(
        channelId,
        `I had trouble analyzing your examples: ${msg}\n\nTry sending me more examples and say "done" again.`
      );
      // Reset to step 8 so they can try again
      await supabase
        .from("customers")
        .update({ onboarding_step: 8, onboarding_complete: false })
        .eq("slack_user_id", userId);
    }
    return;
  }

  if (result === "handled") return;

  // Onboarding complete — handle general messages
  if (text.toLowerCase().includes("help")) {
    await postMessage(
      channelId,
      "*How to use Understood:*\n\n1. Upload a video ad to any channel I'm in\n2. I'll transcribe it and generate 4 ad copy variants in your voice\n\nThat's it!"
    );
  } else {
    await postMessage(
      channelId,
      "Upload a video to any channel I'm in, and I'll generate ad copy for it. Say \"help\" for more info."
    );
  }
}

/**
 * Handle a file upload — transcribe and generate copy.
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

    const filename = file.name || "unknown";
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    if (!MEDIA_EXTENSIONS.includes(extension)) return;

    const sizeMB = (file.size || 0) / (1024 * 1024);
    if (sizeMB > 500) {
      await postMessage(
        channelId,
        `That file is ${sizeMB.toFixed(0)}MB — too large to process. Try a file under 500MB.`,
        eventTs
      );
      return;
    }

    // Check if user has a voice profile
    const profile = await getVoiceProfile(userId);
    if (!profile) {
      await postMessage(
        channelId,
        "You need to set up your voice profile first. *Send me a DM* to get started!",
        eventTs
      );
      return;
    }

    await postMessage(channelId, "Processing your video...", eventTs);

    // Download
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      await postMessage(channelId, "Couldn't access that file.", eventTs);
      return;
    }
    const fileBuffer = await downloadFile(downloadUrl as string);

    // Transcribe
    const transcript = await transcribeVideo(fileBuffer, filename);
    if (!transcript || transcript.trim().length === 0) {
      await postMessage(
        channelId,
        "I couldn't detect any speech in that video. Try a video with clear audio.",
        eventTs
      );
      return;
    }

    // Generate copy
    const variants = await generateCopy(
      userId,
      transcript,
      filename,
      channelId,
      eventTs
    );

    // Post formatted variants
    const formatted = formatVariantsForSlack(variants, filename);
    await postMessage(channelId, formatted, eventTs);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error processing file:", errMsg);

    if (errMsg === "NO_PROFILE") {
      await postMessage(
        channelId,
        "You need to set up your voice profile first. *Send me a DM* to get started!",
        eventTs
      ).catch(() => {});
    } else {
      await postMessage(channelId, `Error: ${errMsg}`, eventTs).catch(() => {});
    }
  }
}
