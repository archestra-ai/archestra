import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { GitHostClient } from "./git-host-client";

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
