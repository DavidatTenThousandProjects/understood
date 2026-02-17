import type { CopyVariant } from "./types";

/**
 * Format copy variants into a readable Slack message with feedback instructions.
 */
export function formatVariantsForSlack(
  variants: CopyVariant[],
  filename: string
): string {
  const header = `*4 Ad Copy Variants for ${filename}*\n`;

  const blocks = variants.map((v, i) => {
    return `———————————————————
*Variant ${i + 1}: ${v.angle}*

*Headline:* ${v.headline}
*Description:* ${v.description}

*Primary Text:*
${v.primary_text}`;
  });

  const footer = `\n———————————————————

Want changes? Reply in this thread with feedback — I'll revise and remember for next time.
• Feedback on one variant: _"Variant 2: make it less formal"_
• Feedback on all: _"these are all too salesy"_`;

  return header + "\n" + blocks.join("\n\n") + footer;
}

/**
 * Format the welcome message posted when the bot joins a channel.
 */
export function formatWelcomeMessage(): string {
  return `*Welcome to Understood*

I turn your video ads into perfectly voiced Meta ad copy. Here's how it works:

*Getting started (one time, ~3 minutes):*
Say *setup* and I'll learn about your brand through a quick interview. Once your profile is built, you're ready to go.

*Generating ad copy:*
Upload any video or audio ad to this channel. I'll transcribe it and write 4 copy variants in your brand voice.

*Improving over time:*
Send me anything about your brand — pricing changes, new taglines, tone preferences, words to avoid. I'll remember it all and get better with every interaction.

*Commands:*
• *setup* — Build your brand profile
• *profile* — View your current brand profile
• *help* — See this message again`;
}

/**
 * Format the help message (same as welcome).
 */
export function formatHelpMessage(): string {
  return `*How to use Understood:*

• Upload a video or audio ad → I'll generate 4 copy variants in your brand voice
• Send brand context (pricing, tone, phrases) → I'll remember it for future copy
• Reply to copy with feedback → I'll revise and learn for next time

*Commands:*
• *setup* — Build your brand profile
• *profile* — View your current brand profile
• *help* — See this message`;
}

/**
 * Format the profile display for the "profile" command.
 */
export function formatProfileDisplay(
  profile: Record<string, unknown>,
  notesCount: number,
  generationCount: number
): string {
  const angles = (profile.value_prop_angles as string[]) || [];
  const mandatory = (profile.mandatory_phrases as string[]) || [];
  const banned = (profile.banned_phrases as string[]) || [];

  return `*Brand Profile: ${profile.name}*

*Tone:* ${profile.tone_description}

*Headline Patterns:*
${((profile.headline_patterns as string[]) || []).map((p) => `  - ${p}`).join("\n")}

*Primary Text Structure:*
${((profile.primary_text_structure as string[]) || []).map((p) => `  - ${p}`).join("\n")}

*Always Include:* ${mandatory.join(", ")}
*Never Use:* ${banned.join(", ")}

*CTA Style:* ${profile.cta_language}

*4 Variant Angles:*
${angles.map((a, i) => `  ${i + 1}. ${typeof a === "string" ? a : JSON.stringify(a)}`).join("\n")}

———————————————————
${notesCount} brand note${notesCount === 1 ? "" : "s"} accumulated · ${generationCount} video${generationCount === 1 ? "" : "s"} processed`;
}

/**
 * Format the new team member welcome message with profile overview.
 */
export function formatTeamMemberWelcome(
  profile: Record<string, unknown>
): string {
  return `Welcome! This channel uses Understood to generate ad copy.

*Brand profile: ${profile.name}*
Tone: ${profile.tone_description}

Check the pinned message for how things work. You can upload videos here and I'll generate copy using the brand profile above.`;
}
