import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@shared"],
  devIndicators: {
    position: "bottom-right",
  }
};

export default nextConfig;
