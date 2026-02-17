import { supabase } from "./supabase";
import { sanitize } from "./sanitize";

/**
 * Add a brand note for a channel. Any team member can contribute.
 */
export async function addBrandNote(
  channelId: string,
  slackUserId: string,
  text: string
): Promise<void> {
  await supabase.from("brand_notes").insert({
    channel_id: channelId,
    slack_user_id: slackUserId,
    note: sanitize(text),
  });
}

/**
 * Get all brand notes for a channel, formatted for inclusion in prompts.
 * Returns empty string if no notes exist.
 */
export async function getBrandNotes(channelId: string): Promise<string> {
  const { data } = await supabase
    .from("brand_notes")
    .select("note, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) return "";

  return data
    .map((n) => {
      const date = new Date(n.created_at).toISOString().split("T")[0];
      return `[${date}] ${n.note}`;
    })
    .join("\n");
}

/**
 * Get brand notes count for a channel.
 */
export async function getBrandNotesCount(channelId: string): Promise<number> {
  const { count } = await supabase
    .from("brand_notes")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId);

  return count || 0;
}
