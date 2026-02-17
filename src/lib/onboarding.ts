import { supabase } from "./supabase";
import { postMessage } from "./slack";
import { sanitize } from "./sanitize";

/**
 * Onboarding questions asked one-at-a-time via DM.
 * Step 0 = welcome, steps 1-7 = questions, step 8 = collecting examples, step 9 = done.
 */
const QUESTIONS: Record<number, string> = {
  0: "Welcome to Understood! I'm going to learn about your business and your ad copy style so I can write perfectly voiced Meta ad copy from your videos.\n\nLet's get started. *What's your business or product name?*",
  1: "*In one sentence, what do you sell?*",
  2: "*Who is your ideal customer? Describe them.*",
  3: "*What makes you different from competitors?*",
  4: "*What's your price point and offer?* (e.g., $49/mo for unlimited access)",
  5: "*What tone should your ads have?* (e.g., confident, playful, authoritative, casual)",
  6: "Great — now paste any *customer research, testimonials, or reviews* you want me to learn from. If you don't have any, just say \"skip\".",
  7: "Last step: *Paste 5+ examples of ad copy you're happy with.* These can be your own ads, competitor ads you admire, or any copy that represents how you want to sound.\n\nSend as many messages as you need. When you're done, say *\"done\"*.",
};

// Maps onboarding step to the database column it saves to
const STEP_TO_FIELD: Record<number, string> = {
  0: "business_name",
  1: "product_description",
  2: "target_audience",
  3: "differentiator",
  4: "price_and_offer",
  5: "tone_preference",
  6: "customer_research",
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
 * Handle a DM message during onboarding.
 * Returns true if the message was handled (part of onboarding), false if onboarding is complete.
 */
export async function handleOnboardingMessage(
  slackUserId: string,
  channelId: string,
  text: string
): Promise<boolean> {
  const customer = await getOrCreateCustomer(slackUserId);

  // Already onboarded
  if (customer.onboarding_complete) {
    return false;
  }

  const step = customer.onboarding_step || 0;

  // Step 0: This is the first interaction — send welcome and first question
  if (step === 0 && !customer.business_name) {
    // Check if this is their first ever message (no business_name saved yet)
    // Save their answer as business_name and advance
    await supabase
      .from("customers")
      .update({
        business_name: sanitize(text),
        onboarding_step: 1,
      })
      .eq("slack_user_id", slackUserId);

    await postMessage(channelId, QUESTIONS[1]);
    return true;
  }

  // Steps 1-6: Save answer and ask next question
  if (step >= 1 && step <= 6) {
    const field = STEP_TO_FIELD[step];
    const value = text.toLowerCase() === "skip" ? null : sanitize(text);

    await supabase
      .from("customers")
      .update({
        [field]: value,
        onboarding_step: step + 1,
      })
      .eq("slack_user_id", slackUserId);

    await postMessage(channelId, QUESTIONS[step + 1]);
    return true;
  }

  // Step 7: Collecting copy examples (multi-message)
  if (step === 7) {
    if (text.toLowerCase().trim() === "done") {
      // Finished collecting examples
      await supabase
        .from("customers")
        .update({
          onboarding_step: 8,
          onboarding_complete: true,
        })
        .eq("slack_user_id", slackUserId);

      await postMessage(
        channelId,
        "Got it! I'm analyzing your copy examples and building your voice profile. Give me a moment..."
      );
      return true; // The caller should trigger voice profile extraction
    }

    // Append to customer_research as examples (sanitized)
    const existingExamples = customer.customer_research || "";
    const separator = existingExamples ? "\n\n---\n\n" : "";

    await supabase
      .from("customers")
      .update({
        customer_research:
          existingExamples + separator + sanitize(text),
      })
      .eq("slack_user_id", slackUserId);

    // Don't send a message for each example — just collect silently
    return true;
  }

  return false;
}

/**
 * Start onboarding for a new user by sending the welcome message.
 */
export async function startOnboarding(
  slackUserId: string,
  channelId: string
): Promise<void> {
  await getOrCreateCustomer(slackUserId);
  await postMessage(channelId, QUESTIONS[0]);
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
