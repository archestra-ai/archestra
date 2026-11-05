import logger from "@/logging";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { ApiError } from "@/types";

/** One request to GitHub's REST API, bounded by a 15 s timeout unless `signal` says otherwise. */
type GithubRequest = {
  url: string;
  /** Sent as a bearer token whenever defined, even when empty. */
  token?: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH";
  body?: object;
  accept?: "application/vnd.github+json" | "application/vnd.github.raw+json";
  apiVersion?: boolean;
  signal?: AbortSignal;
};

/** Turns a failed GitHub response into the error the operation reports. */
export type GithubErrorPolicy = (response: Response) => Promise<ApiError>;

export function githubFetch(request: GithubRequest): Promise<Response> {
  return fetch(request.url, {
    method: request.method ?? "GET",
    headers: {
      Accept: request.accept ?? "application/vnd.github+json",
      ...(request.token !== undefined
        ? { Authorization: `Bearer ${request.token}` }
        : {}),
      ...(request.apiVersion ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
      ...(request.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    redirect: "error",
    signal: request.signal ?? AbortSignal.timeout(15_000),
  });
}

/** A JSON response of at most 2 MiB; transport and parse failures are 502s. */
export async function githubJson<T = unknown>(
  request: GithubRequest & { errors: GithubErrorPolicy },
): Promise<T> {
  let response: Response;
  try {
    response = await githubFetch(request);
  } catch (err) {
    logger.warn({ err }, "OpenAPPA could not reach GitHub");
    throw new ApiError(502, "Could not reach GitHub");
  }
  if (!response.ok) throw await request.errors(response);
  const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
  if (!bytes) throw new ApiError(502, "GitHub response is too large");
  try {
    return JSON.parse(bytes.toString()) as T;
  } catch {
    throw new ApiError(502, "GitHub returned an invalid response");
  }
}

/** A policy that also sees GitHub's own error message, read from at most 4 KiB. */
export function withGithubMessage(
  map: (status: number, message?: string) => ApiError,
): GithubErrorPolicy {
  return async (response) => {
    const body = await readResponseBodyWithLimit(response, 4096);
    let message: string | undefined;
    if (body)
      try {
        const parsed = JSON.parse(body.toString()) as { message?: unknown };
        if (typeof parsed.message === "string")
          message = parsed.message.slice(0, 200);
      } catch {
        // GitHub does not always return JSON for upstream failures.
      }
    return map(response.status, message);
  };
}

/** Sync setup: a 422 (name taken, not yet readable) is a conflict to retry or recover. */
export const githubSyncErrors = withGithubMessage(
  (status) =>
    new ApiError(
      status === 422 ? 409 : 502,
      `GitHub returned HTTP ${status}. Check repository access and App permissions.`,
    ),
);

export const githubPolicyChangeErrors: GithubErrorPolicy = async ({ status }) =>
  new ApiError(
    status === 404 ? 404 : 502,
    `GitHub returned HTTP ${status}. Check repository access and credential permissions. PR publishing needs Contents and Pull requests read/write.`,
  );

/** A policy source read: every failure is the source's configuration, so a 400. */
export async function githubSourceFetch(
  request: GithubRequest,
  notFound?: string,
): Promise<Response> {
  const response = await githubFetch(request);
  if (response.status === 404 && notFound) throw new ApiError(400, notFound);
  if (!response.ok)
    throw new ApiError(
      400,
      `GitHub returned HTTP ${response.status}. Check repository access and the source path.`,
    );
  return response;
}

/** Template generation can return before its files and branch are readable. */
export async function githubSetupRead<T>(request: GithubRequest): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await githubJson<T>({ ...request, errors: githubSyncErrors });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![409, 502].includes(error.statusCode) ||
        attempt === 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** GitHub answers 409 for the commits of a repository without any. */
export async function isEmptyGithubRepository(params: {
  api: string;
  repo: string;
  token: string;
}): Promise<boolean> {
  const response = await githubFetch({
    url: `${params.api}/repos/${params.repo}/commits?per_page=1`,
    token: params.token,
  }).catch(() => null);
  return response?.status === 409;
}
