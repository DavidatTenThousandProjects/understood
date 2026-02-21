/**
 * Agent pipeline types for Understood.
 *
 * Pipeline: Event Normalizer -> Smart Router -> Agent Dispatcher -> Specialized Agent -> Quality Gate -> Slack
 */

import type { VoiceProfile, CopyVariant, CompetitorAnalysis } from "../types";

// ─── Event Context ───

export interface EventContext {
  type: "message" | "file_upload" | "command" | "member_joined";
  teamId: string;
  botUserId: string;
  userId: string;
  channelId: string;
  text: string;
  threadTs: string | null;
  parentTs: string | null;
  fileInfo: FileContext | null;
  isThread: boolean;
  isDM: boolean;
  rawEvent: unknown;
}

export interface FileContext {
  id: string;
  name: string;
  mimetype: string;
  url: string;
  size: number;
  mediaType: "image" | "video" | "audio" | "unknown";
}

// ─── Brand Context ───

export interface BrandContext {
  profile: VoiceProfile | null;
  brandNotes: string;
  threadHistory: string | null;
  generation: GenerationRecord | null;
  learnings: string | null;
  exemplars: ExemplarRecord[] | null;
  channelMaturity: "new" | "onboarding" | "active";
}

export interface GenerationRecord {
  id: string;
  slackUserId: string;
  voiceProfileId: string;
  videoFilename: string;
  transcript: string;
  variants: CopyVariant[] | CompetitorAnalysis[];
  slackChannelId: string;
  slackMessageTs: string;
  sourceType: "video" | "image" | "competitor_analysis" | "pending";
  createdAt: string;
}

// ─── Agent Result ───

export interface SlackMessage {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SideEffect {
  type:
    | "add_brand_note"
    | "save_generation"
    | "update_profile"
    | "update_customer"
    | "save_copy_feedback"
    | "save_exemplar"
    | "update_generation_meta";
  payload: Record<string, unknown>;
}

export interface AgentResult {
  messages: SlackMessage[];
  sideEffects?: SideEffect[];
  triggerLearning?: boolean;
}

// ─── Router ───

export type AgentName =
  | "welcome"
  | "command"
  | "onboarding"
  | "copy_generation"
  | "competitor_analysis"
  | "conversation"
  | "brand_context"
  | "learning";

export interface RouteDecision {
  agent: AgentName;
  /** Extra metadata the router passes to the dispatcher */
  meta?: Record<string, unknown>;
}

// ─── Quality Gate ───

export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
  autoFixed: boolean;
  fixedMessages?: SlackMessage[];
}

export interface QualityIssue {
  severity: "minor" | "major";
  description: string;
  autoFixable: boolean;
}

// ─── Agent Handler ───

export type AgentHandler = (
  ctx: EventContext,
  brand: BrandContext,
  meta?: Record<string, unknown>
) => Promise<AgentResult>;

// ─── Copy Feedback ───

export interface CopyFeedbackRecord {
  id: string;
  teamId: string;
  channelId: string;
  generationId: string;
  variantNumber: number | null;
  action: "approved" | "revised" | "rejected" | "clarification";
  feedbackText: string | null;
  originalVariant: CopyVariant | null;
  revisedVariant: CopyVariant | null;
  approvalReason: string | null;
  slackUserId: string;
  createdAt: string;
}

// ─── Exemplars ───

export interface ExemplarRecord {
  id: string;
  teamId: string;
  channelId: string;
  generationId: string;
  voiceProfileId: string;
  variant: CopyVariant;
  sourceType: "video" | "image";
  approvalReason: string | null;
  sourceTranscriptSnippet: string | null;
  score: number;
  active: boolean;
  createdAt: string;
}

// ─── Agent Loop ───

export interface AgentLoopState {
  variants: CopyVariant[];
  turns: number;
  startTime: number;
  qualityIssues: string[];
  reviewPassed: boolean;
}

// ─── Agent Tool Definitions ───

export interface SubmitVariantInput {
  angle: string;
  headline: string;
  description: string;
  primary_text: string;
}

export interface ReviewSetInput {
  confirm: boolean;
}

export interface FetchExemplarsInput {
  count?: number;
}

export interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}
