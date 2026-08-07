import {
  DEFAULT_FAVICON_PATH,
  getDeploymentFavicon,
} from "@/lib/favicon.server";

const NO_CACHE = "no-store, max-age=0";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const VERSION_QUERY_PARAM = "v";

export const dynamic = "force-dynamic";

/**
 * Serve the deployment favicon at the origin root so every document on the
 * application origin can resolve the same current, content-versioned asset.
 */
export async function GET(request: Request) {
  const favicon = await getDeploymentFavicon();
  if (!favicon.bytes || !favicon.version) {
    return defaultFavicon();
  }
  if (
    new URL(request.url).searchParams.get(VERSION_QUERY_PARAM) !==
    favicon.version
  ) {
    return versionedFavicon(favicon.href);
  }

  return new Response(favicon.bytes, {
    headers: {
      "Cache-Control": IMMUTABLE_CACHE,
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function defaultFavicon() {
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": NO_CACHE,
      Location: DEFAULT_FAVICON_PATH,
    },
  });
}

function versionedFavicon(href: string) {
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": NO_CACHE,
      Location: href,
    },
  });
}
