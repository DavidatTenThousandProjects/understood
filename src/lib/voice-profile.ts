import { supabase } from "./supabase";
import { anthropic } from "./anthropic";

/**
 * Analyze a customer's business context + copy examples to extract a voice profile.
 * Uses Claude to identify patterns, tone, structure, mandatory phrases, etc.
 */
export async function extractVoiceProfile(slackUserId: string): Promise<{
  profile: Record<string, unknown>;
  summary: string;
}> {
  // Get customer data
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("slack_user_id", slackUserId)
    .single();

  if (!customer) throw new Error("Customer not found");

  const prompt = `You are an expert ad copy analyst. Analyze the following business context and ad copy examples to extract a detailed voice profile.

BUSINESS CONTEXT:
- Business name: ${customer.business_name || "Not provided"}
- Product: ${customer.product_description || "Not provided"}
- Target audience: ${customer.target_audience || "Not provided"}
- Differentiator: ${customer.differentiator || "Not provided"}
- Price/offer: ${customer.price_and_offer || "Not provided"}
- Desired tone: ${customer.tone_preference || "Not provided"}

AD COPY EXAMPLES & RESEARCH:
${customer.customer_research || "No examples provided"}

Analyze these examples carefully and extract:

1. **headline_patterns**: Array of patterns you see in headlines (e.g., "Short fragments: Benefit + Price", "Action + Outcome"). 3-5 patterns.
2. **description_patterns**: Array of patterns in descriptions. 2-3 patterns.
3. **primary_text_structure**: Array describing the flow/structure of primary text (e.g., "Pain hook → Solution intro → Feature stack → Benefit punches → CTA"). 3-5 structural elements.
4. **tone_description**: One paragraph describing the exact tone and voice style.
5. **mandatory_phrases**: Array of phrases, words, or terms that appear consistently and should always be included. 3-8 items.
6. **banned_phrases**: Array of words or phrases that should never be used based on the style. 3-8 items.
7. **value_prop_angles**: Array of 4 distinct value proposition angles to use for variants. Each should be a short label + description.
8. **cta_language**: The call-to-action style/phrasing used.

Return ONLY valid JSON with these exact keys. No markdown, no explanation.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Parse JSON from response (handle potential markdown code blocks)
  const jsonStr = responseText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const profile = JSON.parse(jsonStr);

  // Build the full context string for copy generation
  const fullContext = `BUSINESS: ${customer.business_name}
PRODUCT: ${customer.product_description}
AUDIENCE: ${customer.target_audience}
DIFFERENTIATOR: ${customer.differentiator}
OFFER: ${customer.price_and_offer}

CUSTOMER RESEARCH & EXAMPLES:
${customer.customer_research || "None provided"}`;

  // Save voice profile
  const { error } = await supabase.from("voice_profiles").insert({
    customer_id: customer.id,
    slack_user_id: slackUserId,
    name: customer.business_name || "Default",
    raw_examples: customer.customer_research || "",
    headline_patterns: profile.headline_patterns,
    description_patterns: profile.description_patterns,
    primary_text_structure: profile.primary_text_structure,
    tone_description: profile.tone_description,
    mandatory_phrases: profile.mandatory_phrases,
    banned_phrases: profile.banned_phrases,
    value_prop_angles: profile.value_prop_angles,
    cta_language: profile.cta_language,
    full_context: fullContext,
  });

  if (error) throw new Error(`Failed to save voice profile: ${error.message}`);

  // Build human-readable summary
  const summary = formatProfileSummary(profile, customer.business_name);

  return { profile, summary };
}

function formatProfileSummary(
  profile: Record<string, unknown>,
  businessName: string
): string {
  const angles = (profile.value_prop_angles as string[]) || [];
  const mandatory = (profile.mandatory_phrases as string[]) || [];
  const banned = (profile.banned_phrases as string[]) || [];

  return `*Voice Profile for ${businessName}*

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

_React with a thumbs-up if this looks right, or tell me what to change._`;
}

/**
 * Get the voice profile for a user.
 */
export async function getVoiceProfile(slackUserId: string) {
  const { data } = await supabase
    .from("voice_profiles")
    .select("*")
    .eq("slack_user_id", slackUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data;
}
