/**
 * Welcome Agent.
 *
 * Handles member_joined events:
 * - Bot joins channel → full welcome + pin
 * - Human joins with existing profile → short welcome with profile summary
 * - Human joins without profile → generic welcome pointing to pinned message
 */

import { pinMessage } from "../slack";
import { formatWelcomeMessage, formatTeamMemberWelcome } from "../format-slack";
import type { EventContext, BrandContext, AgentResult } from "./types";

const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";

/**
 * Welcome agent handler.
 */
export async function welcomeAgent(
  ctx: EventContext,
  brand: BrandContext,
  meta?: Record<string, unknown>
): Promise<AgentResult> {
  const isBotJoin = meta?.isBotJoin === true || ctx.userId === BOT_USER_ID;

  if (isBotJoin) {
    return handleBotJoined(ctx);
  }

  return handleMemberJoined(ctx, brand);
}

// ─── Handlers ───

function handleBotJoined(ctx: EventContext): AgentResult {
  // Post welcome and pin it — pinning is done as a side effect after posting
  // We'll handle the pin in a post-dispatch hook since we need the message ts
  return {
    messages: [
      {
        channel: ctx.channelId,
        text: formatWelcomeMessage(),
      },
    ],
    // Pin will be handled by the dispatcher's post-message hook
    // since we need the posted message's timestamp
  };
}

function handleMemberJoined(
  ctx: EventContext,
  brand: BrandContext
): AgentResult {
  if (brand.profile) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: formatTeamMemberWelcome(brand.profile as unknown as Record<string, unknown>),
        },
      ],
    };
  }

  // No profile — short welcome
  return {
    messages: [
      {
        channel: ctx.channelId,
        text: "Welcome! Check the pinned message to see how Understood works.",
      },
    ],
  };
}
