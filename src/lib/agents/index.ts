/**
 * Agent system barrel export.
 *
 * Import this to access the full pipeline:
 * normalize -> route -> dispatch
 */

// Pipeline
export { normalizeEvent, buildFileContext, isSupportedMedia, getMediaType } from "./normalize";
export { routeEvent, classifyFileUploadIntent } from "./router";
export { dispatch, registerAgent } from "./dispatcher";
export { getBrandContext } from "./context";
export { runQualityGate } from "./quality-gate";

// Agents
export { commandAgent } from "./command";
export { welcomeAgent } from "./welcome";
export { brandContextAgent } from "./brand-context";
export { copyGenerationAgent } from "./copy-generation";
export { competitorAnalysisAgent } from "./competitor-analysis";
export { conversationAgent } from "./conversation";
export { onboardingAgent, startOnboardingInThread, isOnboardingThread } from "./onboarding";
export { learningAgent } from "./learning";

// Re-export types
export type {
  EventContext,
  FileContext,
  BrandContext,
  GenerationRecord,
  AgentResult,
  SlackMessage,
  SideEffect,
  AgentName,
  RouteDecision,
  AgentHandler,
  QualityCheckResult,
  QualityIssue,
} from "./types";
