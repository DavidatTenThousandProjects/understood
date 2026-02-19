/**
 * Event Normalizer.
 *
 * Extracts a clean EventContext from raw Slack payloads.
 * One function, one shape. No AI calls — pure data extraction.
 */

import type { SlackEvent } from "../types";
import type { EventContext, FileContext } from "./types";

const VIDEO_EXTENSIONS = ["mp4", "mp3", "m4a", "wav", "webm", "mov", "ogg", "flac"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];

/**
 * Normalize a raw Slack event into an EventContext.
 * Returns null for events we should ignore (bot's own messages, subtypes, etc.).
 */
export function normalizeEvent(
  event: SlackEvent,
  teamId: string,
  botUserId: string
): EventContext | null {
  // ─── member_joined_channel ───
  if (event.type === "member_joined_channel") {
    return {
      type: "member_joined",
      teamId,
      botUserId,
      userId: event.user,
      channelId: event.channel,
      text: "",
      threadTs: null,
      parentTs: null,
      fileInfo: null,
      isThread: false,
      isDM: false,
      rawEvent: event,
    };
  }

  // ─── file_shared ───
  if (event.type === "file_shared") {
    return {
      type: "file_upload",
      teamId,
      botUserId,
      userId: event.user_id,
      channelId: event.channel_id,
      text: "", // Will be enriched by dispatcher via getMessage()
      threadTs: null,
      parentTs: null,
      fileInfo: null, // Will be enriched by dispatcher via getFileInfo()
      isThread: false,
      isDM: false,
      rawEvent: event,
    };
  }

  // ─── message ───
  if (event.type === "message") {
    // Skip bot messages and subtypes
    if (event.subtype || event.bot_id) return null;

    const isDM = event.channel_type === "im";
    const isThread = !!event.thread_ts;

    return {
      type: "message",
      teamId,
      botUserId,
      userId: event.user,
      channelId: event.channel,
      text: event.text || "",
      threadTs: event.thread_ts || null,
      parentTs: isThread ? event.thread_ts! : event.ts,
      fileInfo: null,
      isThread,
      isDM,
      rawEvent: event,
    };
  }

  return null;
}

/**
 * Determine media type from filename extension.
 */
export function getMediaType(
  filename: string
): "image" | "video" | "audio" | "unknown" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "unknown";
}

/**
 * Check if a file extension is a supported media type.
 */
export function isSupportedMedia(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].includes(ext);
}

/**
 * Build a FileContext from Slack file info.
 */
export function buildFileContext(file: Record<string, unknown>): FileContext {
  const name = (file.name as string) || "unknown";
  return {
    id: file.id as string,
    name,
    mimetype: (file.mimetype as string) || "",
    url: (file.url_private_download as string) || (file.url_private as string) || "",
    size: (file.size as number) || 0,
    mediaType: getMediaType(name),
  };
}
