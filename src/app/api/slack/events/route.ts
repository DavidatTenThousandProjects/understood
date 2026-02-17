import { NextRequest, NextResponse, after } from "next/server";
import { verifySlackRequest } from "@/lib/verify-slack";
import { postMessage, getFileInfo, downloadFile } from "@/lib/slack";
import { transcribeVideo } from "@/lib/openai";
import {
  handleOnboardingMessage,
  startOnboarding,
  getOrCreateCustomer,
} from "@/lib/onboarding";
import { extractVoiceProfile, getVoiceProfile } from "@/lib/voice-profile";
import { generateCopy } from "@/lib/generate-copy";
import { formatVariantsForSlack } from "@/lib/format-slack";
import type { SlackUrlVerification, SlackEventCallback } from "@/lib/types";

export const dynamic = "force-dynamic";

const MEDIA_EXTENSIONS = [
  "mp4", "mp3", "m4a", "wav", "webm", "mov", "ogg", "flac",
];

// Track processed events to prevent duplicate handling
const processedEvents = new Set<string>();

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

    if (processedEvents.has(event_id)) {
      return NextResponse.json({ ok: true });
    }
    processedEvents.add(event_id);
    if (processedEvents.size > 1000) {
      const entries = Array.from(processedEvents);
      entries.slice(0, 500).forEach((id) => processedEvents.delete(id));
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
          await handleDM(event.user, event.channel, event.text, event.ts);
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
  text: string,
  ts: string
) {
  // Ignore bot messages
  if (!text) return;

  const customer = await getOrCreateCustomer(userId);

  // If user hasn't started onboarding yet (step 0, no business name)
  if (!customer.business_name && (customer.onboarding_step || 0) === 0) {
    await startOnboarding(userId, channelId);
    // Then immediately handle their message as the first answer
    await handleOnboardingMessage(userId, channelId, text);
    return;
  }

  // Handle onboarding flow
  const handled = await handleOnboardingMessage(userId, channelId, text);

  // If onboarding just completed (user said "done"), extract voice profile
  if (handled) {
    const updatedCustomer = await getOrCreateCustomer(userId);
    if (updatedCustomer.onboarding_complete && updatedCustomer.onboarding_step === 8) {
      try {
        const { summary } = await extractVoiceProfile(userId);
        await postMessage(channelId, summary);

        // Advance step past 8 so we don't re-extract
        const { supabase } = await import("@/lib/supabase");
        await supabase
          .from("customers")
          .update({ onboarding_step: 9 })
          .eq("slack_user_id", userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await postMessage(
          channelId,
          `I had trouble analyzing your examples: ${msg}\n\nTry sending me more examples and say "done" again.`
        );
      }
    }
    return;
  }

  // Onboarding is complete — handle general messages
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
