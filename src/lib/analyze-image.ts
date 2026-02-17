import { anthropic } from "./anthropic";

/**
 * Analyze a static ad image using Claude Vision.
 * Returns a structured description of the ad creative.
 */
export async function analyzeAdImage(
  imageBuffer: Buffer,
  filename: string
): Promise<string> {
  const extension = filename.split(".").pop()?.toLowerCase() || "png";

  type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  const mediaTypeMap: Record<string, ImageMediaType> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };

  const mediaType: ImageMediaType = mediaTypeMap[extension] || "image/png";
  const base64 = imageBuffer.toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          },
          {
            type: "text",
            text: `Analyze this ad creative image in detail. Describe:

1. **Product/Service**: What product or service is being advertised?
2. **Visual Elements**: What's shown — people, product shots, lifestyle imagery, colors, design style?
3. **Text/Copy**: Any text, headlines, taglines, or CTAs visible in the image? Quote them exactly.
4. **Mood/Tone**: What emotional tone does the image convey? (e.g., aspirational, urgent, playful, premium)
5. **Setting/Context**: Where is the scene set? What context surrounds the product?
6. **Target Audience**: Based on the imagery, who is this ad targeting?
7. **Key Message**: What's the core message or value proposition the image communicates?

Be specific and detailed. This description will be used to write matching ad copy.`,
          },
        ],
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  if (!text || text.trim().length === 0) {
    throw new Error("Could not analyze the image.");
  }

  return text;
}
