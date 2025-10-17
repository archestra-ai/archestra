import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@shared"],
  devIndicators: {
    position: "bottom-right",
  },
  logging: {
    fetches: {
      fullUrl: true,
    },
    incomingRequests: true
  },
};

export default nextConfig;
