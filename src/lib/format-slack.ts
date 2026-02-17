import type { CopyVariant } from "./types";

/**
 * Format copy variants into a readable Slack message.
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

  const footer = "\n———————————————————\n_React with a star on your favorite variant._";

  return header + "\n" + blocks.join("\n\n") + footer;
}
