import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev "N" badge defaults to bottom-left, on top of the SideRail's
  // New button; keep it out of the way.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
