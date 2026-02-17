import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxRetries: 5,
});

/**
 * Check if an error is a transient overload/rate-limit error.
 */
export function isOverloadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("overloaded") ||
    msg.includes("Overloaded") ||
    msg.includes("529") ||
    msg.includes("rate_limit") ||
    msg.includes("429")
  );
}

/**
 * Get a user-friendly error message instead of raw API errors.
 */
export function friendlyError(error: unknown): string {
  if (isOverloadError(error)) {
    return "The AI is temporarily overloaded. Please try uploading again in a minute or two.";
  }
  return "Something went wrong generating your copy. Please try again.";
}
