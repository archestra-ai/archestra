/**
 * The wire contract between the web tier and the dedicated render service (see
 * app-recording-render-client and startRenderer). One module so the client that
 * calls the service and the service that answers cannot drift on a header name
 * or a path.
 *
 * Internal only: these endpoints are reached over the in-cluster Service, never
 * exposed, and carry no session — the web tier authenticates the user and
 * forwards their id, and the service enforces per-render ownership from it.
 */

/** Base path of the render service's internal endpoints. */
export const INTERNAL_RENDER_BASE = "/internal/app-recordings/render";

/** Carries the authenticated user id from the web tier to the render service. */
export const RENDER_USER_ID_HEADER = "x-archestra-user-id";

/** Carries the download file name back from the render service, url-encoded. */
export const RENDER_FILENAME_HEADER = "x-archestra-render-filename";

/**
 * Body-size ceiling for a render request, on BOTH hops — the public
 * `POST /api/app-recordings/render` and the internal service POST it proxies
 * to. A recording bundle is a whole client-captured session (its frames ride
 * along as data URIs), routinely far larger than the general API body limit, so
 * the render routes raise it well past that default. One shared value so the
 * two hops cannot disagree — a bundle the web tier accepts must not then bounce
 * off the render service. Bounded, not unlimited: the single render pod buffers
 * the whole body, parses it, and drives a browser with it, so this is coupled
 * to the renderer's memory (see the renderer Deployment's limits) — raise the
 * two together if longer sessions need it.
 */
export const RENDER_BUNDLE_BODY_LIMIT_BYTES = 512 * 1024 * 1024;
