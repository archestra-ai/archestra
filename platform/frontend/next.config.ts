import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCP_CATALOG_API_BASE_URL,
  OAUTH_ISSUER_ROOT_ALIASES,
} from "@archestra/shared";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const platformPkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
) as { name: string; version: string };

const nextConfig: NextConfig = {
  allowedDevOrigins: getAllowedDevOrigins(),
  env: {
    NEXT_PUBLIC_APP_VERSION: platformPkg.version,
  },
  // Lets a second `next dev` (e.g. the Playwright MSW server on :3010) run
  // alongside the main one without colliding on `.next/dev/lock`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // Version skew protection during rolling deployments.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId
  // VERSION is set as a build arg by CI and baked into the
  // client bundle here. On client navigation, a mismatch between
  // the client's deployment id and the server's response header triggers a
  // hard reload, fetching fresh assets that match the server build.
  // Next.js restricts the id to [a-zA-Z0-9_-], so non-conforming characters
  // (e.g. the dots in `v1.2.41`) are replaced with hyphens.
  // https://nextjs.org/docs/messages/deploymentid-invalid-characters
  deploymentId: process.env.VERSION?.replace(/[^a-zA-Z0-9_-]/g, "-"),
  transpilePackages: ["@archestra/shared"],
  // Disable dev indicators so they don't show up in docs automated screenshots
  devIndicators: false,
  turbopack: {
    // pin the workspace root (where pnpm-lock.yaml lives) so Next.js 16 doesn't
    // misinfer it in this monorepo and panic with "Next.js package not found"
    // when following pnpm's hoisted next symlink.
    root: resolve(import.meta.dirname, ".."),
    resolveAlias: {
      "@archestra/shared/access-control": "../shared/access-control.ts",
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
    // Next defaults the proxy body limit to 10MB; raise it well above the
    // backend's 70MB default so an operator who increases ARCHESTRA_API_BODY_LIMIT
    // at runtime doesn't also have to rebuild the FE image. (next.config.ts is
    // evaluated at build time in `output: "standalone"` mode, so this value is
    // baked into the image — making it env-driven would silently drift from
    // the backend's runtime value.) Anything the proxy lets through still gets
    // sized-checked by the backend's bodyLimit, which is the authoritative cap.
    proxyClientMaxBodySize: "200mb",
    // React <ViewTransition> integration (animates the new-chat → conversation
    // handoff; see src/lib/view-transition.tsx). Browsers without the View
    // Transitions API just skip the animation.
    viewTransition: true,
  },
  httpAgentOptions: {
    keepAlive: true,
  },
  async redirects() {
    // Permanent redirects for routes renamed in the model-providers / skills /
    // messaging-channels restructure, so existing bookmarks and links don't 404.
    // `:path*` matches the bare path and any sub-path.
    return [
      {
        source: "/agents/skills/:path*",
        destination: "/skills/:path*",
        permanent: true,
      },
      {
        source: "/agents/triggers/:path*",
        destination: "/messaging-channels/:path*",
        permanent: true,
      },
      {
        source: "/llm/model-providers/api-keys",
        destination: "/llm/model-providers",
        permanent: true,
      },
      {
        source: "/llm/model-providers/models",
        destination: "/llm/models",
        permanent: true,
      },
      // The external app standalone surface moved under the chrome-less /a
      // namespace (next to the owned /a/[appId]). Run links are meant to be
      // shared (mcp-apps.md FR-31), so the old URL keeps working; the
      // install/resource query params pass through automatically.
      {
        source: "/apps/catalog/:catalogId/run",
        destination: "/a/catalog/:catalogId",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    const backendUrl =
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";
    return [
      {
        source: "/api/archestra-catalog/:path*",
        destination: `${MCP_CATALOG_API_BASE_URL}/:path*`,
      },
      // Issuer-root aliases for the OAuth endpoints (see OAUTH_ISSUER_ROOT_ALIASES).
      // MCP clients that skip RFC 8414 metadata discovery (e.g. a manual
      // "bring your own credentials" setup) hit the conventional issuer-relative
      // paths — /authorize, /token, /register — at the public origin. We serve
      // the real endpoints under /api/auth/oauth2/*, so rewrite each alias onto
      // its canonical path. An internal rewrite (not a redirect) keeps the
      // request method, body, and query intact and routes it through the
      // existing app/api/auth/[...path] handler, so a non-discovering client's
      // POST to /token or /register works without depending on redirect-follow.
      ...OAUTH_ISSUER_ROOT_ALIASES.map(({ root, canonical }) => ({
        source: root,
        destination: canonical,
      })),
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
        source: "/.well-known/:path*",
        destination: `${backendUrl}/.well-known/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
      {
        source: "/_sandbox/:path*",
        destination: `${backendUrl}/_sandbox/:path*`,
      },
      {
        source: "/skills/m/:path*",
        destination: `${backendUrl}/skills/m/:path*`,
      },
      {
        source: "/ws",
        destination: `${backendUrl}/ws`,
      },
    ];
  },
};

function getAllowedDevOrigins(): string[] {
  return [
    process.env.ARCHESTRA_FRONTEND_URL,
    process.env.ARCHESTRA_NGROK_DOMAIN,
  ]
    .filter((value): value is string => !!value)
    .map((value) => {
      try {
        return new URL(value).host;
      } catch {
        return value;
      }
    });
}

const sentryWebpackOptions = {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "archestra",

  project: "archestra-platform-frontend",

  // The archestra Sentry org is hosted in the EU region
  sentryUrl: "https://de.sentry.io/",

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
};

export default process.env.NODE_ENV === "development"
  ? nextConfig
  : withSentryConfig(nextConfig, sentryWebpackOptions);
