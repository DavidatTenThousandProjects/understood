import { anthropic } from "./anthropic";
import { supabase } from "./supabase";
import type { CopyVariant } from "./types";

/**
 * Generate 4 Meta ad copy variants from a transcript + voice profile.
 */
export async function generateCopy(
  slackUserId: string,
  transcript: string,
  videoFilename: string,
  channelId: string,
  messageTs: string
): Promise<CopyVariant[]> {
  // Get voice profile
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("slack_user_id", slackUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!profile) {
    throw new Error("NO_PROFILE");
  }

  const anglesStr = Array.isArray(profile.value_prop_angles)
    ? profile.value_prop_angles
        .map((a: unknown, i: number) =>
          typeof a === "string" ? `${i + 1}. ${a}` : `${i + 1}. ${JSON.stringify(a)}`
        )
        .join("\n")
    : "1. Cost savings\n2. Time savings\n3. Quality/creativity\n4. Convenience";

  const systemPrompt = `You are an expert Meta Ads copywriter. You deeply understand this business and write in their exact voice.

BUSINESS CONTEXT:
${profile.full_context}

VOICE PROFILE:
- Tone: ${profile.tone_description}
- Headline patterns: ${JSON.stringify(profile.headline_patterns)}
- Description patterns: ${JSON.stringify(profile.description_patterns)}
- Primary text structure: ${JSON.stringify(profile.primary_text_structure)}
- Must include these phrases/terms: ${JSON.stringify(profile.mandatory_phrases)}
- Never use these words: ${JSON.stringify(profile.banned_phrases)}
- CTA style: ${profile.cta_language}

VARIANT ANGLES:
${anglesStr}

RULES:
- Each variant targets a DIFFERENT angle from the list above
- Headline: Short, punchy, under 40 characters
- Description: One sentence restating the offer
- Primary Text: 3-5 short paragraphs following the structure in the voice profile
- Match the tone and patterns EXACTLY
- Return ONLY valid JSON array: [{"angle": "...", "headline": "...", "description": "...", "primary_text": "..."}]
- No markdown, no explanation, just the JSON array`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Write 4 Meta ad copy variants based on this video transcript:\n\n${transcript}`,
      },
    ],
  });

  const responseText =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Parse JSON from response
  const jsonStr = responseText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const variants: CopyVariant[] = JSON.parse(jsonStr);

  // Save to generations table
  await supabase.from("generations").insert({
    slack_user_id: slackUserId,
    voice_profile_id: profile.id,
    video_filename: videoFilename,
    transcript,
    variants,
    slack_channel_id: channelId,
    slack_message_ts: messageTs,
  });

  return variants;
}
