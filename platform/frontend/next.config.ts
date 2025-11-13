import type { NextConfig } from "next";
import { MCP_CATALOG_API_BASE_URL } from "@shared";

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
  async rewrites() {
    const backendUrl = process.env.ARCHESTRA_API_BASE_URL || 'http://localhost:9000';
    return [
      {
        source: '/api/archestra-catalog/:path*',
        destination: `${MCP_CATALOG_API_BASE_URL}/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/v1/:path*',
        destination: `${backendUrl}/v1/:path*`,
      },
      {
        source: '/health',
        destination: `${backendUrl}/health`,
      }
    ];
  },
};

export default nextConfig;
