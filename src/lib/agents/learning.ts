/**
 * Learning Agent — NEW.
 *
 * Background agent that analyzes feedback patterns and evolves the voice profile.
 * Does NOT respond to user messages — runs after generations receive feedback.
 *
 * Triggers:
 * - After conversation agent handles feedback (triggerLearning flag)
 * - After every Nth generation for periodic review
 *
 * Output: Structured insights stored in the `learnings` table.
 */

import { anthropic } from "../anthropic";
import { supabase } from "../supabase";
import { sanitize } from "../sanitize";
import type { EventContext, BrandContext, AgentResult } from "./types";

/**
 * Learning agent handler.
 * Runs in background — returns empty messages (doesn't post to Slack).
 */
export async function learningAgent(
  ctx: EventContext,
  brand: BrandContext
): Promise<AgentResult> {
  try {
    await analyzeFeedbackPatterns(ctx.channelId);
  } catch (err) {
    console.error("Learning agent error:", err);
  }

  // Learning agent doesn't post messages
  return { messages: [] };
}

/**
 * Analyze all feedback patterns for a channel and produce structured learnings.
 */
async function analyzeFeedbackPatterns(channelId: string): Promise<void> {
  // Fetch recent generations with their feedback (via brand_notes)
  const { data: generations } = await supabase
    .from("generations")
    .select("id, source_type, variants, video_filename, created_at")
    .eq("slack_channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!generations || generations.length < 3) {
    // Not enough data to learn from
    return;
  }

  // Fetch feedback-related brand notes
  const { data: feedbackNotes } = await supabase
    .from("brand_notes")
    .select("note, created_at")
    .eq("channel_id", channelId)
    .like("note", "Copy feedback:%")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!feedbackNotes || feedbackNotes.length < 3) {
    return;
  }

  // Build analysis prompt
  const generationSummaries = generations.map((g) => {
    const type = g.source_type;
    const filename = g.video_filename;
    return `- [${type}] ${filename} (${new Date(g.created_at).toISOString().split("T")[0]})`;
  }).join("\n");

  const feedbackSummaries = feedbackNotes.map((n) => {
    const date = new Date(n.created_at).toISOString().split("T")[0];
    return `[${date}] ${n.note}`;
  }).join("\n");

  const analysisPrompt = `Analyze these feedback patterns from a brand marketing channel. Look for recurring themes, preferences, and patterns.

GENERATIONS (${generations.length} total):
${generationSummaries}

FEEDBACK HISTORY (${feedbackNotes.length} items):
${sanitize(feedbackSummaries)}

Identify patterns in these categories:
1. angle_preference — Which value prop angles get approved vs revised?
2. style_pattern — What revision patterns repeat? (e.g., "shorten headlines" in multiple threads)
3. tone_drift — Are there shifts in tone preference over time?
4. format_insight — Do certain types of creative (video vs image) produce better copy?

For each pattern you find, output a JSON array of insights:
[
  {
    "category": "angle_preference|style_pattern|tone_drift|format_insight",
    "insight": "Clear, specific insight text",
    "confidence": 0.0-1.0,
    "sample_size": number_of_examples_supporting_this
  }
]

Only include patterns you're confident about (minimum 2 supporting examples).
If you don't find any clear patterns, return an empty array: []

Return ONLY valid JSON. No explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1000,
      messages: [{ role: "user", content: analysisPrompt }],
    });

    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "[]";

    const jsonStr = responseText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const insights = JSON.parse(jsonStr) as Array<{
      category: string;
      insight: string;
      confidence: number;
      sample_size: number;
    }>;

    if (!Array.isArray(insights) || insights.length === 0) return;

    // Deactivate old learnings for this channel
    await supabase
      .from("learnings")
      .update({ active: false })
      .eq("channel_id", channelId);

    // Insert new learnings
    const rows = insights.map((i) => ({
      channel_id: channelId,
      category: i.category,
      insight: i.insight,
      confidence: Math.min(Math.max(i.confidence, 0), 1),
      sample_size: i.sample_size,
      active: true,
    }));

    await supabase.from("learnings").insert(rows);

    console.log(
      `Learning agent: stored ${rows.length} insights for channel ${channelId}`
    );
  } catch (err) {
    console.error("Learning agent analysis error:", err);
  }
}
