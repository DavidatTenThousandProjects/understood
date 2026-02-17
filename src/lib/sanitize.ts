/**
 * Sanitize user input before it enters an LLM prompt.
 *
 * Strategy: wrap in delimiters + strip common injection patterns.
 * We don't over-strip (users need to paste real ad copy which may
 * contain varied punctuation), but we neutralize known attack vectors.
 */

// Patterns commonly used in prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
  /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
  /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /new\s+instructions?:/gi,
  /system\s*prompt:/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<<\s*SYS\s*>>/gi,
  /<<\s*\/SYS\s*>>/gi,
];

/**
 * Sanitize a single user input string.
 * Strips known injection patterns but preserves normal ad copy text.
 */
export function sanitize(input: string): string {
  if (!input) return "";

  let cleaned = input;

  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[removed]");
  }

  // Limit length to prevent token stuffing (generous limit for copy examples)
  if (cleaned.length > 10000) {
    cleaned = cleaned.slice(0, 10000) + "\n[truncated — input too long]";
  }

  return cleaned.trim();
}

/**
 * Wrap user content in XML delimiters for clear boundary separation
 * in LLM prompts. This makes it harder for injected text to break
 * out of the data context.
 */
export function wrapUserContent(label: string, content: string): string {
  const sanitized = sanitize(content);
  return `<user_${label}>\n${sanitized}\n</user_${label}>`;
}
