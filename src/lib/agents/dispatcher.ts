/**
 * Agent Dispatcher.
 *
 * Given a route decision:
 * 1. Assemble brand context
 * 2. Look up agent handler
 * 3. Call agent
 * 4. Pass result through Quality Gate
 * 5. Post messages to Slack + execute side effects
 * 6. Queue Learning Agent if flagged
 */

import { postMessage } from "../slack";
import { addBrandNote } from "../context";
import { supabase } from "../supabase";
import { friendlyError } from "../anthropic";
import { getBrandContext } from "./context";
import { runQualityGate } from "./quality-gate";
import type { EventContext, RouteDecision, AgentResult, AgentHandler, SideEffect } from "./types";

// Agent registry — populated by registerAgent()
const agents: Map<string, AgentHandler> = new Map();

/**
 * Register an agent handler.
 */
export function registerAgent(name: string, handler: AgentHandler): void {
  agents.set(name, handler);
}

/**
 * Dispatch an event to the appropriate agent.
 */
export async function dispatch(
  ctx: EventContext,
  route: RouteDecision
): Promise<void> {
  try {
    // 1. Assemble brand context
    const brand = await getBrandContext(
      ctx.channelId,
      ctx.teamId,
      ctx.botUserId,
      ctx.threadTs || undefined
    );

    // 2. Look up handler
    const handler = agents.get(route.agent);
    if (!handler) {
      console.error(`No handler registered for agent: ${route.agent}`);
      return;
    }

    // 3. Call agent
    const result = await handler(ctx, brand, route.meta);

    // 4. Quality gate
    const checked = await runQualityGate(result, brand.profile);

    // 5. Post messages to Slack
    for (const msg of checked.messages) {
      await postMessage(ctx.teamId, msg.channel, msg.text, msg.threadTs);
    }

    // 6. Execute side effects
    if (checked.sideEffects) {
      await executeSideEffects(checked.sideEffects, ctx.teamId);
    }

    // 7. Trigger Learning Agent if flagged
    if (checked.triggerLearning) {
      // Learning agent runs async — don't await
      const learningHandler = agents.get("learning");
      if (learningHandler) {
        learningHandler(ctx, brand).catch((err) =>
          console.error("Learning agent error:", err)
        );
      }
    }
  } catch (error) {
    console.error(`Error in agent ${route.agent}:`, error);

    // Post friendly error to Slack
    const errorMsg = friendlyError(error);
    const threadTs = ctx.threadTs || (ctx.rawEvent as Record<string, unknown>)?.ts as string | undefined;
    await postMessage(ctx.teamId, ctx.channelId, errorMsg, threadTs || undefined).catch(() => {});
  }
}

// ─── Side Effect Execution ───

async function executeSideEffects(effects: SideEffect[], teamId: string): Promise<void> {
  for (const effect of effects) {
    try {
      switch (effect.type) {
        case "add_brand_note":
          await addBrandNote(
            effect.payload.channelId as string,
            effect.payload.slackUserId as string,
            effect.payload.text as string,
            teamId
          );
          break;

        case "save_generation":
          await supabase.from("generations").insert({
            ...effect.payload,
            team_id: teamId,
          });
          break;

        case "update_profile":
          await supabase
            .from("voice_profiles")
            .update(effect.payload.data as Record<string, unknown>)
            .eq("id", effect.payload.profileId as string);
          break;

        case "update_customer":
          await supabase
            .from("customers")
            .update(effect.payload.data as Record<string, unknown>)
            .eq("slack_user_id", effect.payload.slackUserId as string);
          break;

        case "save_copy_feedback":
          await supabase.from("copy_feedback").insert({
            team_id: teamId,
            channel_id: effect.payload.channelId as string,
            generation_id: effect.payload.generationId as string,
            variant_number: effect.payload.variantNumber as number | null,
            action: effect.payload.action as string,
            feedback_text: effect.payload.feedbackText as string | null,
            original_variant: effect.payload.originalVariant || null,
            revised_variant: effect.payload.revisedVariant || null,
            approval_reason: effect.payload.approvalReason as string | null,
            slack_user_id: effect.payload.slackUserId as string,
          });
          break;

        case "save_exemplar":
          await supabase.from("exemplars").insert({
            team_id: teamId,
            channel_id: effect.payload.channelId as string,
            generation_id: effect.payload.generationId as string,
            voice_profile_id: effect.payload.voiceProfileId as string,
            variant: effect.payload.variant,
            source_type: effect.payload.sourceType as string,
            approval_reason: effect.payload.approvalReason as string | null,
            source_transcript_snippet: effect.payload.sourceTranscriptSnippet as string | null,
            score: (effect.payload.score as number) || 1.0,
          });
          break;

        case "update_generation_meta":
          await supabase
            .from("generations")
            .update({
              agent_turns: effect.payload.agent_turns,
              agent_duration_ms: effect.payload.agent_duration_ms,
              quality_issues: effect.payload.quality_issues,
            })
            .eq("slack_channel_id", effect.payload.slack_channel_id as string)
            .eq("slack_message_ts", effect.payload.slack_message_ts as string);
          break;

        default:
          console.warn("Unknown side effect type:", effect.type);
      }
    } catch (err) {
      console.error(`Side effect error (${effect.type}):`, err);
    }
  }
}

/**
 * Get the agent registry (for testing/inspection).
 */
export function getAgentRegistry(): Map<string, AgentHandler> {
  return agents;
}
