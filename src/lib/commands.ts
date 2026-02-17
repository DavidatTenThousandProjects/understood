import { postMessage } from "./slack";
import { supabase } from "./supabase";
import { formatWelcomeMessage, formatProfileDisplay, formatHelpMessage } from "./format-slack";

/**
 * Parse a command from a message. Returns the command name or null.
 * Two-word commands checked first, then single-word.
 */
export function parseCommand(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (lower === "new setup") return "new_setup";
  const firstWord = lower.split(/\s/)[0];
  if (["setup", "profile", "help"].includes(firstWord)) return firstWord;
  return null;
}

/**
 * Execute a command and reply in a thread under the user's message.
 */
export async function executeCommand(
  command: string,
  userId: string,
  channelId: string,
  messageTs: string
): Promise<void> {
  switch (command) {
    case "setup":
      await handleSetup(userId, channelId, messageTs);
      break;
    case "profile":
      await handleProfile(channelId, messageTs);
      break;
    case "help":
      await postMessage(channelId, formatHelpMessage(), messageTs);
      break;
  }
}

/**
 * Handle the "setup" command.
 * Returns "start_onboarding" if onboarding should begin, or posts a message if profile exists.
 */
async function handleSetup(
  userId: string,
  channelId: string,
  messageTs: string
): Promise<void> {
  // Check if channel already has a voice profile
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("name, tone_description")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (profile) {
    await postMessage(
      channelId,
      `This channel already has a brand profile for *${profile.name}*.\n\n*Tone:* ${profile.tone_description || "Not set"}\n\nYou don't need to run setup again — I'm learning from every message you send. Just share brand context (pricing changes, tone preferences, new taglines) and I'll keep improving.\n\nIf you want to start completely fresh with a new profile, say *new setup*.`,
      messageTs
    );
    return;
  }

  // Check if user is mid-onboarding
  const { data: customer } = await supabase
    .from("customers")
    .select("onboarding_step, onboarding_complete")
    .eq("slack_user_id", userId)
    .single();

  if (customer && !customer.onboarding_complete && customer.onboarding_step > 0) {
    await postMessage(
      channelId,
      "You're already in the middle of setting up. Check the thread where we started and pick up where you left off.",
      messageTs
    );
    return;
  }

  // Signal that onboarding should start — handled by the caller (route.ts)
  // We don't start onboarding here because the caller needs to manage the thread.
  // Instead, we return and let route.ts call startOnboarding.
}

/**
 * Check if the setup command should start onboarding (no existing profile, not mid-onboarding).
 */
export async function shouldStartOnboarding(
  userId: string,
  channelId: string
): Promise<boolean> {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("id")
    .eq("channel_id", channelId)
    .limit(1)
    .single();

  if (profile) return false;

  const { data: customer } = await supabase
    .from("customers")
    .select("onboarding_step, onboarding_complete")
    .eq("slack_user_id", userId)
    .single();

  if (customer && !customer.onboarding_complete && customer.onboarding_step > 0) {
    return false;
  }

  return true;
}

/**
 * Handle the "profile" command — show channel's brand profile.
 */
async function handleProfile(
  channelId: string,
  messageTs: string
): Promise<void> {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!profile) {
    await postMessage(
      channelId,
      "No brand profile set up for this channel yet. Say *setup* to get started.",
      messageTs
    );
    return;
  }

  // Get brand notes count
  const { count } = await supabase
    .from("brand_notes")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId);

  // Get generation count
  const { count: genCount } = await supabase
    .from("generations")
    .select("id", { count: "exact", head: true })
    .eq("slack_channel_id", channelId);

  await postMessage(
    channelId,
    formatProfileDisplay(profile, count || 0, genCount || 0),
    messageTs
  );
}
