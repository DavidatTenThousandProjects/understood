/**
 * Learning Agent — Merge-Based Accumulation.
 *
 * Background agent that analyzes feedback patterns and evolves the voice profile
 * through incremental merge operations instead of nuclear replacement.
 *
 * Merge actions:
 * - reinforce: Existing insight confirmed by new data -> bump confidence, sum sample_size
 * - supersede: Existing insight contradicted by new data -> deactivate old, insert new
 * - new: Novel insight with no existing match -> simple insert
 *
 * Input sources (in priority order):
 * 1. Structured copy_feedback records (action, variants, revisions)
 * 2. Actual generation variants from generations table
 * 3. Existing active learnings (for merge context)
 * 4. Legacy brand_notes "Copy feedback:..." fallback
 *
 * Triggers:
 * - After conversation agent handles feedback (triggerLearning flag)
 * - After every Nth generation for periodic review
 *
 * Output: Merge operations applied to the `learnings` table.
 * Does NOT respond to user messages — returns empty messages.
 */

import { anthropic } from "../anthropic";
import { supabase } from "../supabase";
import { sanitize } from "../sanitize";
import type { EventContext, BrandContext, AgentResult } from "./types";

/* ------------------------------------------------------------------ */
/*  Types for the merge protocol                                      */
/* ------------------------------------------------------------------ */

interface ReinforceAction {
  action: "reinforce";
  existing_learning_id: string;
  reason: string;
}

interface SupersedeAction {
  action: "supersede";
  existing_learning_id: string;
  category: string;
  insight: string;
  confidence: number;
  sample_size: number;
  source_feedback_ids: string[];
  reason: string;
}

interface NewAction {
  action: "new";
  category: string;
  insight: string;
  confidence: number;
  sample_size: number;
  source_feedback_ids: string[];
}

type MergeAction = ReinforceAction | SupersedeAction | NewAction;

/* ------------------------------------------------------------------ */
/*  Public entry point                                                */
/* ------------------------------------------------------------------ */

/**
 * Learning agent handler.
 * Runs in background — returns empty messages (doesn't post to Slack).
 */
export async function learningAgent(
  ctx: EventContext,
  brand: BrandContext
): Promise<AgentResult> {
  try {
    await analyzeFeedbackPatterns(ctx.channelId, ctx.teamId);
  } catch (err) {
    console.error("Learning agent error:", err);
  }

  // Learning agent doesn't post messages
  return { messages: [] };
}

/* ------------------------------------------------------------------ */
/*  Core analysis pipeline                                            */
/* ------------------------------------------------------------------ */

async function analyzeFeedbackPatterns(
  channelId: string,
  teamId: string
): Promise<void> {
  // ── 1. Fetch structured copy_feedback with generation context ──
  const { data: copyFeedback } = await supabase
    .from("copy_feedback")
    .select(
      "id, generation_id, variant_number, action, feedback_text, original_variant, revised_variant, approval_reason, created_at"
    )
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(50);

  // ── 2. Fetch recent generations with actual variant data ──
  const { data: generations } = await supabase
    .from("generations")
    .select("id, source_type, variants, video_filename, created_at")
    .eq("slack_channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(20);

  // ── 3. Fetch existing active learnings (merge context) ──
  const { data: existingLearnings } = await supabase
    .from("learnings")
    .select(
      "id, category, insight, confidence, sample_size, version, last_reinforced_at, created_at"
    )
    .eq("channel_id", channelId)
    .eq("active", true)
    .order("confidence", { ascending: false });

  // ── 4. Check minimum data threshold ──
  const hasStructuredFeedback = !!(copyFeedback && copyFeedback.length >= 3);
  let hasLegacyFeedback = false;
  let feedbackNotes: Array<{ note: string; created_at: string }> | null = null;

  if (!hasStructuredFeedback) {
    // Fall back to legacy brand notes
    const { data } = await supabase
      .from("brand_notes")
      .select("note, created_at")
      .eq("channel_id", channelId)
      .like("note", "Copy feedback:%")
      .order("created_at", { ascending: false })
      .limit(50);

    feedbackNotes = data;
    hasLegacyFeedback = !!feedbackNotes && feedbackNotes.length >= 3;
  }

  if (!hasStructuredFeedback && !hasLegacyFeedback) {
    // Not enough data to learn from
    return;
  }

  if (!generations || generations.length < 3) {
    return;
  }

  // ── 5. Build the analysis prompt ──
  const prompt = buildAnalysisPrompt(
    generations,
    copyFeedback ?? [],
    feedbackNotes ?? [],
    existingLearnings ?? [],
    hasStructuredFeedback
  );

  // ── 6. Call Sonnet for analysis ──
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "[]";

    // Strip markdown code fences if present
    const jsonStr = responseText
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();

    const mergeActions = JSON.parse(jsonStr) as MergeAction[];

    if (!Array.isArray(mergeActions) || mergeActions.length === 0) return;

    // ── 7. Process each merge action ──
    let reinforced = 0;
    let superseded = 0;
    let inserted = 0;

    for (const action of mergeActions) {
      try {
        switch (action.action) {
          case "reinforce":
            await processReinforce(action, channelId, existingLearnings ?? []);
            reinforced++;
            break;

          case "supersede":
            await processSupersede(action, channelId, teamId);
            superseded++;
            break;

          case "new":
            await processNew(action, channelId, teamId);
            inserted++;
            break;

          default:
            console.warn(
              `Learning agent: unknown merge action "${(action as MergeAction).action}"`
            );
        }
      } catch (actionErr) {
        console.error(
          `Learning agent: failed to process ${action.action} action:`,
          actionErr
        );
      }
    }

    console.log(
      `Learning agent: channel ${channelId} — reinforced=${reinforced}, superseded=${superseded}, new=${inserted}`
    );
  } catch (err) {
    console.error("Learning agent analysis error:", err);
  }
}

/* ------------------------------------------------------------------ */
/*  Prompt construction                                               */
/* ------------------------------------------------------------------ */

function buildAnalysisPrompt(
  generations: Array<{
    id: string;
    source_type: string;
    variants: unknown;
    video_filename: string;
    created_at: string;
  }>,
  copyFeedback: Array<{
    id: string;
    generation_id: string;
    variant_number: number | null;
    action: string;
    feedback_text: string | null;
    original_variant: unknown;
    revised_variant: unknown;
    approval_reason: string | null;
    created_at: string;
  }>,
  legacyNotes: Array<{ note: string; created_at: string }>,
  existingLearnings: Array<{
    id: string;
    category: string;
    insight: string;
    confidence: number;
    sample_size: number;
    version: number;
    last_reinforced_at: string;
    created_at: string;
  }>,
  useStructuredFeedback: boolean
): string {
  // Generation summaries with actual variant data
  const generationBlock = generations
    .map((g) => {
      const date = new Date(g.created_at).toISOString().split("T")[0];
      const variantStr =
        g.variants && Array.isArray(g.variants)
          ? JSON.stringify(g.variants, null, 2)
          : "(no variants)";
      return `[${date}] ${g.source_type} — ${g.video_filename} (id: ${g.id})\nVariants:\n${variantStr}`;
    })
    .join("\n\n");

  // Feedback block
  let feedbackBlock: string;

  if (useStructuredFeedback) {
    feedbackBlock = copyFeedback
      .map((f) => {
        const date = new Date(f.created_at).toISOString().split("T")[0];
        const parts = [
          `[${date}] Action: ${f.action}`,
          f.variant_number != null ? `Variant #${f.variant_number}` : null,
          f.feedback_text ? `Feedback: ${f.feedback_text}` : null,
          f.approval_reason ? `Approval reason: ${f.approval_reason}` : null,
          f.original_variant
            ? `Original: ${JSON.stringify(f.original_variant)}`
            : null,
          f.revised_variant
            ? `Revised: ${JSON.stringify(f.revised_variant)}`
            : null,
          `(feedback_id: ${f.id})`,
        ];
        return parts.filter(Boolean).join("\n  ");
      })
      .join("\n\n");
  } else {
    feedbackBlock = legacyNotes
      .map((n) => {
        const date = new Date(n.created_at).toISOString().split("T")[0];
        return `[${date}] ${n.note}`;
      })
      .join("\n");
  }

  // Existing learnings block
  const learningsBlock =
    existingLearnings.length > 0
      ? existingLearnings
          .map(
            (l) =>
              `- [${l.category}] "${l.insight}" (id: ${l.id}, confidence: ${l.confidence}, samples: ${l.sample_size}, v${l.version})`
          )
          .join("\n")
      : "(no existing learnings)";

  return `You are a learning agent for an AI copywriting tool. Analyze the feedback patterns below and produce MERGE ACTIONS against existing learnings.

EXISTING ACTIVE LEARNINGS:
${learningsBlock}

RECENT GENERATIONS (${generations.length} total):
${sanitize(generationBlock)}

${useStructuredFeedback ? "STRUCTURED FEEDBACK" : "LEGACY FEEDBACK NOTES"} (${useStructuredFeedback ? copyFeedback.length : legacyNotes.length} items):
${sanitize(feedbackBlock)}

CATEGORIES to analyze:
1. angle_preference — Which value prop angles get approved vs revised?
2. style_pattern — What revision patterns repeat? (e.g., "shorten headlines" across threads)
3. tone_drift — Are there shifts in tone preference over time?
4. format_insight — Do certain creative types (video vs image) produce better copy?

MERGE RULES:
- If new data SUPPORTS an existing learning → use "reinforce" (reference its ID)
- If new data CONTRADICTS an existing learning → use "supersede" (reference its ID, provide the corrected insight)
- If the insight is entirely novel (no existing learning covers it) → use "new"
- Only include patterns with minimum 2 supporting examples
- If no clear patterns, return an empty array: []
${useStructuredFeedback ? "- When using structured feedback, include the feedback_id values in source_feedback_ids" : "- Legacy mode: source_feedback_ids should be empty arrays"}

OUTPUT FORMAT — return ONLY a valid JSON array of merge actions:
[
  {
    "action": "reinforce",
    "existing_learning_id": "uuid-of-existing-learning",
    "reason": "Why this reinforces the existing insight"
  },
  {
    "action": "supersede",
    "existing_learning_id": "uuid-of-existing-learning",
    "category": "style_pattern",
    "insight": "New corrected insight text",
    "confidence": 0.7,
    "sample_size": 3,
    "source_feedback_ids": ["feedback-uuid-1", "feedback-uuid-2"],
    "reason": "Why this supersedes the old one"
  },
  {
    "action": "new",
    "category": "angle_preference",
    "insight": "Novel insight text",
    "confidence": 0.6,
    "sample_size": 2,
    "source_feedback_ids": ["feedback-uuid-1"]
  }
]

Return ONLY valid JSON. No explanation or markdown.`;
}

/* ------------------------------------------------------------------ */
/*  Merge action processors                                           */
/* ------------------------------------------------------------------ */

/**
 * Reinforce: bump confidence (+0.05, capped at 1.0), sum sample_size,
 * increment version, update last_reinforced_at.
 */
async function processReinforce(
  action: ReinforceAction,
  channelId: string,
  existingLearnings: Array<{
    id: string;
    confidence: number;
    sample_size: number;
    version: number;
  }>
): Promise<void> {
  const existing = existingLearnings.find(
    (l) => l.id === action.existing_learning_id
  );
  if (!existing) {
    console.warn(
      `Learning agent: reinforce target ${action.existing_learning_id} not found`
    );
    return;
  }

  const newConfidence = Math.min(existing.confidence + 0.05, 1.0);
  const newVersion = existing.version + 1;

  await supabase
    .from("learnings")
    .update({
      confidence: newConfidence,
      sample_size: existing.sample_size + 1,
      version: newVersion,
      last_reinforced_at: new Date().toISOString(),
    })
    .eq("id", action.existing_learning_id)
    .eq("channel_id", channelId);
}

/**
 * Supersede: insert the new learning as active, deactivate old with
 * superseded_by pointing to the new record.
 */
async function processSupersede(
  action: SupersedeAction,
  channelId: string,
  teamId: string
): Promise<void> {
  // Insert the new superseding learning
  const { data: inserted, error: insertErr } = await supabase
    .from("learnings")
    .insert({
      channel_id: channelId,
      team_id: teamId,
      category: action.category,
      insight: action.insight,
      confidence: Math.min(Math.max(action.confidence, 0), 1),
      sample_size: action.sample_size,
      source_feedback_ids: action.source_feedback_ids ?? [],
      active: true,
      version: 1,
      last_reinforced_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("Learning agent: supersede insert failed:", insertErr);
    return;
  }

  // Deactivate the old learning and point to the new one
  await supabase
    .from("learnings")
    .update({
      active: false,
      superseded_by: inserted.id,
    })
    .eq("id", action.existing_learning_id)
    .eq("channel_id", channelId);
}

/**
 * New: simple insert of a novel insight.
 */
async function processNew(
  action: NewAction,
  channelId: string,
  teamId: string
): Promise<void> {
  await supabase.from("learnings").insert({
    channel_id: channelId,
    team_id: teamId,
    category: action.category,
    insight: action.insight,
    confidence: Math.min(Math.max(action.confidence, 0), 1),
    sample_size: action.sample_size,
    source_feedback_ids: action.source_feedback_ids ?? [],
    active: true,
    version: 1,
    last_reinforced_at: new Date().toISOString(),
  });
}
