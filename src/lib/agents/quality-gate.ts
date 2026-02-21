/**
 * Quality Gate.
 *
 * Formatting safety net — catches structural artifacts before output hits Slack.
 * Voice-level checks (banned phrases, mandatory phrases, duplicates, truncation)
 * and deeper critique are now handled by the agent loop tools.
 */

import type { VoiceProfile } from "../types";
import type { AgentResult, QualityCheckResult, QualityIssue } from "./types";

/**
 * Run the quality gate on an agent's output.
 * Returns the original result if it passes, or a fixed/flagged version.
 */
export async function runQualityGate(
  result: AgentResult,
  profile: VoiceProfile | null
): Promise<AgentResult> {
  // No profile = no checks to run
  if (!profile) return result;

  // Only check messages that look like copy output (long enough to be substantive)
  const substantiveMessages = result.messages.filter(
    (m) => m.text.length > 200
  );

  if (substantiveMessages.length === 0) return result;

  // Run deterministic checks
  const deterministicResult = runDeterministicChecks(result);

  if (!deterministicResult.passed) {
    // Auto-fix minor issues
    if (deterministicResult.autoFixed && deterministicResult.fixedMessages) {
      return {
        ...result,
        messages: deterministicResult.fixedMessages,
      };
    }

    // Major issues found deterministically — flag but don't block
    console.warn(
      "Quality gate: deterministic issues found:",
      deterministicResult.issues.map((i) => i.description)
    );
  }

  return result;
}

// ─── Deterministic checks ───

function runDeterministicChecks(
  result: AgentResult
): QualityCheckResult {
  const issues: QualityIssue[] = [];
  let autoFixed = false;
  const fixedMessages = [...result.messages];

  for (let i = 0; i < fixedMessages.length; i++) {
    const msg = fixedMessages[i];
    const text = msg.text;

    // Check for JSON artifacts leaked into output
    if (text.includes('{"angle"') || text.includes("[{") || text.includes('"}]')) {
      issues.push({
        severity: "minor",
        description: "JSON artifacts detected in output",
        autoFixable: false,
      });
    }

    // Check for markdown code blocks leaked into output
    if (text.includes("```json") || text.includes("```")) {
      const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "");
      fixedMessages[i] = { ...msg, text: cleaned };
      autoFixed = true;
      issues.push({
        severity: "minor",
        description: "Markdown code blocks removed from output",
        autoFixable: true,
      });
    }

    // Check for unclosed bold markers in Slack formatting
    const boldCount = (text.match(/\*/g) || []).length;
    if (boldCount % 2 !== 0) {
      issues.push({
        severity: "minor",
        description: "Unclosed bold marker detected",
        autoFixable: false,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    autoFixed,
    fixedMessages: autoFixed ? fixedMessages : undefined,
  };
}
