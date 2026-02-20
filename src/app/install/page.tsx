const SCOPES = [
  "chat:write",
  "files:read",
  "channels:history",
  "groups:history",
  "im:history",
  "pins:write",
  "channels:read",
  "groups:read",
].join(",");

const ERROR_MESSAGES: Record<string, string> = {
  denied: "Installation was cancelled.",
  no_code: "Something went wrong — no authorization code received.",
  oauth_failed: "Slack authorization failed. Please try again.",
  db_failed: "Installation succeeded but we couldn't save your workspace. Please try again.",
  unknown: "Something went wrong. Please try again.",
};

export default async function InstallPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const errorKey = params.error;
  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] || ERROR_MESSAGES.unknown : null;

  const clientId = process.env.SLACK_CLIENT_ID || "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://understood.vercel.app";
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;
  const slackUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="max-w-md text-center">
        <h1 className="text-4xl font-bold tracking-tight">Understood</h1>
        <p className="mt-4 text-lg text-gray-400">
          Slack-native AI tools that learn your brand and take action on it.
        </p>
        <p className="mt-2 text-sm text-gray-500">
          Generate ad copy from your videos and images. Analyze competitor ads and turn them into branded briefs. Every interaction makes your brand profile sharper.
        </p>

        <a
          href={slackUrl}
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-base font-semibold text-black transition hover:bg-gray-200"
        >
          <svg width="20" height="20" viewBox="0 0 123 123" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zm6.5 0a12.9 12.9 0 1 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/>
            <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zm0 6.5a12.9 12.9 0 1 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z" fill="#36C5F0"/>
            <path d="M97.2 45.2a12.9 12.9 0 1 1 12.9 12.9H97.2V45.2zm-6.5 0a12.9 12.9 0 1 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/>
            <path d="M77.8 97.2a12.9 12.9 0 1 1-12.9 12.9V97.2h12.9zm0-6.5a12.9 12.9 0 1 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.8z" fill="#ECB22E"/>
          </svg>
          Add to Slack
        </a>

        {errorMessage && (
          <p className="mt-4 text-sm text-red-400">{errorMessage}</p>
        )}

        <p className="mt-12 text-xs text-gray-600">
          After installing, invite @Understood to any channel and say <strong>setup</strong> to start.
        </p>
      </div>
    </div>
  );
}
