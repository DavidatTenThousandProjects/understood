import type { CopyVariant, CompetitorAnalysis } from "./types";

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

I turn your ad creatives into perfectly voiced Meta ad copy — and I can analyze competitor ads to help you make your own version. Here's how to get started:

*Step 1: Build your brand profile (~3 minutes)*
Say *setup* and I'll learn about your brand through a quick interview. This is the first thing you need to do before I can work with you.

*Step 2: Upload your creatives for ad copy*
Upload any video, audio, or image ad to this channel. I'll analyze it and write 4 copy variants in your brand voice.

*Step 3: Send competitor ads for creative briefs*
See an ad you love? Drop a screenshot or screen recording with a message about what you like — _"Love the visual style, how would we do this?"_ — and I'll break down why it works and give your team a production-ready creative brief.

*Step 4: Keep improving*
Send me brand context anytime — pricing changes, new taglines, tone preferences, words to avoid. I learn from every message and get better over time.

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

• Upload your ad creative → I'll generate 4 copy variants in your brand voice
• Upload a competitor ad + a message about what you like → I'll break it down and create a production brief your team can execute
• Send brand context (pricing, tone, phrases) → I'll remember it for future copy
• Reply to any output with feedback → I'll revise and learn for next time

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
 * Format a competitor analysis result for Slack.
 */
export function formatCompetitorAnalysisForSlack(
  analysis: CompetitorAnalysis,
  filename: string
): string {
  let output = `*Competitor Ad Analysis — ${filename}*\n\n`;

  output += `*What Makes This Ad Work*\n${analysis.what_works}\n\n`;
  output += `———————————————————\n\n`;
  output += `*Your Brief*\n${analysis.your_brief}\n\n`;
  output += `———————————————————\n\n`;
  output += `*Copy Direction*\n${analysis.copy_direction}\n\n`;
  output += `———————————————————\n\n`;
  output += `Want changes? Reply in this thread with feedback — tell me what to adjust and I'll revise the brief.`;

  return output;
}

/**
 * Format the "new capability" announcement for existing channels.
 */
export function formatNewCapabilityAnnouncement(): string {
  return `*New Capability*

I can now analyze competitor ads and turn them into a creative brief for your brand.

Drop a screenshot, screen recording, or image of any ad that catches your eye, and tell me what you like (or don't like) about it. I'll break down why it works and give you a production-ready brief your team can execute — in your voice, with your brand.

Just upload the ad with a message like: _"Love the visual style here — how would we do something like this?"_`;
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
