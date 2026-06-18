import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STUB_COMMIT_SHA as COMMIT_SHA,
  stubSkillManifest as manifest,
  stubGithub,
} from "@/test/github-skills-stub";
import {
  discoverSkills,
  importSkills,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
  SkillImportError,
} from "./github-import";

/**
 * Characterization tests for the GitHub import pipeline. The only stubbed
 * collaborator is the network (see github-skills-stub).
 *
 * The module-level repo-snapshot cache persists across tests in this file, so
 * every test uses a distinct owner/repo — no test may ride another's cache
 * entry.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stub GitHub, then override specific raw-file responses by path: `delayMs`
 * makes a file resolve later than its tree position (surfacing any assembly
 * that tracks completion order instead of input order), `status` forces a
 * non-200 so the fetch is treated as a skip.
 */
function stubGithubWithRawBehavior(
  repos: Parameters<typeof stubGithub>[0],
  perPath: Record<string, { delayMs?: number; status?: number }>,
): void {
  const inner = stubGithub(repos) as unknown as (
    input: string | URL | Request,
  ) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(urlStr);
      if (url.hostname === "raw.githubusercontent.com") {
        const rawPath = decodeURIComponent(
          url.pathname.split(`/${COMMIT_SHA}/`)[1] ?? "",
        );
        const behavior = perPath[rawPath];
        if (behavior?.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
        }
        if (behavior?.status) {
          return new Response("override", { status: behavior.status });
        }
      }
      return inner(input);
    }),
  );
}

describe("discoverSkills", () => {
  it("finds every directory holding a SKILL.md, with parsed metadata and file counts", async () => {
    stubGithub([
      {
        owner: "disc-basic",
        repo: "skills",
        files: {
          "skills/pdf/SKILL.md": manifest("pdf-processing"),
          "skills/pdf/scripts/run.py": "print('hi')",
          "skills/pdf/references/notes.md": "# notes",
          "skills/csv/SKILL.md": manifest(
            "csv-tools",
            "allowed-tools: Bash(python3)",
          ),
          "README.md": "# not a skill",
        },
      },
    ]);

    const result = await discoverSkills({ repoUrl: "disc-basic/skills" });

    expect(result.repoUrl).toBe("disc-basic/skills");
    expect(result.ref).toBe(COMMIT_SHA);
    // tree order: discovery yields skills in the order their manifests appear
    expect(result.skills).toEqual([
      expect.objectContaining({
        skillPath: "skills/pdf",
        name: "pdf-processing",
        description: "pdf-processing does things.",
        fileCount: 3,
      }),
      expect.objectContaining({
        skillPath: "skills/csv",
        name: "csv-tools",
        allowedTools: "Bash(python3)",
        templated: false,
        // SKILL.md itself counts, so an instruction-only skill reads 1, not 0
        fileCount: 1,
      }),
    ]);
  });

  it("restricts discovery to the requested subpath", async () => {
    stubGithub([
      {
        owner: "disc-subpath",
        repo: "skills",
        files: {
          "inside/a/SKILL.md": manifest("inside-skill"),
          "outside/b/SKILL.md": manifest("outside-skill"),
        },
      },
    ]);

    const result = await discoverSkills({
      repoUrl: "disc-subpath/skills",
      path: "inside",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["inside-skill"]);
  });

  it("keeps skills in tree order when manifest fetches resolve out of order", async () => {
    stubGithubWithRawBehavior(
      [
        {
          owner: "disc-order",
          repo: "skills",
          files: {
            "skills/a/SKILL.md": manifest("a-skill"),
            "skills/b/SKILL.md": manifest("b-skill"),
            "skills/c/SKILL.md": manifest("c-skill"),
          },
        },
      ],
      {
        "skills/a/SKILL.md": { delayMs: 40 },
        "skills/b/SKILL.md": { delayMs: 20 },
      },
    );

    const result = await discoverSkills({ repoUrl: "disc-order/skills" });

    expect(result.skills.map((skill) => skill.name)).toEqual([
      "a-skill",
      "b-skill",
      "c-skill",
    ]);
  });

  it("accepts a /tree/<ref>/<subpath> URL and resolves that ref", async () => {
    const fetchMock = stubGithub([
      {
        owner: "disc-tree",
        repo: "skills",
        files: {
          "nested/skill/SKILL.md": manifest("nested-skill"),
          "other/SKILL.md": manifest("other-skill"),
        },
      },
    ]);

    const result = await discoverSkills({
      repoUrl: "https://github.com/disc-tree/skills/tree/v2/nested",
    });

    expect(result.ref).toBe("v2");
    expect(result.skills.map((skill) => skill.name)).toEqual(["nested-skill"]);
    const commitCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((u) => u.includes("/commits/"));
    expect(commitCall).toContain("/commits/v2");
  });

  it("skips a skill whose SKILL.md does not parse, keeping the rest", async () => {
    stubGithub([
      {
        owner: "disc-badmanifest",
        repo: "skills",
        files: {
          "good/SKILL.md": manifest("good-skill"),
          "bad/SKILL.md": "no frontmatter here",
        },
      },
    ]);

    const result = await discoverSkills({ repoUrl: "disc-badmanifest/skills" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["good-skill"]);
  });

  it("reuses the cached repo snapshot for a follow-up call", async () => {
    const fetchMock = stubGithub([
      {
        owner: "disc-cache",
        repo: "skills",
        files: { "s/SKILL.md": manifest("cached-skill") },
      },
    ]);

    await discoverSkills({ repoUrl: "disc-cache/skills" });
    const apiCallsAfterFirst = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("api.github.com"),
    ).length;

    await discoverSkills({ repoUrl: "disc-cache/skills" });
    const apiCallsAfterSecond = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("api.github.com"),
    ).length;

    expect(apiCallsAfterSecond).toBe(apiCallsAfterFirst);
  });

  it("does not share cache entries across different tokens", async () => {
    const fetchMock = stubGithub([
      {
        owner: "disc-tokeniso",
        repo: "skills",
        files: { "s/SKILL.md": manifest("token-skill") },
      },
    ]);

    await discoverSkills({ repoUrl: "disc-tokeniso/skills" });
    await discoverSkills({
      repoUrl: "disc-tokeniso/skills",
      githubToken: "ghp_other",
    });

    const treeCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/git/trees/"),
    );
    expect(treeCalls).toHaveLength(2);
  });
});

describe("importSkills", () => {
  it("fetches the selected skill with text resources and provenance", async () => {
    stubGithub([
      {
        owner: "imp-basic",
        repo: "skills",
        files: {
          "skills/pdf/SKILL.md": manifest("pdf-processing"),
          "skills/pdf/scripts/run.py": "print('hi')",
          "skills/pdf/references/notes.md": "# notes",
        },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-basic/skills",
      skillPaths: ["skills/pdf"],
    });

    expect(imported.parsed.name).toBe("pdf-processing");
    expect(imported.sourceRef).toBe(
      `imp-basic/skills@${COMMIT_SHA}:skills/pdf`,
    );
    expect(imported.sourceCommit).toBe(COMMIT_SHA);
    // resource paths are relative to the skill dir and exclude SKILL.md
    expect(imported.files).toEqual([
      {
        path: "scripts/run.py",
        content: "print('hi')",
        encoding: "utf8",
        kind: "script",
      },
      {
        path: "references/notes.md",
        content: "# notes",
        encoding: "utf8",
        kind: "reference",
      },
    ]);
  });

  it("imports a repo-root skill (empty skillPath)", async () => {
    stubGithub([
      {
        owner: "imp-root",
        repo: "one-skill",
        files: {
          "SKILL.md": manifest("root-skill"),
          "scripts/go.sh": "echo go",
        },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-root/one-skill",
      skillPaths: [""],
    });

    expect(imported.parsed.name).toBe("root-skill");
    expect(imported.sourceRef).toBe(`imp-root/one-skill@${COMMIT_SHA}:`);
    expect(imported.files.map((file) => file.path)).toEqual(["scripts/go.sh"]);
  });

  it("keeps a BOM-headed UTF-8 file as text with the BOM preserved", async () => {
    const bomText = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("# notes", "utf-8"),
    ]);
    stubGithub([
      {
        owner: "imp-bom",
        repo: "skills",
        files: {
          "s/SKILL.md": manifest("bom-skill"),
          "s/references/notes.md": bomText,
        },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-bom/skills",
      skillPaths: ["s"],
    });

    expect(imported.files).toEqual([
      {
        path: "references/notes.md",
        content: `${"\uFEFF"}# notes`,
        encoding: "utf8",
        kind: "reference",
      },
    ]);
  });

  it("base64-encodes a null-free binary resource (invalid UTF-8)", async () => {
    // no null bytes, but not decodable as UTF-8 — must not be stored as
    // corrupted text
    const garbled = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0xc3]);
    stubGithub([
      {
        owner: "imp-garbled",
        repo: "skills",
        files: {
          "s/SKILL.md": manifest("garbled-skill"),
          "s/assets/blob.bin": garbled,
        },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-garbled/skills",
      skillPaths: ["s"],
    });

    expect(imported.files).toEqual([
      {
        path: "assets/blob.bin",
        content: garbled.toString("base64"),
        encoding: "base64",
        kind: "asset",
      },
    ]);
  });

  it("base64-encodes a binary resource (null byte present)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    stubGithub([
      {
        owner: "imp-binary",
        repo: "skills",
        files: {
          "s/SKILL.md": manifest("binary-skill"),
          "s/assets/logo.png": png,
        },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-binary/skills",
      skillPaths: ["s"],
    });

    expect(imported.files).toEqual([
      {
        path: "assets/logo.png",
        content: png.toString("base64"),
        encoding: "base64",
        kind: "asset",
      },
    ]);
  });

  it("throws SkillImportError when the selected path has no SKILL.md", async () => {
    stubGithub([
      {
        owner: "imp-missing",
        repo: "skills",
        files: { "real/SKILL.md": manifest("real-skill") },
      },
    ]);

    await expect(
      importSkills({ repoUrl: "imp-missing/skills", skillPaths: ["ghost"] }),
    ).rejects.toThrow(SkillImportError);
  });

  it("skips files whose tree-listed size exceeds the per-file cap", async () => {
    stubGithub([
      {
        owner: "imp-oversize",
        repo: "skills",
        files: {
          "s/SKILL.md": manifest("oversize-skill"),
          "s/big.bin": "small body, big tree size",
          "s/ok.md": "fine",
        },
        treeSizes: { "s/big.bin": MAX_SKILL_FILE_BYTES + 1 },
      },
    ]);

    const [imported] = await importSkills({
      repoUrl: "imp-oversize/skills",
      skillPaths: ["s"],
    });

    expect(imported.files.map((file) => file.path)).toEqual(["ok.md"]);
    expect(imported.skippedFiles).toEqual(["big.bin"]);
  });

  it("caps the number of resource files per skill", async () => {
    const files: Record<string, string> = {
      "s/SKILL.md": manifest("many-files"),
    };
    for (let i = 0; i < MAX_FILES_PER_SKILL + 25; i += 1) {
      files[`s/references/file-${String(i).padStart(4, "0")}.md`] = `# ${i}`;
    }
    stubGithub([{ owner: "imp-cap", repo: "skills", files }]);

    const [imported] = await importSkills({
      repoUrl: "imp-cap/skills",
      skillPaths: ["s"],
    });

    expect(imported.files).toHaveLength(MAX_FILES_PER_SKILL);
    expect(imported.skippedFiles).toHaveLength(25);
    // the cap keeps the first N in tree order and reports the overflow
    expect(imported.skippedFiles[0]).toBe(
      `references/file-${String(MAX_FILES_PER_SKILL).padStart(4, "0")}.md`,
    );
  });

  it("keeps resource files in tree order when fetches resolve out of order", async () => {
    stubGithubWithRawBehavior(
      [
        {
          owner: "imp-order",
          repo: "skills",
          files: {
            "s/SKILL.md": manifest("ordered-skill"),
            "s/a.txt": "a",
            "s/b.txt": "b",
            "s/c.txt": "c",
            "s/d.txt": "d",
            "s/e.txt": "e",
          },
        },
      ],
      {
        "s/a.txt": { delayMs: 50 },
        "s/b.txt": { delayMs: 40 },
        "s/c.txt": { delayMs: 30 },
        "s/d.txt": { delayMs: 20 },
      },
    );

    const [imported] = await importSkills({
      repoUrl: "imp-order/skills",
      skillPaths: ["s"],
    });

    expect(imported.files.map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
    ]);
  });

  it("partitions files per skill when a fetch is skipped mid-batch", async () => {
    // s1/b.txt 404s while the two skills' files are fetched as one concurrent
    // batch; the cursor must not drift, so s2 keeps both its files and only
    // s1 records the skip.
    stubGithubWithRawBehavior(
      [
        {
          owner: "imp-multi",
          repo: "skills",
          files: {
            "s1/SKILL.md": manifest("s1-skill"),
            "s1/a.txt": "a1",
            "s1/b.txt": "b1",
            "s2/SKILL.md": manifest("s2-skill"),
            "s2/c.txt": "c2",
            "s2/d.txt": "d2",
          },
        },
      ],
      { "s1/b.txt": { status: 404 } },
    );

    const imported = await importSkills({
      repoUrl: "imp-multi/skills",
      skillPaths: ["s1", "s2"],
    });

    expect(imported.map((skill) => skill.skillPath)).toEqual(["s1", "s2"]);
    expect(imported[0].files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(imported[0].skippedFiles).toEqual(["b.txt"]);
    expect(imported[1].files.map((file) => file.path)).toEqual([
      "c.txt",
      "d.txt",
    ]);
    expect(imported[1].skippedFiles).toEqual([]);
  });
});

describe("repository URL parsing", () => {
  it.each([
    ["url-plain/skills", "url-plain"],
    ["github.com/url-host/skills", "url-host"],
    ["https://github.com/url-https/skills", "url-https"],
    ["http://github.com/url-http/skills.git", "url-http"],
    ["HTTPS://GitHub.com/url-case/skills", "url-case"],
  ])("accepts %s", async (repoUrl, owner) => {
    const fetchMock = stubGithub([
      {
        owner,
        repo: "skills",
        files: { "s/SKILL.md": manifest(`${owner}-skill`) },
      },
    ]);

    const result = await discoverSkills({ repoUrl });

    expect(result.repoUrl).toBe(`${owner}/skills`);
    const commitCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((u) => u.includes("api.github.com"));
    expect(commitCall).toContain(`/repos/${owner}/skills/`);
  });

  it("lets an explicit path override the URL subpath", async () => {
    stubGithub([
      {
        owner: "url-override",
        repo: "skills",
        files: {
          "from-url/SKILL.md": manifest("url-sub-skill"),
          "from-param/SKILL.md": manifest("param-sub-skill"),
        },
      },
    ]);

    const result = await discoverSkills({
      repoUrl: "https://github.com/url-override/skills/tree/main/from-url",
      path: "from-param",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual([
      "param-sub-skill",
    ]);
  });

  it("rejects an empty URL and a bare owner", async () => {
    await expect(discoverSkills({ repoUrl: "  " })).rejects.toThrow(
      SkillImportError,
    );
    await expect(discoverSkills({ repoUrl: "just-an-owner" })).rejects.toThrow(
      SkillImportError,
    );
  });

  it.each([
    "gitlab.com/some-owner/skills",
    "https://gitlab.com/some-owner/skills",
    "www.github.com/some-owner/skills",
  ])("rejects the non-GitHub host in %s with a clear error", async (repoUrl) => {
    await expect(discoverSkills({ repoUrl })).rejects.toThrow(
      /Only github\.com repositories are supported/,
    );
  });
});
