import crypto from "crypto";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;

/**
 * Verify that an incoming request is actually from Slack
 * using the signing secret + HMAC-SHA256 signature.
 */
export function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  if (!SIGNING_SECRET) {
    console.error("SLACK_SIGNING_SECRET is not set");
    return false;
  }

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.error("Slack request timestamp too old");
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${body}`;
  const expectedSignature =
    "v0=" +
    crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(sigBaseString)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
