import { WebClient } from "@slack/web-api";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

export const slackClient = new WebClient(BOT_TOKEN);

/**
 * Post a message to a Slack channel (or as a thread reply).
 */
export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string
) {
  return slackClient.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

/**
 * Get file info from Slack (includes the download URL).
 */
export async function getFileInfo(fileId: string) {
  const result = await slackClient.files.info({ file: fileId });
  return result.file;
}

/**
 * Pin a message in a Slack channel.
 */
export async function pinMessage(channel: string, timestamp: string) {
  return slackClient.pins.add({ channel, timestamp });
}

/**
 * Download a file from Slack using the bot token for auth.
 * Returns the file as a Buffer.
 */
export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
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
