/**
 * Command Agent.
 *
 * Handles: setup, new_setup, profile, help, learnings, refresh, fallback.
 * Deterministic first (exact matches), Sonnet fallback for natural language.
 */

import { supabase } from "../supabase";
import { formatProfileDisplay, formatHelpMessage } from "../format-slack";
import { getBrandNotesCount } from "../context";
import type { EventContext, BrandContext, AgentResult } from "./types";

/**
 * Command agent handler.
 */
export async function commandAgent(
  ctx: EventContext,
  brand: BrandContext,
  meta?: Record<string, unknown>
): Promise<AgentResult> {
  const command = (meta?.command as string) || "help";

  switch (command) {
    case "setup":
      return handleSetup(ctx, brand);
    case "new_setup":
      return handleNewSetup(ctx);
    case "profile":
      return handleProfile(ctx, brand);
    case "help":
      return handleHelp(ctx);
    case "learnings":
      return handleLearnings(ctx, brand);
    case "refresh":
      return handleRefresh(ctx, brand);
    case "fallback":
      return handleFallback(ctx);
    default:
      return handleHelp(ctx);
  }
}

// ─── Command handlers ───

function handleSetup(
  ctx: EventContext,
  brand: BrandContext
): AgentResult {
  if (brand.profile) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: `This channel already has a brand profile for *${brand.profile.name}*.\n\n*Tone:* ${brand.profile.tone_description || "Not set"}\n\nYou don't need to run setup again — I'm learning from every message you send. Just share brand context (pricing changes, tone preferences, new taglines) and I'll keep improving.\n\nIf you want to start completely fresh with a new profile, say *new setup*.`,
          threadTs: ctx.threadTs || ctx.parentTs || undefined,
        },
      ],
    };
  }

  // Signal to dispatcher that onboarding should start
  // This is handled via meta passed back
  return {
    messages: [],
    sideEffects: [],
  };
}

function handleNewSetup(ctx: EventContext): AgentResult {
  // Signal to dispatcher to force fresh onboarding
  return {
    messages: [],
    sideEffects: [],
  };
}

async function handleProfile(
  ctx: EventContext,
  brand: BrandContext
): Promise<AgentResult> {
  if (!brand.profile) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: "No brand profile set up for this channel yet. Say *setup* to get started.",
          threadTs: ctx.threadTs || ctx.parentTs || undefined,
        },
      ],
    };
  }

  const notesCount = await getBrandNotesCount(ctx.channelId);

  const { count: genCount } = await supabase
    .from("generations")
    .select("id", { count: "exact", head: true })
    .eq("slack_channel_id", ctx.channelId);

  return {
    messages: [
      {
        channel: ctx.channelId,
        text: formatProfileDisplay(brand.profile as unknown as Record<string, unknown>, notesCount, genCount || 0),
        threadTs: ctx.threadTs || ctx.parentTs || undefined,
      },
    ],
  };
}

function handleHelp(ctx: EventContext): AgentResult {
  return {
    messages: [
      {
        channel: ctx.channelId,
        text: formatHelpMessage(),
        threadTs: ctx.threadTs || ctx.parentTs || undefined,
      },
    ],
  };
}

function handleLearnings(
  ctx: EventContext,
  brand: BrandContext
): AgentResult {
  if (!brand.learnings) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: "No learnings yet — I'll start picking up patterns after a few rounds of feedback on your copy.",
          threadTs: ctx.threadTs || ctx.parentTs || undefined,
        },
      ],
    };
  }

  return {
    messages: [
      {
        channel: ctx.channelId,
        text: `*What I've Learned About Your Brand*\n\n${brand.learnings}`,
        threadTs: ctx.threadTs || ctx.parentTs || undefined,
      },
    ],
  };
}

function handleRefresh(
  ctx: EventContext,
  brand: BrandContext
): AgentResult {
  if (!brand.profile) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: "No brand profile to refresh. Say *setup* to create one.",
          threadTs: ctx.threadTs || ctx.parentTs || undefined,
        },
      ],
    };
  }

  return {
    messages: [
      {
        channel: ctx.channelId,
        text: "Voice profile refresh coming soon. For now, say *new setup* to rebuild your profile from scratch.",
        threadTs: ctx.threadTs || ctx.parentTs || undefined,
      },
    ],
  };
}

function handleFallback(ctx: EventContext): AgentResult {
  return {
    messages: [
      {
        channel: ctx.channelId,
        text: "Not sure what you mean. You can upload a video for ad copy, or send me brand context (pricing, tone, phrases to use or avoid) to improve my output.",
        threadTs: ctx.threadTs || ctx.parentTs || undefined,
      },
    ],
  };
}
