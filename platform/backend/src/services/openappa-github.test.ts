import { delay, HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import {
  type GithubErrorPolicy,
  githubFetch,
  githubJson,
  githubPolicyChangeErrors,
  githubSetupRead,
  githubSourceFetch,
  githubSyncErrors,
  isEmptyGithubRepository,
  withGithubMessage,
} from "./openappa-github";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const REPO = "https://api.github.com/repos/example/policies";

const respond = (status: number, body: object = { message: "nope" }) =>
  server.use(http.all(REPO, () => HttpResponse.json(body, { status })));

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ApiError);
  const { statusCode, message } = error as ApiError;
  return { statusCode, message };
}

const json = (errors: GithubErrorPolicy, signal?: AbortSignal) =>
  githubJson({ url: REPO, token: "t", errors, signal });

describe("githubFetch", () => {
  test("sends the token whenever defined and the API version on request", async () => {
    const seen: Array<[string | null, string | null]> = [];
    server.use(
      http.get(REPO, ({ request }) => {
        seen.push([
          request.headers.get("authorization"),
          request.headers.get("x-github-api-version"),
        ]);
        return HttpResponse.json({});
      }),
    );
    await githubFetch({ url: REPO });
    await githubFetch({ url: REPO, token: "" });
    await githubFetch({ url: REPO, token: "t", apiVersion: true });
    expect(seen).toEqual([
      [null, null],
      ["Bearer", null],
      ["Bearer t", "2022-11-28"],
    ]);
  });
});

describe("githubJson", () => {
  test("parses a JSON body", async () => {
    respond(200, { sha: "abc" });
    await expect(json(githubSyncErrors)).resolves.toEqual({ sha: "abc" });
  });

  test("a request past its deadline cannot reach GitHub", async () => {
    server.use(
      http.get(REPO, async () => {
        await delay(2000);
        return HttpResponse.json({});
      }),
    );
    expect(
      await failure(json(githubSyncErrors, AbortSignal.timeout(50))),
    ).toEqual({ statusCode: 502, message: "Could not reach GitHub" });
  });

  test("refuses a success body over 2 MiB", async () => {
    server.use(
      http.get(REPO, () => HttpResponse.text("x".repeat(2 * 1024 * 1024 + 1))),
    );
    expect(await failure(json(githubSyncErrors))).toEqual({
      statusCode: 502,
      message: "GitHub response is too large",
    });
  });

  test("a non-JSON body is an invalid response", async () => {
    server.use(http.get(REPO, () => HttpResponse.text("<html>")));
    expect(await failure(json(githubSyncErrors))).toEqual({
      statusCode: 502,
      message: "GitHub returned an invalid response",
    });
  });
});

describe("error policies", () => {
  test("sync maps 422 to 409 and everything else to 502", async () => {
    for (const [status, expected] of [
      [422, 409],
      [404, 502],
      [500, 502],
    ]) {
      respond(status);
      expect(await failure(json(githubSyncErrors))).toEqual({
        statusCode: expected,
        message: `GitHub returned HTTP ${status}. Check repository access and App permissions.`,
      });
    }
  });

  test("policy change maps 404 to 404 and everything else to 502", async () => {
    for (const [status, expected] of [
      [404, 404],
      [422, 502],
      [500, 502],
    ]) {
      respond(status);
      expect((await failure(json(githubPolicyChangeErrors))).statusCode).toBe(
        expected,
      );
    }
  });

  test("hands GitHub's message over, truncated, only from a body of at most 4 KiB", async () => {
    const seen: Array<string | undefined> = [];
    const errors = withGithubMessage((status, message) => {
      seen.push(message);
      return new ApiError(status, "mapped");
    });
    respond(403, { message: "m".repeat(300) });
    await failure(json(errors));
    respond(403, { message: "m".repeat(5000) });
    await failure(json(errors));
    server.use(
      http.get(REPO, () => HttpResponse.text("bad gateway", { status: 502 })),
    );
    await failure(json(errors));
    expect(seen).toEqual(["m".repeat(200), undefined, undefined]);
  });
});

describe("githubSourceFetch", () => {
  test("maps every failure to 400, naming a missing source when told how", async () => {
    respond(404);
    expect(
      await failure(githubSourceFetch({ url: REPO }, "No such file")),
    ).toEqual({ statusCode: 400, message: "No such file" });
    for (const status of [404, 500]) {
      respond(status);
      expect(await failure(githubSourceFetch({ url: REPO }))).toEqual({
        statusCode: 400,
        message: `GitHub returned HTTP ${status}. Check repository access and the source path.`,
      });
    }
  });
});

describe("githubSetupRead", () => {
  test("retries a 409 or 502 read three times, a second apart", async () => {
    let attempts = 0;
    server.use(
      http.get(REPO, () => {
        attempts++;
        return attempts < 3
          ? HttpResponse.json({}, { status: attempts === 1 ? 422 : 500 })
          : HttpResponse.json({ sha: "abc" });
      }),
    );
    const started = Date.now();
    await expect(githubSetupRead({ url: REPO, token: "t" })).resolves.toEqual({
      sha: "abc",
    });
    expect(attempts).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);

    attempts = 0;
    server.use(
      http.get(REPO, () => {
        attempts++;
        return HttpResponse.json({}, { status: 422 });
      }),
    );
    expect(
      (await failure(githubSetupRead({ url: REPO, token: "t" }))).statusCode,
    ).toBe(409);
    expect(attempts).toBe(4);
  }, 15_000);
});

describe("isEmptyGithubRepository", () => {
  const COMMITS = `${REPO}/commits`;
  const isEmpty = () =>
    isEmptyGithubRepository({
      api: "https://api.github.com",
      repo: "example/policies",
      token: "t",
    });

  test("only a 409 for the commits means empty", async () => {
    for (const [status, empty] of [
      [409, true],
      [200, false],
      [404, false],
    ] as const) {
      server.use(http.get(COMMITS, () => HttpResponse.json([], { status })));
      expect(await isEmpty()).toBe(empty);
    }
  });

  test("a request that fails is not empty", async () => {
    server.use(http.get(COMMITS, () => HttpResponse.error()));
    expect(await isEmpty()).toBe(false);
  });
});
