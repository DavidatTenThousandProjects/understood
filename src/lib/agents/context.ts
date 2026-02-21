/**
 * Shared Brand Context Assembly.
 *
 * One function that assembles everything an agent needs to know about a channel.
 * Replaces duplicate Supabase queries scattered across generate-copy, copy-feedback,
 * and route.ts.
 */

import { supabase } from "../supabase";
import { getBrandNotes } from "../context";
import { getThreadReplies } from "../slack";
import type { VoiceProfile } from "../types";
import type { BrandContext, GenerationRecord, ExemplarRecord } from "./types";

/**
 * Assemble full brand context for a channel, optionally scoped to a thread.
 */
export async function getBrandContext(
  channelId: string,
  teamId: string,
  botUserId: string,
  threadTs?: string
): Promise<BrandContext> {
  // Run independent queries in parallel
  const [profile, brandNotes, generation, learnings, exemplars] = await Promise.all([
    fetchVoiceProfile(channelId),
    getBrandNotes(channelId),
    threadTs ? fetchGeneration(channelId, threadTs) : Promise.resolve(null),
    fetchLearnings(channelId),
    fetchExemplars(channelId),
  ]);

  // Thread history only if we're in a thread
  const threadHistory = threadTs
    ? await fetchThreadHistory(channelId, threadTs, teamId, botUserId)
    : null;

  // Determine channel maturity
  const channelMaturity = await determineMaturity(channelId, profile);

  return {
    profile,
    brandNotes,
    threadHistory,
    generation,
    learnings,
    exemplars,
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

async function fetchExemplars(channelId: string): Promise<ExemplarRecord[] | null> {
  try {
    const { data } = await supabase
      .from("exemplars")
      .select("*")
      .eq("channel_id", channelId)
      .eq("active", true)
      .order("score", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);

    if (!data || data.length === 0) return null;

    return data.map((e) => ({
      id: e.id,
      teamId: e.team_id,
      channelId: e.channel_id,
      generationId: e.generation_id,
      voiceProfileId: e.voice_profile_id,
      variant: e.variant,
      sourceType: e.source_type,
      approvalReason: e.approval_reason,
      sourceTranscriptSnippet: e.source_transcript_snippet,
      score: e.score,
      active: e.active,
      createdAt: e.created_at,
    }));
  } catch {
    // Table may not exist yet
    return null;
  }
}

async function fetchThreadHistory(
  channelId: string,
  threadTs: string,
  teamId: string,
  botUserId: string
): Promise<string | null> {
  try {
    const messages = await getThreadReplies(teamId, channelId, threadTs);

    const formattedMessages = messages
      .filter((m) => {
        const msg = m as { ts?: string };
        // Skip the parent message itself
        return msg.ts !== threadTs;
      })
      .map((m) => {
        const msg = m as { user?: string; bot_id?: string; text?: string };
        const isBot = msg.user === botUserId || !!msg.bot_id;
        const prefix = isBot ? "[Bot]" : "[User]";
        return `${prefix} ${msg.text || ""}`;
      })
      .filter((t) => t.length > 6); // filter out "[Bot] " or "[User] " with no content

    if (formattedMessages.length === 0) return null;

    return formattedMessages.join("\n");
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
