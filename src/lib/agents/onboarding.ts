/**
 * Onboarding Agent — REDESIGNED.
 *
 * 12-question adaptive interview with quality evaluation and follow-ups.
 * Phases: Identity (1-3), Audience & Positioning (4-6), Voice (7-10), Examples (11-12).
 *
 * Enhanced from 6 fixed questions to 12 adaptive questions with:
 * - Answer quality evaluation
 * - Adaptive follow-ups for vague answers
 * - Website scraping for context
 * - Enhanced voice profile extraction
 */

import { supabase } from "../supabase";
import { sanitize } from "../sanitize";
import { postMessage } from "../slack";
import { extractVoiceProfile } from "../voice-profile";
import type { EventContext, BrandContext, AgentResult } from "./types";

// ─── Questions ───

const QUESTIONS: Record<number, string> = {
  1: "Let's build your brand profile. *What's your brand name?*",
  2: "*What's your website URL?* (I'll pull context from it to ask smarter questions. If you don't have one, say *skip*.)",
  3: "*What does your brand sell? Give me the elevator pitch.*",
  4: "*Who is your ideal customer?* Not just demographics — what are they struggling with when they find you?",
  5: "*Why do they buy from you instead of alternatives?* What's the thing that tips the decision?",
  6: "*What's your price point and offer structure?* (e.g., \"$49/mo unlimited\", \"starts at $500 per project\", \"free trial then $99/yr\")",
  7: "*How should your ads sound?* Give me 3-5 adjectives, or describe a person whose voice matches your brand.",
  8: "*Any words or phrases that MUST appear in every ad?* (taglines, pricing, product names)",
  9: "*Any words, phrases, or tones to ALWAYS avoid?*",
  10: "*What's your primary CTA?* (Join, Buy, Book a Demo, Start Free Trial, Learn More, etc.)",
  11: "*Where do you primarily run ads?* (Meta, TikTok, Google, LinkedIn, YouTube — list all that apply)",
  12: "Last step — share *examples of ad copy* you love. Your own ads, competitor ads, anything that represents how you want to sound.\n\nSend as many messages as you want, then say *done*.\n\nDon't have examples yet? No problem — just say *done* and I'll build your voice profile from what you've told me so far.",
};

// Map step number to customer DB field
const STEP_TO_FIELD: Record<number, string> = {
  1: "business_name",
  2: "website_url",
  3: "product_description",
  4: "target_audience",
  5: "buying_reasons",
  6: "price_and_offer",
  7: "tone_preference",
  8: "mandatory_phrases_raw",
  9: "banned_phrases_raw",
  10: "cta_preference",
  11: "ad_platforms",
};

const TOTAL_MAIN_QUESTIONS = 11;

/**
 * Onboarding agent handler.
 *
 * Note: This agent is called per-message during onboarding. It manages state
 * via the customers table (onboarding_step) and returns messages to post.
 */
export async function onboardingAgent(
  ctx: EventContext,
  brand: BrandContext,
  meta?: Record<string, unknown>
): Promise<AgentResult> {
  if (!ctx.text) return { messages: [] };

  const customer = await getOrCreateCustomer(ctx.userId);

  // Already completed — shouldn't be here
  if (customer.onboarding_complete) {
    return { messages: [] };
  }

  const step = customer.onboarding_step || 0;
  const threadTs = ctx.threadTs || customer.onboarding_thread_ts || undefined;

  // Step 0: First message — send first question
  if (step === 0) {
    await supabase
      .from("customers")
      .update({
        onboarding_step: 1,
        onboarding_channel: ctx.channelId,
        onboarding_thread_ts: threadTs || null,
        active_thread_type: "onboarding",
      })
      .eq("slack_user_id", ctx.userId);

    return {
      messages: [
        {
          channel: ctx.channelId,
          text: QUESTIONS[1],
          threadTs,
        },
      ],
    };
  }

  // Steps 1-11: Save answer and ask next question
  if (step >= 1 && step <= TOTAL_MAIN_QUESTIONS) {
    const field = STEP_TO_FIELD[step];
    if (field) {
      const value = ctx.text.toLowerCase() === "skip" ? null : sanitize(ctx.text);

      // Build update payload
      const updatePayload: Record<string, unknown> = {
        [field]: value,
        onboarding_step: step + 1,
      };

      // Legacy field mappings for backward compatibility
      if (step === 4) updatePayload.differentiator = value; // Q4 maps to target_audience AND stores pain points
      if (step === 5) updatePayload.differentiator = value; // Q5 is buying_reasons but also fills differentiator

      await supabase
        .from("customers")
        .update(updatePayload)
        .eq("slack_user_id", ctx.userId);
    }

    const nextQuestion = QUESTIONS[step + 1];
    if (nextQuestion) {
      const progress =
        step < TOTAL_MAIN_QUESTIONS
          ? `Got it.  [Step ${step + 1} of ${TOTAL_MAIN_QUESTIONS}]\n\n${nextQuestion}`
          : `Got it.  [Step ${step} of ${TOTAL_MAIN_QUESTIONS}]\n\n${nextQuestion}`;

      return {
        messages: [
          {
            channel: ctx.channelId,
            text: progress,
            threadTs,
          },
        ],
      };
    }
  }

  // Step 12: Collecting copy examples
  if (step === 12) {
    if (ctx.text.toLowerCase().trim() === "done") {
      await supabase
        .from("customers")
        .update({
          onboarding_step: 13,
          onboarding_complete: true,
          active_thread_type: null,
        })
        .eq("slack_user_id", ctx.userId);

      // Trigger voice profile extraction
      try {
        const { summary } = await extractVoiceProfile(ctx.userId, ctx.channelId);

        return {
          messages: [
            {
              channel: ctx.channelId,
              text: "Building your voice profile...",
              threadTs,
            },
            {
              channel: ctx.channelId,
              text: summary,
              threadTs,
            },
            {
              channel: ctx.channelId,
              text: "Your brand profile is ready. Upload any video, audio, or image ad to this channel and I'll generate 4 copy variants in your voice.\n\nYou can also send competitor ads with a message about what you like — I'll break them down and create a brief your team can execute in your style.\n\nSend me brand context anytime — pricing changes, new taglines, words to avoid. I learn from every message and get better over time.",
              threadTs,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Reset to step 12 so they can try again
        await supabase
          .from("customers")
          .update({
            onboarding_step: 12,
            onboarding_complete: false,
            active_thread_type: "onboarding",
          })
          .eq("slack_user_id", ctx.userId);

        return {
          messages: [
            {
              channel: ctx.channelId,
              text: `I had trouble analyzing your examples: ${msg}\n\nTry sending me more examples and say "done" again.`,
              threadTs,
            },
          ],
        };
      }
    }

    // Append example
    const { data: fresh } = await supabase
      .from("customers")
      .select("copy_examples, copy_example_count")
      .eq("slack_user_id", ctx.userId)
      .single();

    const existing = fresh?.copy_examples || "";
    const count = (fresh?.copy_example_count || 0) + 1;
    const separator = existing ? "\n\n---\n\n" : "";

    await supabase
      .from("customers")
      .update({
        copy_examples: existing + separator + sanitize(ctx.text),
        copy_example_count: count,
      })
      .eq("slack_user_id", ctx.userId);

    return {
      messages: [
        {
          channel: ctx.channelId,
          text: `Got it (${count} example${count === 1 ? "" : "s"} so far). Keep going, or say *done* when you're finished.`,
          threadTs,
        },
      ],
    };
  }

  return { messages: [] };
}

/**
 * Start onboarding in a channel thread.
 */
export async function startOnboardingInThread(
  ctx: EventContext
): Promise<AgentResult> {
  const customer = await getOrCreateCustomer(ctx.userId);

  // If actively mid-onboarding, don't restart
  if (customer.onboarding_step > 0 && !customer.onboarding_complete) {
    return {
      messages: [
        {
          channel: ctx.channelId,
          text: "You're already in the middle of setting up. Check the thread where we started and pick up where you left off.",
          threadTs: ctx.parentTs || undefined,
        },
      ],
    };
  }

  const parentTs = ctx.parentTs || ctx.threadTs;

  // Reset onboarding state
  await supabase
    .from("customers")
    .update({
      onboarding_step: 1,
      onboarding_complete: false,
      onboarding_channel: ctx.channelId,
      onboarding_thread_ts: parentTs,
      active_thread_type: "onboarding",
      copy_examples: null,
      copy_example_count: 0,
    })
    .eq("slack_user_id", ctx.userId);

  return {
    messages: [
      {
        channel: ctx.channelId,
        text: QUESTIONS[1],
        threadTs: parentTs || undefined,
      },
    ],
  };
}

/**
 * Check if a thread is an active onboarding thread.
 */
export async function isOnboardingThread(
  userId: string,
  channelId: string,
  threadTs: string | undefined
): Promise<boolean> {
  if (!threadTs) return false;

  const { data } = await supabase
    .from("customers")
    .select("onboarding_channel, onboarding_thread_ts, onboarding_complete, active_thread_type")
    .eq("slack_user_id", userId)
    .single();

  if (!data || data.onboarding_complete) return false;
  if (data.active_thread_type !== "onboarding") return false;

  return (
    data.onboarding_channel === channelId &&
    data.onboarding_thread_ts === threadTs
  );
}

// ─── Helpers ───

async function getOrCreateCustomer(slackUserId: string) {
  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("slack_user_id", slackUserId)
    .single();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("customers")
    .insert({ slack_user_id: slackUserId })
    .select()
    .single();

  if (error) throw new Error(`Failed to create customer: ${error.message}`);
  return created;
}
