import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { stubSkillManifest as manifest } from "@/test/github-skills-stub";
import { useMswServer as setupMswServer } from "@/test/msw";
import { discoverSkills, importSkills } from "./github-import";
import { githubSkillSourceFromApiUrl } from "./github-source";

const server = setupMswServer();
const githubToken = "enterprise-installation-token";

function serveRepository(params: {
  apiBaseUrl: string;
  owner: string;
  name?: string;
  files?: Record<string, string | Uint8Array>;
}) {
  const requests: Request[] = [];
  const files = params.files ?? {
    "nested/skill/SKILL.md": manifest(params.name ?? "enterprise-skill"),
  };
  const prefix = `${params.apiBaseUrl}/repos/${params.owner}/skills`;
  server.use(
    http.get(`${prefix}/commits/:ref`, ({ request }) => {
      requests.push(request);
      return HttpResponse.json({ sha: "enterprise-commit" });
    }),
    http.get(`${prefix}/git/trees/:sha`, ({ request }) => {
      requests.push(request);
      return HttpResponse.json({
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          type: "blob",
          size:
            typeof content === "string"
              ? Buffer.byteLength(content)
              : content.byteLength,
        })),
      });
    }),
    ...Object.entries(files).map(([path, content]) =>
      http.get(`${prefix}/contents/${path}`, ({ request }) => {
        requests.push(request);
        expect(new URL(request.url).searchParams.get("ref")).toBe(
          "enterprise-commit",
        );
        expect(request.headers.get("accept")).toBe(
          "application/vnd.github.raw",
        );
        return new HttpResponse(
          typeof content === "string"
            ? content
            : Uint8Array.from(content).buffer,
        );
      }),
    ),
  );
  return requests;
}

describe("Enterprise skill imports", () => {
  it.each([
    [
      "https://git.example.test/api/v3",
      "https://git.example.test",
      "https://git.example.test/enterprise-full/skills/tree/main/nested",
      "enterprise-full",
    ],
    [
      "https://git.example.test/api/v3/",
      "https://git.example.test",
      "git.example.test/enterprise-short/skills/tree/main/nested",
      "enterprise-short",
    ],
    [
      "https://api.acme.ghe.com",
      "https://acme.ghe.com",
      "https://acme.ghe.com/enterprise-cloud/skills/tree/main/nested",
      "enterprise-cloud",
    ],
  ])("discovers and imports from %s", async (apiUrl, webOrigin, repoUrl, owner) => {
    const githubSource = githubSkillSourceFromApiUrl(apiUrl);
    const binary = new Uint8Array([0x89, 0x00, 0xff]);
    const requests = serveRepository({
      apiBaseUrl: githubSource.apiBaseUrl,
      owner,
      files: {
        "nested/skill/SKILL.md": manifest("enterprise-skill"),
        "nested/skill/scripts/run.py": "print('enterprise')",
        "nested/skill/assets/image.bin": binary,
        "elsewhere/SKILL.md": manifest("outside-skill"),
      },
    });
    const discovered = await discoverSkills({
      repoUrl,
      githubToken,
      githubSource,
    });
    expect(discovered.skills.map((skill) => skill.name)).toEqual([
      "enterprise-skill",
    ]);
    const [imported] = await importSkills({
      repoUrl,
      githubToken,
      githubSource,
      skillPaths: ["nested/skill"],
    });
    expect(imported).toMatchObject({
      sourceOrigin: webOrigin,
      sourceRef: `${owner}/skills@main:nested/skill`,
      requestedRef: "main",
      sourceCommit: "enterprise-commit",
      skippedFiles: [],
      files: [
        {
          path: "scripts/run.py",
          content: "print('enterprise')",
          encoding: "utf8",
        },
        {
          path: "assets/image.bin",
          content: Buffer.from(binary).toString("base64"),
          encoding: "base64",
        },
      ],
    });
    expect(requests).toHaveLength(5);
    expect(
      requests.every((request) =>
        request.headers.get("authorization")?.endsWith(githubToken),
      ),
    ).toBe(true);
  });

  it.each([
    "https://github.com/acme/skills",
    "https://another.example.test/acme/skills",
    "https://git.example.test:444/acme/skills",
  ])("rejects a different repository origin before sending credentials: %s", async (repoUrl) => {
    const requests = serveRepository({
      apiBaseUrl: "https://git.example.test/api/v3",
      owner: "acme",
    });
    await expect(
      discoverSkills({
        repoUrl,
        githubToken,
        githubSource: githubSkillSourceFromApiUrl(
          "https://git.example.test/api/v3",
        ),
      }),
    ).rejects.toThrow("Repository URL must belong to https://git.example.test");
    expect(requests).toHaveLength(0);
  });

  it("does not follow authenticated API redirects to another host", async () => {
    const githubSource = githubSkillSourceFromApiUrl(
      "https://redirect.example.test/api/v3",
    );
    const destinationRequests: Request[] = [];
    server.use(
      http.get(
        `${githubSource.apiBaseUrl}/repos/redirect-api/skills/commits/HEAD`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "https://other.example.test/receive" },
          }),
      ),
      http.get("https://other.example.test/receive", ({ request }) => {
        destinationRequests.push(request);
        return HttpResponse.json({ sha: "wrong-commit" });
      }),
    );
    await expect(
      discoverSkills({
        repoUrl: "redirect-api/skills",
        githubToken,
        githubSource,
      }),
    ).rejects.toThrow("Could not resolve ref");
    expect(destinationRequests).toHaveLength(0);
  });

  it("reports redirected resources as skipped without following the redirect", async () => {
    const githubSource = githubSkillSourceFromApiUrl(
      "https://resources.example.test/api/v3",
    );
    serveRepository({
      apiBaseUrl: githubSource.apiBaseUrl,
      owner: "resource-limits",
      files: {
        "nested/skill/SKILL.md": manifest("resource-skill"),
        "nested/skill/redirect.txt": "redirect",
      },
    });
    const destinationRequests: Request[] = [];
    server.use(
      http.get(
        `${githubSource.apiBaseUrl}/repos/resource-limits/skills/contents/nested/skill/redirect.txt`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "https://other.example.test/content" },
          }),
      ),
      http.get("https://other.example.test/content", ({ request }) => {
        destinationRequests.push(request);
        return HttpResponse.text("wrong content");
      }),
    );
    const [imported] = await importSkills({
      repoUrl: "resource-limits/skills",
      githubSource,
      githubToken,
      skillPaths: ["nested/skill"],
    });
    expect(imported.files).toEqual([]);
    expect(imported.skippedFiles).toEqual(["redirect.txt"]);
    expect(destinationRequests).toHaveLength(0);
  });
});
