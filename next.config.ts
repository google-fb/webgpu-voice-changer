import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") || "";

const nextConfig: NextConfig = {
  agentRules: false,
  output: "export",
  trailingSlash: true,
  basePath: basePath || undefined,
  images: { unoptimized: true },
  // Allow the dev server to be reached through a Cloudflare quick tunnel
  // (HTTPS is required for WebGPU and microphone access on remote devices).
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
