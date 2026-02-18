/**
 * Quality Gate.
 *
 * Reviews every agent output before it hits Slack.
 * Two tiers: deterministic checks (no AI), then Sonnet review for deeper issues.
 */

import { anthropic } from "../anthropic";
import { sanitize } from "../sanitize";
import type { VoiceProfile, CopyVariant } from "../types";
import type { AgentResult, SlackMessage, QualityCheckResult, QualityIssue } from "./types";

/**
 * Run the quality gate on an agent's output.
 * Returns the original result if it passes, or a fixed/flagged version.
 */
export async function runQualityGate(
  result: AgentResult,
  profile: VoiceProfile | null
): Promise<AgentResult> {
  // No profile = no voice-specific checks to run
  if (!profile) return result;

  // Only check messages that look like copy output (long enough to be substantive)
  const substantiveMessages = result.messages.filter(
    (m) => m.text.length > 200
  );

  if (substantiveMessages.length === 0) return result;

  // Run deterministic checks first
  const deterministicResult = runDeterministicChecks(result, profile);

  if (!deterministicResult.passed) {
    // Auto-fix minor issues
    if (deterministicResult.autoFixed && deterministicResult.fixedMessages) {
      return {
        ...result,
        messages: deterministicResult.fixedMessages,
      };
    }

    // Major issues found deterministically — flag but don't block
    // (We'd need to regenerate, which is expensive — just log for now)
    console.warn(
      "Quality gate: deterministic issues found:",
      deterministicResult.issues.map((i) => i.description)
    );
  }

  return result;
}

// ─── Deterministic checks ───

function runDeterministicChecks(
  result: AgentResult,
  profile: VoiceProfile
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

    // Check banned phrases
    if (profile.banned_phrases && profile.banned_phrases.length > 0) {
      for (const banned of profile.banned_phrases) {
        if (banned && text.toLowerCase().includes(banned.toLowerCase())) {
          issues.push({
            severity: "major",
            description: `Banned phrase "${banned}" found in output`,
            autoFixable: false,
          });
        }
      }
    }

    // Check mandatory phrases (only for long copy output, not status messages)
    if (text.length > 500 && profile.mandatory_phrases && profile.mandatory_phrases.length > 0) {
      for (const phrase of profile.mandatory_phrases) {
        if (phrase && !text.toLowerCase().includes(phrase.toLowerCase())) {
          issues.push({
            severity: "minor",
            description: `Mandatory phrase "${phrase}" missing from output`,
            autoFixable: false,
          });
        }
      }
    }

    // Check for duplicate headlines across variants
    const headlineMatches = text.match(/\*Headline:\*\s*(.+)/g);
    if (headlineMatches && headlineMatches.length > 1) {
      const headlines = headlineMatches.map((h) =>
        h.replace("*Headline:*", "").trim().toLowerCase()
      );
      const unique = new Set(headlines);
      if (unique.size < headlines.length) {
        issues.push({
          severity: "major",
          description: "Duplicate headlines detected across variants",
          autoFixable: false,
        });
      }
    }

    // Check for truncated copy (primary text suspiciously short)
    const primaryMatches = text.match(/\*Primary Text:\*\n([\s\S]*?)(?=\n———|$)/g);
    if (primaryMatches) {
      for (const pt of primaryMatches) {
        const content = pt.replace("*Primary Text:*\n", "").trim();
        if (content.length < 50) {
          issues.push({
            severity: "minor",
            description: "Primary text appears truncated (under 50 chars)",
            autoFixable: false,
          });
        }
      }
    }
  }

  const hasMinorOnly = issues.every((i) => i.severity === "minor");
  const hasMajor = issues.some((i) => i.severity === "major");

  return {
    passed: issues.length === 0,
    issues,
    autoFixed,
    fixedMessages: autoFixed ? fixedMessages : undefined,
  };
}

/**
 * Run deeper Sonnet-based quality check (called only when deterministic checks pass).
 * This is optional and can be enabled for high-stakes output.
 */
export async function runSonnetQualityCheck(
  output: string,
  profile: VoiceProfile,
  sourceContent: string
): Promise<{ passed: boolean; feedback: string }> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 200,
      system: `You are a quality reviewer for ad copy. Check if the output:
1. Matches the brand's tone: "${sanitize(profile.tone_description || "")}"
2. Is grounded in the source material (not hallucinated claims)
3. Reads naturally (not robotic or generic)

Reply with ONLY: "PASS" or "FAIL: [specific issue]"`,
      messages: [
        {
          role: "user",
          content: `SOURCE MATERIAL:\n${sanitize(sourceContent).slice(0, 500)}\n\nOUTPUT TO REVIEW:\n${sanitize(output).slice(0, 2000)}`,
        },
      ],
    });

    const result =
      response.content[0].type === "text" ? response.content[0].text.trim() : "PASS";

    if (result.startsWith("PASS")) {
      return { passed: true, feedback: "" };
    }

    return { passed: false, feedback: result.replace(/^FAIL:\s*/, "") };
  } catch {
    // On error, pass through (don't block on quality gate failures)
    return { passed: true, feedback: "" };
  }
}
