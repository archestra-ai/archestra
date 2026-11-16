import config from "@/config";
import { SITE_CHANNEL_PREFIX } from "@/routes/route-paths";
import { SITE_TOKEN_HEADER, signSiteToken } from "./channel-auth";
import { listSites, siteUnavailableReason } from "./registry";

/**
 * A site can't be reached for work sent to it. Carries a 503 `status`, and
 * is deliberately not an `ApiError`, so a caller with alternatives can move
 * on to the next one.
 *
 * @public — for callers that tell an unavailable site apart
 */
export class SiteUnavailableError extends Error {
  readonly status = 503;
  constructor(
    readonly siteName: string,
    reason: string,
  ) {
    super(reason);
    this.name = "SiteUnavailableError";
  }
}

/**
 * POST a JSON body to another site's internal channel, signed with a site
 * token. Resolves with the raw response (any status) for the caller to read,
 * stream or map; rejects with `SiteUnavailableError` when the site is not
 * registered, draining, stale or unreachable. `what` names the work in error
 * messages, e.g. `MCP server "github"`.
 */
export async function postToSite(params: {
  siteName: string;
  /** Below `SITE_CHANNEL_PREFIX`, starting with `/`. */
  path: string;
  body: unknown;
  what: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { siteName, path, what, signal } = params;
  if (siteName === config.site.name)
    throw new Error(`Refusing to send work to this site itself (${siteName})`);
  const site = (await listSites()).get(siteName);
  const unavailable = siteUnavailableReason(site);
  if (!site || unavailable)
    throw new SiteUnavailableError(
      siteName,
      `${what} needs site "${siteName}", which ${unavailable}`,
    );
  const body = JSON.stringify(params.body);
  try {
    return await fetch(`${site.internalUrl}${SITE_CHANNEL_PREFIX}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SITE_TOKEN_HEADER]: signSiteToken({ to: siteName, body }),
      },
      body,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SiteUnavailableError(
      siteName,
      `${what} needs site "${siteName}", which is unreachable at ${site.internalUrl}: ${
        error instanceof Error
          ? ((error.cause as Error | undefined)?.message ?? error.message)
          : String(error)
      }`,
    );
  }
}
