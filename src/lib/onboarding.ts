import { supabase } from "./supabase";
import { postMessage } from "./slack";
import { sanitize } from "./sanitize";

/**
 * Onboarding questions — works in DMs or in-channel threads.
 *
 * Flow:
 * - Step 0: Not started yet.
 * - Step 1: Welcome sent, waiting for business name.
 * - Steps 2-7: Answering questions one at a time.
 * - Step 8: Collecting copy examples. User says "done" → advance to 9.
 * - Step 9: Voice profile extracted. Onboarding complete.
 */
const QUESTIONS: Record<number, string> = {
  1: "Welcome to Understood! I'm going to learn about your business and your ad copy style so I can write perfectly voiced Meta ad copy from your videos.\n\nLet's get started. *What's your business or product name?*",
  2: "*In one sentence, what do you sell?*",
  3: "*Who is your ideal customer? Describe them.*",
  4: "*What makes you different from competitors?*",
  5: "*What's your price point and offer?* (e.g., $49/mo for unlimited access)",
  6: "*What tone should your ads have?* (e.g., confident, playful, authoritative, casual)",
  7: "Great — now paste any *customer research, testimonials, or reviews* you want me to learn from. If you don't have any, just say \"skip\".",
  8: "Last step: *Paste 5+ examples of ad copy you're happy with.* These can be your own ads, competitor ads you admire, or any copy that represents how you want to sound.\n\nSend as many messages as you need. When you're done, say *\"done\"*.",
};

const STEP_TO_FIELD: Record<number, string> = {
  1: "business_name",
  2: "product_description",
  3: "target_audience",
  4: "differentiator",
  5: "price_and_offer",
  6: "tone_preference",
  7: "customer_research",
};

/**
 * Get or create a customer record for a Slack user.
 */
export async function getOrCreateCustomer(slackUserId: string) {
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

/**
 * Start onboarding in a channel thread.
 * Called when someone uploads a video but has no voice profile.
 * Returns the thread timestamp so replies go in the same thread.
 */
export async function startOnboardingInThread(
  slackUserId: string,
  channelId: string,
  parentTs: string
): Promise<void> {
  const customer = await getOrCreateCustomer(slackUserId);

  // Don't restart if already onboarding or complete
  if (customer.onboarding_step > 0) return;

  // Post welcome as a thread reply
  await postMessage(channelId, QUESTIONS[1], parentTs);

  // Store parentTs as the thread identifier — all replies in a thread share
  // the parent message's ts as their thread_ts.
  await supabase
    .from("customers")
    .update({
      onboarding_step: 1,
      onboarding_channel: channelId,
      onboarding_thread_ts: parentTs,
    })
    .eq("slack_user_id", slackUserId);
}

/**
 * Check if a channel message is part of an active onboarding thread.
 */
export async function isOnboardingThread(
  slackUserId: string,
  channelId: string,
  threadTs: string | undefined
): Promise<boolean> {
  if (!threadTs) return false;

  const { data } = await supabase
    .from("customers")
    .select("onboarding_channel, onboarding_thread_ts, onboarding_complete")
    .eq("slack_user_id", slackUserId)
    .single();

  if (!data || data.onboarding_complete) return false;

  return (
    data.onboarding_channel === channelId &&
    data.onboarding_thread_ts === threadTs
  );
}

/**
 * Handle a message during onboarding.
 * Works in both DMs and channel threads.
 * threadTs is used for channel threads to keep replies in the thread.
 */
export async function handleOnboardingMessage(
  slackUserId: string,
  channelId: string,
  text: string,
  threadTs?: string
): Promise<"handled" | "done" | "not_onboarding"> {
  const customer = await getOrCreateCustomer(slackUserId);

  if (customer.onboarding_complete) {
    return "not_onboarding";
  }

  const step = customer.onboarding_step || 0;

  // Step 0: First DM message. Send welcome. Don't process their text.
  if (step === 0) {
    const result = await postMessage(channelId, QUESTIONS[1], threadTs);

    await supabase
      .from("customers")
      .update({
        onboarding_step: 1,
        onboarding_channel: channelId,
        onboarding_thread_ts: threadTs || result?.ts || null,
      })
      .eq("slack_user_id", slackUserId);

    return "handled";
  }

  // Use the stored thread for replies
  const replyThread = threadTs || customer.onboarding_thread_ts || undefined;

  // Steps 1-7: Save answer and ask next question
  if (step >= 1 && step <= 7) {
    const field = STEP_TO_FIELD[step];
    if (field) {
      const value = text.toLowerCase() === "skip" ? null : sanitize(text);
      await supabase
        .from("customers")
        .update({
          [field]: value,
          onboarding_step: step + 1,
        })
        .eq("slack_user_id", slackUserId);
    }

    const nextQuestion = QUESTIONS[step + 1];
    if (nextQuestion) {
      await postMessage(channelId, nextQuestion, replyThread);
    }
    return "handled";
  }

  // Step 8: Collecting copy examples
  if (step === 8) {
    if (text.toLowerCase().trim() === "done") {
      await supabase
        .from("customers")
        .update({
          onboarding_step: 9,
          onboarding_complete: true,
        })
        .eq("slack_user_id", slackUserId);

      await postMessage(
        channelId,
        "Got it! I'm analyzing your copy examples and building your voice profile. Give me a moment...",
        replyThread
      );
      return "done";
    }

    // Append example
    const { data: fresh } = await supabase
      .from("customers")
      .select("customer_research")
      .eq("slack_user_id", slackUserId)
      .single();

    const existing = fresh?.customer_research || "";
    const separator = existing ? "\n\n---\n\n" : "";

    await supabase
      .from("customers")
      .update({
        customer_research: existing + separator + sanitize(text),
      })
      .eq("slack_user_id", slackUserId);

    return "handled";
  }

  return "not_onboarding";
}

/**
 * Check if a user has completed onboarding.
 */
export async function isOnboarded(slackUserId: string): Promise<boolean> {
  const { data } = await supabase
    .from("customers")
    .select("onboarding_complete")
    .eq("slack_user_id", slackUserId)
    .single();

  return data?.onboarding_complete === true;
}
