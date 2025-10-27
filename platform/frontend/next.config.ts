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
  async rewrites() {
    const backendUrl = process.env.ARCHESTRA_API_BASE_URL || 'http://localhost:9000';
    return [
      {
        source: '/api/archestra-catalog/:path*',
        destination: 'https://www.archestra.ai/mcp-catalog/api/:path*',
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
