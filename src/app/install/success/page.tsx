export default function SuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="max-w-md text-center">
        <div className="mb-6 text-5xl">&#10003;</div>
        <h1 className="text-3xl font-bold tracking-tight">
          Understood is installed
        </h1>
        <p className="mt-4 text-lg text-gray-400">
          Go to any channel in your Slack workspace, invite{" "}
          <strong>@Understood</strong>, and say <strong>setup</strong> to get
          started.
        </p>
        <div className="mt-8 rounded-lg border border-gray-800 bg-gray-900 p-6 text-left text-sm text-gray-300">
          <p className="font-semibold text-white">Quick start:</p>
          <ol className="mt-3 list-inside list-decimal space-y-2">
            <li>Open a channel in Slack</li>
            <li>
              Type <code className="rounded bg-gray-800 px-1">/invite @Understood</code>
            </li>
            <li>
              Say <code className="rounded bg-gray-800 px-1">setup</code> — takes about 3 minutes
            </li>
            <li>Upload any video, audio, or image ad to generate copy</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
