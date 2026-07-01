import { vi } from "vitest";

/**
 * Network stub for the GitHub skill-import pipeline. Replaces `globalThis.fetch`
 * (the import code's only process boundary: Octokit 22 rides on global fetch,
 * and raw file bytes come from raw.githubusercontent.com via the same global)
 * with a router serving the commit, tree, and raw-file endpoints for a set of
 * fake repositories. Callers must `vi.unstubAllGlobals()` after each test.
 */

export const STUB_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export interface FakeGithubRepo {
  owner: string;
  repo: string;
  /** Repo files: path → utf8 string or raw bytes. */
  files: Record<string, string | Buffer>;
  /** Optional per-path size override for the tree listing (not the body). */
  treeSizes?: Record<string, number>;
}

export function stubGithub(repos: FakeGithubRepo[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    for (const fake of repos) {
      const base = `/repos/${fake.owner}/${fake.repo}`;
      if (url.hostname === "api.github.com") {
        if (url.pathname.startsWith(`${base}/commits/`)) {
          return Response.json({ sha: STUB_COMMIT_SHA });
        }
        if (url.pathname.startsWith(`${base}/git/trees/`)) {
          return Response.json({
            sha: STUB_COMMIT_SHA,
            tree: Object.entries(fake.files).map(([path, content]) => ({
              type: "blob",
              path,
              size:
                fake.treeSizes?.[path] ??
                (typeof content === "string"
                  ? Buffer.byteLength(content)
                  : content.length),
            })),
          });
        }
      }
      const rawPrefix = `/${fake.owner}/${fake.repo}/${STUB_COMMIT_SHA}/`;
      if (
        url.hostname === "raw.githubusercontent.com" &&
        url.pathname.startsWith(rawPrefix)
      ) {
        const path = decodeURIComponent(url.pathname.slice(rawPrefix.length));
        const content = fake.files[path];
        if (content === undefined) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(
          typeof content === "string" ? content : new Uint8Array(content),
        );
      }
    }
    return new Response("Not Found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A minimal valid SKILL.md manifest for stubbed repos. */
export function stubSkillManifest(name: string, extra = ""): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} does things.`,
    extra,
    "---",
    "",
    `# ${name}`,
  ]
    .filter(Boolean)
    .join("\n");
}
