// Slack event types for the events API

export interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  token: string;
  team_id: string;
  event: SlackEvent;
  event_id: string;
  event_time: number;
}

export type SlackEvent =
  | SlackFileSharedEvent
  | SlackMessageEvent
  | SlackMemberJoinedEvent;

export interface SlackFileSharedEvent {
  type: "file_shared";
  file_id: string;
  user_id: string;
  channel_id: string;
  event_ts: string;
}

export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  bot_id?: string;
  text: string;
  user: string;
  channel: string;
  channel_type: "im" | "channel" | "group";
  thread_ts?: string;
  ts: string;
  event_ts: string;
}

export interface SlackMemberJoinedEvent {
  type: "member_joined_channel";
  user: string;
  channel: string;
  channel_type: "C" | "G";
  team: string;
  event_ts: string;
  inviter?: string;
}

export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download: string;
  url_private: string;
  channels: string[];
  user: string;
  timestamp: number;
}

// Copy generation types (for Phase 2, defined now for completeness)

export interface CopyVariant {
  angle: string;
  headline: string;
  description: string;
  primary_text: string;
}

export interface VoiceProfile {
  id: string;
  customer_id: string;
  slack_user_id: string;
  channel_id?: string;
  name: string;
  headline_patterns: string[];
  description_patterns: string[];
  primary_text_structure: string[];
  tone_description: string;
  mandatory_phrases: string[];
  banned_phrases: string[];
  value_prop_angles: string[];
  cta_language: string;
  full_context: string;
}

export interface CompetitorAnalysis {
  what_works: string;
  your_brief: string;
  copy_direction: string;
}
