/**
 * Shared Brand Context Assembly.
 *
 * One function that assembles everything an agent needs to know about a channel.
 * Replaces duplicate Supabase queries scattered across generate-copy, copy-feedback,
 * analyze-competitor, and route.ts.
 */

import { supabase } from "../supabase";
import { getBrandNotes } from "../context";
import { getThreadReplies } from "../slack";
import type { VoiceProfile } from "../types";
import type { BrandContext, GenerationRecord } from "./types";

const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";

/**
 * Assemble full brand context for a channel, optionally scoped to a thread.
 */
export async function getBrandContext(
  channelId: string,
  threadTs?: string
): Promise<BrandContext> {
  // Run independent queries in parallel
  const [profile, brandNotes, generation, learnings] = await Promise.all([
    fetchVoiceProfile(channelId),
    getBrandNotes(channelId),
    threadTs ? fetchGeneration(channelId, threadTs) : Promise.resolve(null),
    fetchLearnings(channelId),
  ]);

  // Thread history only if we're in a thread
  const threadHistory = threadTs
    ? await fetchThreadHistory(channelId, threadTs)
    : null;

  // Determine channel maturity
  const channelMaturity = await determineMaturity(channelId, profile);

  return {
    profile,
    brandNotes,
    threadHistory,
    generation,
    learnings,
    channelMaturity,
  };
}

// ─── Internal helpers ───

async function fetchVoiceProfile(channelId: string): Promise<VoiceProfile | null> {
  const { data } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data as VoiceProfile | null;
}

async function fetchGeneration(
  channelId: string,
  threadTs: string
): Promise<GenerationRecord | null> {
  const { data } = await supabase
    .from("generations")
    .select("*")
    .eq("slack_channel_id", channelId)
    .eq("slack_message_ts", threadTs)
    .limit(1)
    .single();

  if (!data) return null;

  return {
    id: data.id,
    slackUserId: data.slack_user_id,
    voiceProfileId: data.voice_profile_id,
    videoFilename: data.video_filename,
    transcript: data.transcript,
    variants: data.variants,
    slackChannelId: data.slack_channel_id,
    slackMessageTs: data.slack_message_ts,
    sourceType: data.source_type,
    createdAt: data.created_at,
  };
}

async function fetchLearnings(channelId: string): Promise<string | null> {
  const { data } = await supabase
    .from("learnings")
    .select("category, insight, confidence, sample_size")
    .eq("channel_id", channelId)
    .eq("active", true)
    .order("confidence", { ascending: false });

  // Table may not exist yet — graceful fallback
  if (!data || data.length === 0) return null;

  return data
    .map(
      (l) =>
        `[${l.category}] (confidence: ${l.confidence}, samples: ${l.sample_size}) ${l.insight}`
    )
    .join("\n");
}

async function fetchThreadHistory(
  channelId: string,
  threadTs: string
): Promise<string | null> {
  try {
    const messages = await getThreadReplies(channelId, threadTs);

    const humanMessages = messages
      .filter((m) => {
        const msg = m as { user?: string; bot_id?: string; ts?: string };
        return msg.user !== BOT_USER_ID && !msg.bot_id && msg.ts !== threadTs;
      })
      .map((m) => {
        const msg = m as { text?: string };
        return msg.text || "";
      })
      .filter((t) => t.length > 0);

    if (humanMessages.length === 0) return null;

    return humanMessages
      .map((f, i) => `Message ${i + 1}: ${f}`)
      .join("\n");
  } catch {
    return null;
  }
}

async function determineMaturity(
  channelId: string,
  profile: VoiceProfile | null
): Promise<"new" | "onboarding" | "active"> {
  if (!profile) return "new";

  const { count } = await supabase
    .from("generations")
    .select("id", { count: "exact", head: true })
    .eq("slack_channel_id", channelId);

  if ((count || 0) < 3) return "onboarding";
  return "active";
}
