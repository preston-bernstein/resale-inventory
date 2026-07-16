import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // playwright launches a real browser binary at runtime (lib/connectors/
  // playwrightSession.ts) -- it must stay a native Node import in server
  // route handlers rather than get bundled/traced by webpack/turbopack.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
