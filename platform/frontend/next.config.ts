import { withSentryConfig } from "@sentry/nextjs";
import { MCP_CATALOG_API_BASE_URL } from "@shared";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@shared"],
  // Disable dev indicators so they don't show up in docs automated screenshots
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      "@shared/access-control": "../shared/access-control.ts",
    },
  },
  logging: {
    fetches: {
      fullUrl: true,
      hmrRefreshes: true,
    },
    incomingRequests: true,
  },
  experimental: {
    proxyTimeout: 300000, // 5 minutes in milliseconds - prevents SSE stream timeout
  },
  httpAgentOptions: {
    keepAlive: true,
  },
  async rewrites() {
    const backendUrl =
      process.env.ARCHESTRA_API_BASE_URL || "http://localhost:9000";
    return [
      {
        source: "/api/archestra-catalog/:path*",
        destination: `${MCP_CATALOG_API_BASE_URL}/:path*`,
      },
      // /api/auth/* is handled by the API route at app/api/auth/[...path]/route.ts
      // to properly forward the Origin header for SAML SSO callbacks.
      // API routes take precedence over rewrites in Next.js.
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/v1/:path*",
        destination: `${backendUrl}/v1/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
      {
        source: "/ws",
        destination: `${backendUrl}/ws`,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "archestra",

  project: "archestra-platform-frontend",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,

  // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
  // See the following for more information:
  // https://docs.sentry.io/product/crons/
  // https://vercel.com/docs/cron-jobs
  automaticVercelMonitors: true,
});
