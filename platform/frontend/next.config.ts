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
        source: '/api/mcp-registry-proxy',
        destination: 'https://registry.modelcontextprotocol.io/v0.1/servers',
      },
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/v1/:path*',
        destination: `${backendUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
