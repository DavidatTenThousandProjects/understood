import { supabase } from "./supabase";
import { postMessage } from "./slack";
import { sanitize } from "./sanitize";

/**
 * Onboarding questions — works in DMs or in-channel threads.
 *
 * Flow:
 * - Step 0: Not started yet.
 * - Step 1: Welcome sent, waiting for business name.
 * - Steps 2-6: Answering questions one at a time.
 * - Step 7: Collecting copy examples. User says "done" → advance to 8.
 * - Step 8: Voice profile extracted. Onboarding complete.
 */

const QUESTIONS: Record<number, string> = {
  1: "Let's build your brand profile. *What's your business name?*",
  2: "*In one sentence, what do you sell?*",
  3: "*Who's your ideal customer?*",
  4: "*What makes you different from competitors?*",
  5: "*What's your price point and offer?* (e.g., $49/mo for unlimited access)",
  6: "*What tone should your ads have?* (e.g., confident, playful, authoritative, casual)",
  7: "Last step — paste *examples of ad copy* you like. These can be your own ads, competitor ads you admire, or any copy that represents how you want to sound.\n\nSend as many messages as you want, then say *done*.\n\nDon't have examples yet? No problem — just say *done* and I'll build your voice profile from what you've told me so far. You can always improve it later.",
};

const STEP_TO_FIELD: Record<number, string> = {
  1: "business_name",
  2: "product_description",
  3: "target_audience",
  4: "differentiator",
  5: "price_and_offer",
  6: "tone_preference",
};

const TOTAL_QUESTIONS = 6;
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
 * Called when someone says "setup" in a channel.
 */
export async function startOnboardingInThread(
  slackUserId: string,
  channelId: string,
  parentTs: string
): Promise<void> {
  const customer = await getOrCreateCustomer(slackUserId);

  // Don't restart if already onboarding or complete
  if (customer.onboarding_step > 0) return;

  // Post first question as a thread reply
  await postMessage(channelId, QUESTIONS[1], parentTs);

  await supabase
    .from("customers")
    .update({
      onboarding_step: 1,
      onboarding_channel: channelId,
      onboarding_thread_ts: parentTs,
      active_thread_type: "onboarding",
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
    .select("onboarding_channel, onboarding_thread_ts, onboarding_complete, active_thread_type")
    .eq("slack_user_id", slackUserId)
    .single();

  if (!data || data.onboarding_complete) return false;
  if (data.active_thread_type !== "onboarding") return false;

  return (
    data.onboarding_channel === channelId &&
    data.onboarding_thread_ts === threadTs
  );
}

/**
 * Handle a message during onboarding.
 * Works in both DMs and channel threads.
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
        active_thread_type: "onboarding",
      })
      .eq("slack_user_id", slackUserId);

    return "handled";
  }

  // Use the stored thread for replies
  const replyThread = threadTs || customer.onboarding_thread_ts || undefined;

  // Steps 1-6: Save answer and ask next question with progress
  if (step >= 1 && step <= TOTAL_QUESTIONS) {
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
      // Add progress indicator for steps 1-6
      const progress = step < TOTAL_QUESTIONS
        ? `Got it.  [Step ${step + 1} of ${TOTAL_QUESTIONS}]\n\n${nextQuestion}`
        : `Got it.  [Step ${step} of ${TOTAL_QUESTIONS}]\n\n${nextQuestion}`;
      await postMessage(channelId, progress, replyThread);
    }
    return "handled";
  }

  // Step 7: Collecting copy examples
  if (step === 7) {
    if (text.toLowerCase().trim() === "done") {
      await supabase
        .from("customers")
        .update({
          onboarding_step: 8,
          onboarding_complete: true,
          active_thread_type: null,
        })
        .eq("slack_user_id", slackUserId);

      await postMessage(
        channelId,
        "Building your voice profile...",
        replyThread
      );
      return "done";
    }

    // Append example to copy_examples
    const { data: fresh } = await supabase
      .from("customers")
      .select("copy_examples, copy_example_count")
      .eq("slack_user_id", slackUserId)
      .single();

    const existing = fresh?.copy_examples || "";
    const count = (fresh?.copy_example_count || 0) + 1;
    const separator = existing ? "\n\n---\n\n" : "";

    await supabase
      .from("customers")
      .update({
        copy_examples: existing + separator + sanitize(text),
        copy_example_count: count,
      })
      .eq("slack_user_id", slackUserId);

    await postMessage(
      channelId,
      `Got it (${count} example${count === 1 ? "" : "s"} so far). Keep going, or say *done* when you're finished.`,
      replyThread
    );

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
