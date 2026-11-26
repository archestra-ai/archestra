import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { GitHostClient, gitReadFailureCode } from "./git-host-client";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const client = new GitHostClient(
  {
    provider: "github",
    apiUrl: "https://api.github.com",
    webUrl: "https://github.com",
  },
  "installation-token",
);

function serveRepositories(count: number) {
  const repositories = Array.from({ length: count }, (_, index) => ({
    full_name: `example/repository-${index + 1}`,
    private: true,
    default_branch: "main",
  }));
  const pages: number[] = [];
  server.use(
    http.get(
      "https://api.github.com/installation/repositories",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer installation-token",
        );
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "1");
        const size = Number(url.searchParams.get("per_page") ?? "30");
        pages.push(page);
        return HttpResponse.json({
          total_count: count,
          repositories: repositories.slice((page - 1) * size, page * size),
        });
      },
    ),
  );
  return { repositories, pages };
}

describe("GitHub installation repository listing", () => {
  test("lists every repository across three installation pages", async () => {
    const { repositories, pages } = serveRepositories(257);

    const listed = await client.listRepositories();

    expect(listed).toEqual(
      repositories.map((repo) => ({
        path: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
      })),
    );
    expect(pages).toEqual([1, 2, 3]);
  });

  test.each([
    157, 257,
  ])("finds repository %i beyond the first page with case-insensitive search", async (number) => {
    serveRepositories(257);

    expect(await client.listRepositories(`REPOSITORY-${number}`)).toEqual([
      {
        path: `example/repository-${number}`,
        private: true,
        defaultBranch: "main",
      },
    ]);
  });

  test.each([
    0, 99, 100, 200,
  ])("terminates listing %i repositories, including an exact page boundary", async (count) => {
    const { pages } = serveRepositories(count);

    expect(await client.listRepositories()).toHaveLength(count);
    expect(pages).toEqual(
      Array.from({ length: Math.floor(count / 100) + 1 }, (_, i) => i + 1),
    );
  });

  test("reports a later-page failure instead of presenting a partial list", async () => {
    const { repositories } = serveRepositories(100);
    server.use(
      http.get(
        "https://api.github.com/installation/repositories",
        ({ request }) => {
          const page = new URL(request.url).searchParams.get("page") ?? "1";
          return page === "1"
            ? HttpResponse.json({ total_count: 257, repositories })
            : HttpResponse.json(
                { message: "Service unavailable" },
                { status: 503 },
              );
        },
      ),
    );

    await expect(client.listRepositories()).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("host failures", () => {
  const commitUrl = "https://api.github.com/repos/example/widgets/commits/HEAD";

  test("a used-up request quota is not blamed on the credential and hides the host's text", async () => {
    server.use(
      http.get(commitUrl, () =>
        HttpResponse.json(
          {
            message:
              "API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit.)",
          },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
      ),
    );

    const failure = await client
      .resolveCommit("example/widgets", null)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("request limit is used up");
    expect(message).not.toContain("credential");
    expect(message).not.toContain("203.0.113.7");
  });

  test("says why a read failed, for the two causes an import explains itself", async () => {
    // The request quota, whatever the request was.
    server.use(
      http.get(commitUrl, () =>
        HttpResponse.json({ message: "slow down" }, { status: 429 }),
      ),
    );
    const limited = await client
      .resolveCommit("example/widgets", null)
      .catch((error: Error) => error);
    expect(gitReadFailureCode(limited)).toBe("git_host_rate_limited");
    expect(gitReadFailureCode(limited, { lookup: true })).toBe(
      "git_host_rate_limited",
    );

    // A 404 means "repository not found" only for the request that looks the
    // repository up; for a file inside it, it is a missing file.
    server.use(
      http.get(commitUrl, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const missing = await client
      .resolveCommit("example/widgets", null)
      .catch((error: Error) => error);
    expect(gitReadFailureCode(missing, { lookup: true })).toBe(
      "git_repository_not_found",
    );
    expect(gitReadFailureCode(missing)).toBeNull();
    expect(gitReadFailureCode(new Error("anything else"))).toBeNull();
  });

  test("a refused read still names the credential", async () => {
    server.use(
      http.get(commitUrl, () =>
        HttpResponse.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        ),
      ),
    );

    await expect(client.resolveCommit("example/widgets", null)).rejects.toThrow(
      "the credential can't read it",
    );
  });
});
