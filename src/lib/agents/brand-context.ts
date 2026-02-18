/**
 * Brand Context Agent.
 *
 * Handles top-level channel messages that are brand context (not commands, not files).
 * Classifies the context type and stores it appropriately.
 *
 * Upgraded from: raw addBrandNote() for any message > 10 chars.
 * Now classifies context type and detects contradictions.
 */

import { anthropic } from "../anthropic";
import { sanitize } from "../sanitize";
import type { EventContext, BrandContext, AgentResult } from "./types";

/**
 * Brand context agent handler.
 */
export async function brandContextAgent(
  ctx: EventContext,
  brand: BrandContext
): Promise<AgentResult> {
  // Classify what kind of context this is
  const category = await classifyBrandContext(ctx.text);

  if (category === "conversational") {
    // Don't save casual messages as brand notes
    return { messages: [] };
  }

  // Check for contradictions with existing profile
  const contradiction = brand.profile
    ? detectContradiction(ctx.text, brand.profile as unknown as Record<string, unknown>)
    : null;

  if (contradiction) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: contradiction,
          threadTs: ctx.parentTs || undefined,
        },
      ],
      sideEffects: [
        {
          type: "add_brand_note",
          payload: {
            channelId: ctx.channelId,
            slackUserId: ctx.userId,
            text: `[${category}] ${ctx.text}`,
          },
        },
      ],
    };
  }

  // Determine response based on category
  const response = getCategoryResponse(category);

  return {
    messages: [
      {
        channel: ctx.channelId,
        text: response,
        threadTs: ctx.parentTs || undefined,
      },
    ],
    sideEffects: [
      {
        type: "add_brand_note",
        payload: {
          channelId: ctx.channelId,
          slackUserId: ctx.userId,
          text: `[${category}] ${ctx.text}`,
        },
      },
    ],
  };
}

// ─── Context Classification ───

type ContextCategory =
  | "pricing_update"
  | "tone_guidance"
  | "product_update"
  | "temporary_promo"
  | "new_restriction"
  | "general_context"
  | "conversational";

async function classifyBrandContext(text: string): Promise<ContextCategory> {
  // Quick deterministic checks first
  const lower = text.toLowerCase();

  if (/thanks|thank you|cool|ok|got it|nice|great/i.test(lower) && text.length < 30) {
    return "conversational";
  }

  if (/\$\d|price|pricing|cost|per\s*month|\/mo/i.test(lower)) {
    return "pricing_update";
  }

  if (/never\s*(say|use|mention)|don'?t\s*(say|use|mention)|avoid|ban/i.test(lower)) {
    return "new_restriction";
  }

  if (/tone|sound|feel|vibe|voice|style/i.test(lower)) {
    return "tone_guidance";
  }

  if (/launch|new\s*(feature|product)|just\s*released|now\s*offer/i.test(lower)) {
    return "product_update";
  }

  if (/sale|discount|promo|limited\s*time|black\s*friday|holiday|percent\s*off|\d+%\s*off/i.test(lower)) {
    return "temporary_promo";
  }

  // For messages that don't match deterministic patterns, classify with Sonnet
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 20,
      system: `Classify this brand context message into EXACTLY one category:
- "pricing_update" — price changes, new pricing
- "tone_guidance" — how ads should sound/feel
- "product_update" — new features, launches, product changes
- "temporary_promo" — sales, limited-time offers, discounts
- "new_restriction" — words/phrases to avoid, things to never say
- "general_context" — useful brand info that doesn't fit above
- "conversational" — casual chat, thanks, acknowledgments (not useful context)

Reply with ONLY the category name.`,
      messages: [{ role: "user", content: text }],
    });

    const result =
      response.content[0].type === "text"
        ? response.content[0].text.trim().toLowerCase()
        : "general_context";

    const valid: ContextCategory[] = [
      "pricing_update",
      "tone_guidance",
      "product_update",
      "temporary_promo",
      "new_restriction",
      "general_context",
      "conversational",
    ];

    return valid.includes(result as ContextCategory)
      ? (result as ContextCategory)
      : "general_context";
  } catch {
    return "general_context";
  }
}

// ─── Contradiction Detection ───

function detectContradiction(
  text: string,
  profile: Record<string, unknown>
): string | null {
  const lower = text.toLowerCase();

  // Check if new pricing contradicts mandatory phrases
  const priceMatch = text.match(/\$[\d,.]+(?:\/mo(?:nth)?)?/);
  if (priceMatch && profile.mandatory_phrases) {
    const phrases = profile.mandatory_phrases as string[];
    for (const phrase of phrases) {
      const existingPrice = phrase.match(/\$[\d,.]+(?:\/mo(?:nth)?)?/);
      if (existingPrice && existingPrice[0] !== priceMatch[0]) {
        return `Noted — I'll keep this in mind for future copy.\n\n_I noticed your mandatory phrases include "${phrase}" but you just mentioned ${priceMatch[0]}. Should I update your voice profile to use the new pricing?_`;
      }
    }
  }

  return null;
}

// ─── Response Templates ───

function getCategoryResponse(category: ContextCategory): string {
  switch (category) {
    case "pricing_update":
      return "Noted — I'll use this pricing in future copy.";
    case "tone_guidance":
      return "Noted — I'll adjust the tone in future copy.";
    case "product_update":
      return "Noted — I'll incorporate this into future copy.";
    case "temporary_promo":
      return "Noted — I'll work this promotion into copy. Let me know when it expires and I'll stop using it.";
    case "new_restriction":
      return "Noted — I'll make sure to avoid that in all future copy.";
    case "general_context":
      return "Noted — I'll keep this in mind for future copy.";
    default:
      return "Noted — I'll keep this in mind for future copy.";
  }
}
