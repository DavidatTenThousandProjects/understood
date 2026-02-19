import { WebClient } from "@slack/web-api";
import { supabase } from "./supabase";

// ─── In-memory token cache ───

interface CachedWorkspace {
  client: WebClient;
  botUserId: string;
  botToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedWorkspace>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a Slack WebClient for a specific workspace.
 * Uses in-memory cache with 5-min TTL.
 */
export async function getSlackClient(teamId: string): Promise<{
  client: WebClient;
  botUserId: string;
  botToken: string;
}> {
  const now = Date.now();
  const cached = cache.get(teamId);

  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const { data, error } = await supabase
    .from("workspaces")
    .select("bot_token, bot_user_id")
    .eq("team_id", teamId)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(`No workspace found for team_id: ${teamId}`);
  }

  const entry: CachedWorkspace = {
    client: new WebClient(data.bot_token),
    botUserId: data.bot_user_id,
    botToken: data.bot_token,
    expiresAt: now + CACHE_TTL_MS,
  };

  cache.set(teamId, entry);
  return entry;
}

/**
 * Post a message to a Slack channel (or as a thread reply).
 */
export async function postMessage(
  teamId: string,
  channel: string,
  text: string,
  threadTs?: string
) {
  const { client } = await getSlackClient(teamId);
  return client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

/**
 * Update an existing message in Slack.
 */
export async function updateMessage(
  teamId: string,
  channel: string,
  ts: string,
  text: string
) {
  const { client } = await getSlackClient(teamId);
  return client.chat.update({ channel, ts, text });
}

/**
 * Get file info from Slack (includes the download URL).
 */
export async function getFileInfo(teamId: string, fileId: string) {
  const { client } = await getSlackClient(teamId);
  const result = await client.files.info({ file: fileId });
  return result.file;
}

/**
 * Pin a message in a Slack channel.
 */
export async function pinMessage(teamId: string, channel: string, timestamp: string) {
  const { client } = await getSlackClient(teamId);
  return client.pins.add({ channel, timestamp });
}

/**
 * Get a single message by its timestamp from a channel.
 * Used to retrieve the text accompanying a file upload.
 */
export async function getMessage(teamId: string, channel: string, messageTs: string) {
  const { client } = await getSlackClient(teamId);
  const result = await client.conversations.history({
    channel,
    latest: messageTs,
    oldest: messageTs,
    inclusive: true,
    limit: 1,
  });
  return result.messages?.[0];
}

/**
 * Get all replies in a thread.
 */
export async function getThreadReplies(teamId: string, channel: string, threadTs: string) {
  const { client } = await getSlackClient(teamId);
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 100,
  });
  return result.messages || [];
}

/**
 * Download a file from Slack using the workspace's bot token for auth.
 * Returns the file as a Buffer.
 */
export async function downloadFile(teamId: string, url: string): Promise<Buffer> {
  const { botToken } = await getSlackClient(teamId);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
