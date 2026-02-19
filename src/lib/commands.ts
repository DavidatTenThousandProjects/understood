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
