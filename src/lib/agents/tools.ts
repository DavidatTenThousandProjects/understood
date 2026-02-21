/**
 * Agent Loop Tools.
 *
 * Tool definitions + execution logic for the copy generation agent loop.
 * Three tools: submit_variant, review_set, fetch_exemplars.
 */

import { supabase } from "../supabase";
import type { CopyVariant, VoiceProfile } from "../types";
import type {
  AgentLoopState,
  SubmitVariantInput,
  ReviewSetInput,
  FetchExemplarsInput,
  ToolResult,
  ExemplarRecord,
} from "./types";

// ─── Tool Definitions (for Anthropic API tool_use) ───

export const AGENT_TOOLS = [
  {
    name: "fetch_exemplars",
    description:
      "Fetch past approved copy variants as few-shot examples. Call this FIRST before generating any variants. Returns up to 5 exemplars sorted by score and recency.",
    input_schema: {
      type: "object" as const,
      properties: {
        count: {
          type: "number",
          description: "Number of exemplars to fetch (default 5, max 5)",
        },
      },
      required: [],
    },
  },
  {
    name: "submit_variant",
    description:
      "Submit one completed ad copy variant for validation. Call this once per variant (4 times total). The system validates headline length, banned phrases, mandatory phrases, uniqueness, and primary text quality.",
    input_schema: {
      type: "object" as const,
      properties: {
        angle: {
          type: "string",
          description: "The value proposition angle for this variant",
        },
        headline: {
          type: "string",
          description: "Short, punchy headline under 40 characters",
        },
        description: {
          type: "string",
          description: "One-sentence description of the offer/message",
        },
        primary_text: {
          type: "string",
          description: "3-5 short paragraphs of ad copy",
        },
      },
      required: ["angle", "headline", "description", "primary_text"],
    },
  },
  {
    name: "review_set",
    description:
      "After all 4 variants are submitted, call this to run a final quality check on the complete set. Checks for angle diversity, headline uniqueness, and overall quality.",
    input_schema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean",
          description: "Set to true to trigger the review",
        },
      },
      required: ["confirm"],
    },
  },
] as const;

// ─── Tool Execution ───

export async function executeSubmitVariant(
  input: SubmitVariantInput,
  state: AgentLoopState,
  profile: VoiceProfile
): Promise<ToolResult> {
  const issues: string[] = [];

  // Headline length check
  if (input.headline.length > 40) {
    issues.push(
      `Headline is ${input.headline.length} chars — must be under 40. Current: "${input.headline}"`
    );
  }

  // Banned phrases check
  if (profile.banned_phrases && profile.banned_phrases.length > 0) {
    const fullText = `${input.headline} ${input.description} ${input.primary_text}`.toLowerCase();
    for (const banned of profile.banned_phrases) {
      if (banned && fullText.includes(banned.toLowerCase())) {
        issues.push(`Banned phrase "${banned}" detected — remove it.`);
      }
    }
  }

  // Mandatory phrases check (across the full variant)
  if (profile.mandatory_phrases && profile.mandatory_phrases.length > 0) {
    const fullText = `${input.headline} ${input.description} ${input.primary_text}`.toLowerCase();
    for (const phrase of profile.mandatory_phrases) {
      if (phrase && !fullText.includes(phrase.toLowerCase())) {
        issues.push(
          `Mandatory phrase "${phrase}" is missing — include it somewhere in the variant.`
        );
      }
    }
  }

  // Unique headline vs existing variants
  const existingHeadlines = state.variants.map((v) =>
    v.headline.toLowerCase().trim()
  );
  if (existingHeadlines.includes(input.headline.toLowerCase().trim())) {
    issues.push(
      `Headline "${input.headline}" duplicates an existing variant — make it unique.`
    );
  }

  // Primary text minimum quality
  const paragraphs = input.primary_text
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0);
  if (paragraphs.length < 3) {
    issues.push(
      `Primary text has only ${paragraphs.length} paragraph(s) — need at least 3.`
    );
  }

  // Code artifact check
  if (
    input.primary_text.includes("```") ||
    input.primary_text.includes("json") && input.primary_text.includes("{")
  ) {
    const hasCodeBlock = input.primary_text.includes("```");
    if (hasCodeBlock) {
      issues.push("Code artifacts detected in primary text — write natural ad copy only.");
    }
  }

  if (issues.length > 0) {
    state.qualityIssues.push(...issues);
    return {
      success: false,
      message: `Variant rejected. Fix these issues and resubmit:\n${issues.map((i) => `- ${i}`).join("\n")}`,
    };
  }

  // Variant passes — add to state
  state.variants.push({
    angle: input.angle,
    headline: input.headline,
    description: input.description,
    primary_text: input.primary_text,
  });

  return {
    success: true,
    message: `Variant ${state.variants.length} accepted (${input.angle}). ${4 - state.variants.length} remaining.`,
  };
}

export function executeReviewSet(
  _input: ReviewSetInput,
  state: AgentLoopState,
  profile: VoiceProfile
): ToolResult {
  if (state.variants.length < 4) {
    return {
      success: false,
      message: `Only ${state.variants.length}/4 variants submitted. Submit all 4 before reviewing.`,
    };
  }

  const issues: string[] = [];

  // All 4 angles must be distinct
  const angles = state.variants.map((v) => v.angle.toLowerCase().trim());
  const uniqueAngles = new Set(angles);
  if (uniqueAngles.size < 4) {
    issues.push(
      "Not all 4 angles are distinct. Each variant needs a unique value proposition angle."
    );
  }

  // All 4 headlines must be unique
  const headlines = state.variants.map((v) => v.headline.toLowerCase().trim());
  const uniqueHeadlines = new Set(headlines);
  if (uniqueHeadlines.size < 4) {
    issues.push("Duplicate headlines found. Every variant must have a unique headline.");
  }

  // Jaccard similarity check between primary texts
  for (let i = 0; i < state.variants.length; i++) {
    for (let j = i + 1; j < state.variants.length; j++) {
      const similarity = jaccardSimilarity(
        state.variants[i].primary_text,
        state.variants[j].primary_text
      );
      if (similarity > 0.7) {
        issues.push(
          `Variants ${i + 1} and ${j + 1} are too similar (${Math.round(similarity * 100)}% overlap). Make them more distinct.`
        );
      }
    }
  }

  // Quality floor: each primary text should be substantive
  for (let i = 0; i < state.variants.length; i++) {
    if (state.variants[i].primary_text.length < 100) {
      issues.push(
        `Variant ${i + 1} primary text is too short (${state.variants[i].primary_text.length} chars). Write more substantive copy.`
      );
    }
  }

  if (issues.length > 0) {
    state.qualityIssues.push(...issues);
    return {
      success: false,
      message: `Set review FAILED. Fix these issues:\n${issues.map((i) => `- ${i}`).join("\n")}\n\nResubmit the weak variant(s) using submit_variant, then call review_set again.`,
    };
  }

  state.reviewPassed = true;
  return {
    success: true,
    message: "All 4 variants pass quality review. The set is complete.",
  };
}

export async function executeFetchExemplars(
  input: FetchExemplarsInput,
  channelId: string
): Promise<ToolResult> {
  const count = Math.min(input.count || 5, 5);

  try {
    const { data } = await supabase
      .from("exemplars")
      .select("variant, source_type, approval_reason, score")
      .eq("channel_id", channelId)
      .eq("active", true)
      .order("score", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(count);

    if (!data || data.length === 0) {
      return {
        success: true,
        message:
          "No exemplars found yet — this is a new channel. Generate your best work and the team will build up a library over time.",
        data: [],
      };
    }

    const exemplars = data.map((e, i) => ({
      index: i + 1,
      variant: e.variant,
      sourceType: e.source_type,
      whyApproved: e.approval_reason || "No reason recorded",
      score: e.score,
    }));

    return {
      success: true,
      message: `Found ${exemplars.length} approved exemplar(s). Use these as reference for tone, structure, and quality — but don't copy them.`,
      data: exemplars,
    };
  } catch {
    // Table may not exist yet
    return {
      success: true,
      message: "Exemplars not available yet. Generate your best work.",
      data: [],
    };
  }
}

// ─── Helpers ───

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
