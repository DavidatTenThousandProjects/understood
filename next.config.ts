import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/slack/events": ["./node_modules/ffmpeg-static/**/*"],
  },
};

export default nextConfig;
