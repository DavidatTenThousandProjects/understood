/**
 * Smart Router.
 *
 * Two tiers:
 * 1. Deterministic rules (no AI, instant)
 * 2. Sonnet fallback (for ambiguous messages)
 *
 * Replaces: classifyIntent(), classifyUploadIntent(), and all scattered if/else in route.ts.
 */

import { anthropic } from "../anthropic";
import { supabase } from "../supabase";
import { parseCommand } from "../commands";
import { extractUrl } from "../fetch-url-media";
import type { EventContext, RouteDecision, AgentName } from "./types";

/**
 * Route an event to the appropriate agent.
 */
export async function routeEvent(ctx: EventContext): Promise<RouteDecision | null> {
  // ─── member_joined ───
  if (ctx.type === "member_joined") {
    const isBotJoin = ctx.userId === ctx.botUserId;
    return { agent: "welcome", meta: { isBotJoin } };
  }

  // ─── file_upload ───
  if (ctx.type === "file_upload") {
    // File uploads are handled by dispatcher directly — it enriches context,
    // then classifies intent to route to copy_generation or competitor_analysis.
    // Return a preliminary route that dispatcher will refine.
    return { agent: "copy_generation", meta: { needsIntentClassification: true } };
  }

  // ─── message ───
  if (ctx.type === "message") {
    if (!ctx.text && !ctx.fileInfo) return null;

    // DM messages
    if (ctx.isDM) {
      return await routeDM(ctx);
    }

    // Thread messages
    if (ctx.isThread && ctx.threadTs) {
      return await routeThread(ctx);
    }

    // Top-level channel messages
    return await routeTopLevel(ctx);
  }

  return null;
}

// ─── DM routing ───

async function routeDM(ctx: EventContext): Promise<RouteDecision> {
  // Check if user is in active onboarding
  const { data: customer } = await supabase
    .from("customers")
    .select("onboarding_step, onboarding_complete, active_thread_type")
    .eq("slack_user_id", ctx.userId)
    .single();

  if (
    customer &&
    !customer.onboarding_complete &&
    (customer.onboarding_step > 0 || customer.active_thread_type === "onboarding")
  ) {
    return { agent: "onboarding" };
  }

  // Check for commands
  const command = parseCommand(ctx.text);
  if (command) {
    return { agent: "command", meta: { command } };
  }

  // Fallback — help
  return { agent: "command", meta: { command: "help" } };
}

// ─── Thread routing ───

async function routeThread(ctx: EventContext): Promise<RouteDecision | null> {
  if (!ctx.text) return null;

  // Check if it's an onboarding thread
  const { data: customer } = await supabase
    .from("customers")
    .select(
      "onboarding_channel, onboarding_thread_ts, onboarding_complete, active_thread_type"
    )
    .eq("slack_user_id", ctx.userId)
    .single();

  if (
    customer &&
    !customer.onboarding_complete &&
    customer.active_thread_type === "onboarding" &&
    customer.onboarding_channel === ctx.channelId &&
    customer.onboarding_thread_ts === ctx.threadTs
  ) {
    return { agent: "onboarding" };
  }

  // Check if it's a generation thread
  const { data: generation } = await supabase
    .from("generations")
    .select("source_type")
    .eq("slack_channel_id", ctx.channelId)
    .eq("slack_message_ts", ctx.threadTs)
    .limit(1)
    .single();

  if (generation) {
    const sourceType = generation.source_type;
    if (
      sourceType === "video" ||
      sourceType === "image" ||
      sourceType === "competitor_analysis"
    ) {
      return {
        agent: "conversation",
        meta: { threadType: sourceType },
      };
    }
  }

  // Thread we don't recognize — ignore
  return null;
}

// ─── Top-level channel message routing ───

async function routeTopLevel(ctx: EventContext): Promise<RouteDecision> {
  // Tier 1: Deterministic — commands
  const command = parseCommand(ctx.text);
  if (command) {
    return { agent: "command", meta: { command } };
  }

  // Tier 1: Deterministic — URL + competitor signals
  const url = extractUrl(ctx.text);
  if (url && ctx.text.trim().length > 10) {
    // Quick regex check for competitor intent before AI call
    const competitorSignals =
      /love\s*(this|the|that)|inspired|competitor|saw\s*this|how\s*would|break.*down|analy[zs]|style|this\s*ad/i;
    if (competitorSignals.test(ctx.text)) {
      return {
        agent: "competitor_analysis",
        meta: { url, isLink: true },
      };
    }
  }

  // Tier 1: Short messages — too short to be useful brand context
  if (ctx.text.trim().length <= 10) {
    return { agent: "command", meta: { command: "fallback" } };
  }

  // Tier 2: Sonnet fallback for ambiguous top-level messages
  if (url) {
    // Has a URL but no clear competitor signals — use AI to classify
    const intent = await classifyTopLevelIntent(ctx.text);
    if (intent === "competitor_analysis") {
      return { agent: "competitor_analysis", meta: { url, isLink: true } };
    }
    // Fall through to brand_context
  }

  // Tier 2: Sonnet fallback for non-URL messages
  const intent = await classifyTopLevelIntent(ctx.text);
  if (intent === "command") {
    return { agent: "command", meta: { command: "help" } };
  }
  if (intent === "competitor_analysis") {
    return { agent: "competitor_analysis" };
  }

  // Default: brand context
  return { agent: "brand_context" };
}

// ─── Sonnet classification for ambiguous messages ───

async function classifyTopLevelIntent(
  text: string
): Promise<"brand_context" | "competitor_analysis" | "command" | "conversation"> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 20,
      system: `You classify messages in a brand marketing channel. The user sent a top-level message (not a reply to anything).

Classify as EXACTLY one of:
- "brand_context" — sharing info about their brand (pricing, tone, new product, tagline, restriction)
- "competitor_analysis" — sharing a competitor link or asking about competition
- "command" — asking for help, setup, or profile in natural language
- "conversation" — casual chat or acknowledgment

Reply with ONLY the single classification word. Nothing else.`,
      messages: [{ role: "user", content: text }],
    });

    const result =
      response.content[0].type === "text"
        ? response.content[0].text.trim().toLowerCase()
        : "brand_context";

    if (
      result === "competitor_analysis" ||
      result === "command" ||
      result === "conversation"
    ) {
      return result;
    }
    return "brand_context";
  } catch {
    // On error, default to brand context (safe fallback)
    return "brand_context";
  }
}

/**
 * Classify upload intent: is this a competitor ad or own creative?
 * Used by dispatcher after file enrichment.
 */
export async function classifyFileUploadIntent(
  userMessage: string
): Promise<"competitor" | "own_creative"> {
  if (!userMessage || userMessage.trim().length === 0) {
    return "own_creative";
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 20,
      system: `You classify user messages that accompany a file upload in a brand marketing channel.

The user uploaded an image or video along with a message. Determine their intent:

- "competitor" — they're sharing someone else's ad for inspiration or analysis. Signals: "I love this", "how would we do this", "make something like this", "competitor", "saw this ad", "this style", "inspired by", "analyze this", "break this down", expressing admiration for another brand's work.
- "own_creative" — they're uploading their OWN ad creative and want copy written for it. Signals: "write copy", "need captions", "new ad", "here's our latest", or simply describing their own product.

Reply with ONLY: competitor or own_creative`,
      messages: [{ role: "user", content: userMessage }],
    });

    const result =
      response.content[0].type === "text"
        ? response.content[0].text.trim().toLowerCase()
        : "own_creative";

    if (result === "competitor") return "competitor";
    return "own_creative";
  } catch {
    return "own_creative";
  }
}
