import config from "@/config";
import { SITE_CHANNEL_PREFIX } from "@/routes/route-paths";
import { SITE_TOKEN_HEADER, signSiteToken } from "./channel-auth";
import { listSites, siteUnavailableReason } from "./registry";

/**
 * A site can't be reached for relayed work. Carries a 503 `status` so a model
 * pool moves on to its next member and a direct request gets a clear answer.
 * Deliberately not an `ApiError`: those mean "don't fail over".
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
 * messages, e.g. `Provider key "Vertex AI (Gemini)"`.
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
    throw new Error(`Refusing to relay to this site itself (${siteName})`);
  const site = (await listSites()).get(siteName);
  const unavailable = siteUnavailableReason(site);
  if (!site || unavailable)
    throw new SiteUnavailableError(
      siteName,
      `${what} is served by site "${siteName}", which ${unavailable}`,
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
      `${what} is served by site "${siteName}", which is unreachable at ${site.internalUrl}: ${
        error instanceof Error
          ? ((error.cause as Error | undefined)?.message ?? error.message)
          : String(error)
      }`,
    );
  }
}

/** The `data:` payloads of a server-sent event stream, parsed as JSON. */
export async function* readSseJson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
      end = buffer.indexOf("\n\n");
    }
  }
}
