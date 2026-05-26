import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSkillManifest } from "@/skills/parser";
import {
  MarketplaceMaterializer,
  type MaterializeRequest,
  type MaterializeSkillInput,
} from "./materialize";

function makeSkill(
  overrides: Partial<MaterializeSkillInput> = {},
): MaterializeSkillInput {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "PDF Helper",
    description: "Helps with PDFs",
    content: "# PDF Helper\n\nDoes the thing.",
    license: null,
    compatibility: null,
    metadata: {},
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    files: [],
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<MaterializeRequest> = {},
): MaterializeRequest {
  return {
    linkId: "aaaaaaaa-1111-2222-3333-444444444444",
    marketplaceName: "org-abcd1234-skills",
    ownerName: "Acme Corp",
    displayName: "Acme Skills",
    skills: [makeSkill()],
    ...overrides,
  };
}

describe("MarketplaceMaterializer", () => {
  let cacheDir: string;
  let materializer: MarketplaceMaterializer;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-materialize-test-"),
    );
    materializer = new MarketplaceMaterializer({ cacheDir });
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  test("produces the documented on-disk layout for a single skill", async () => {
    const req = makeRequest({
      skills: [
        makeSkill({
          name: "PDF Helper",
          files: [
            {
              id: "f1",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "references/REFERENCE.md",
              content: "look here",
              encoding: "utf8",
              kind: "reference",
              createdAt: new Date(),
            },
            {
              id: "f2",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "scripts/run.sh",
              content: "echo hi",
              encoding: "utf8",
              kind: "script",
              createdAt: new Date(),
            },
          ],
        }),
      ],
    });
    const result = await materializer.materialize(req);

    expect(result.reused).toBe(false);
    expect(result.repoPath).toBe(
      path.join(cacheDir, "aaaaaaaa-1111-2222-3333-444444444444", "repo"),
    );

    const expected = [
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      "plugins/pdf-helper/.claude-plugin/plugin.json",
      "plugins/pdf-helper/.codex-plugin/plugin.json",
      "plugins/pdf-helper/skills/pdf-helper/SKILL.md",
      "plugins/pdf-helper/skills/pdf-helper/references/REFERENCE.md",
      "plugins/pdf-helper/skills/pdf-helper/scripts/run.sh",
    ];
    for (const rel of expected) {
      await expect(
        fs.access(path.join(result.repoPath, rel)),
      ).resolves.toBeUndefined();
    }

    const claudeManifest = JSON.parse(
      await fs.readFile(
        path.join(result.repoPath, ".claude-plugin/marketplace.json"),
        "utf8",
      ),
    );
    expect(claudeManifest.name).toBe("org-abcd1234-skills");
    expect(claudeManifest.plugins[0].name).toBe("pdf-helper");

    const codexManifest = JSON.parse(
      await fs.readFile(
        path.join(result.repoPath, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    );
    expect(codexManifest.displayName).toBe("Acme Skills");
    expect(codexManifest.plugins[0].source).toEqual({
      source: "local",
      path: "./plugins/pdf-helper",
    });
  });

  test("SKILL.md frontmatter round-trips through the parser", async () => {
    const req = makeRequest({
      skills: [
        makeSkill({
          name: "PDF Helper",
          description: "Helps with PDFs",
          license: "MIT",
          compatibility: "claude>=1.0",
          metadata: { author: "Acme", version: "2.0" },
          content: "# PDF Helper\n\nDoes the thing.",
        }),
      ],
    });
    const result = await materializer.materialize(req);

    const raw = await fs.readFile(
      path.join(
        result.repoPath,
        "plugins/pdf-helper/skills/pdf-helper/SKILL.md",
      ),
      "utf8",
    );
    const parsed = parseSkillManifest(raw);
    expect(parsed.name).toBe("PDF Helper");
    expect(parsed.description).toBe("Helps with PDFs");
    expect(parsed.license).toBe("MIT");
    expect(parsed.compatibility).toBe("claude>=1.0");
    expect(parsed.metadata).toEqual({ author: "Acme", version: "2.0" });
    expect(parsed.content).toBe("# PDF Helper\n\nDoes the thing.");
  });

  test("resource file with path SKILL.md does not overwrite generated manifest", async () => {
    const req = makeRequest({
      skills: [
        makeSkill({
          name: "PDF Helper",
          content: "# PDF Helper\n\nDoes the thing.",
          files: [
            {
              id: "f1",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "SKILL.md",
              content: "attacker-controlled content",
              encoding: "utf8",
              kind: "reference",
              createdAt: new Date(),
            },
          ],
        }),
      ],
    });
    const result = await materializer.materialize(req);
    const skillMd = await fs.readFile(
      path.join(
        result.repoPath,
        "plugins/pdf-helper/skills/pdf-helper/SKILL.md",
      ),
      "utf8",
    );
    // the generated manifest must survive — attacker content must not appear
    expect(skillMd).toContain("name: PDF Helper");
    expect(skillMd).not.toContain("attacker-controlled content");
  });

  test("resource file with path SKILL.md/foo does not cause mkdir collision", async () => {
    const req = makeRequest({
      skills: [
        makeSkill({
          name: "PDF Helper",
          content: "# PDF Helper\n\nDoes the thing.",
          files: [
            {
              id: "f1",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "SKILL.md/injected.txt",
              content: "attacker content",
              encoding: "utf8",
              kind: "reference",
              createdAt: new Date(),
            },
          ],
        }),
      ],
    });
    const result = await materializer.materialize(req);
    // generated SKILL.md must survive and not be replaced by a directory
    const skillMd = await fs.readFile(
      path.join(
        result.repoPath,
        "plugins/pdf-helper/skills/pdf-helper/SKILL.md",
      ),
      "utf8",
    );
    expect(skillMd).toContain("name: PDF Helper");
    // the sub-path must not have been written
    await expect(
      fs.access(
        path.join(
          result.repoPath,
          "plugins/pdf-helper/skills/pdf-helper/SKILL.md/injected.txt",
        ),
      ),
    ).rejects.toThrow();
  });

  test("resource file with double-slash absolute path cannot escape skill root", async () => {
    const req = makeRequest({
      skills: [
        makeSkill({
          name: "PDF Helper",
          content: "# PDF Helper\n\nDoes the thing.",
          files: [
            {
              id: "f1",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "//tmp/injected.txt",
              content: "attacker content",
              encoding: "utf8",
              kind: "reference",
              createdAt: new Date(),
            },
          ],
        }),
      ],
    });
    const result = await materializer.materialize(req);
    // file outside skill root must not be written
    await expect(fs.access("/tmp/injected.txt")).rejects.toThrow();
    // repo itself must still be valid
    expect(result.repoPath).toBeTruthy();
  });

  test("binary resource files round-trip via base64", async () => {
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const req = makeRequest({
      skills: [
        makeSkill({
          files: [
            {
              id: "f1",
              skillId: "11111111-2222-3333-4444-555555555555",
              path: "assets/icon.bin",
              content: original.toString("base64"),
              encoding: "base64",
              kind: "asset",
              createdAt: new Date(),
            },
          ],
        }),
      ],
    });
    const result = await materializer.materialize(req);
    const written = await fs.readFile(
      path.join(
        result.repoPath,
        "plugins/pdf-helper/skills/pdf-helper/assets/icon.bin",
      ),
    );
    expect(Buffer.compare(written, original)).toBe(0);
  });

  test("manifest ordering and plugin layout is deterministic across runs", async () => {
    const skills = [
      makeSkill({ id: "b", name: "Beta" }),
      makeSkill({ id: "a", name: "Alpha" }),
    ];
    const req = makeRequest({ skills });
    const result = await materializer.materialize(req);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(result.repoPath, ".claude-plugin/marketplace.json"),
        "utf8",
      ),
    );
    expect(manifest.plugins.map((p: { name: string }) => p.name)).toEqual([
      "beta",
      "alpha",
    ]);
    // both plugin dirs exist
    await expect(
      fs.access(path.join(result.repoPath, "plugins/beta")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(result.repoPath, "plugins/alpha")),
    ).resolves.toBeUndefined();
  });

  test("identical content reuses the existing HEAD instead of committing again", async () => {
    const req = makeRequest();
    const first = await materializer.materialize(req);
    expect(first.reused).toBe(false);

    const second = await materializer.materialize(req);
    expect(second.reused).toBe(true);
    expect(second.commitHash).toBe(first.commitHash);
    expect(second.contentHash).toBe(first.contentHash);
  });

  test("changed content advances HEAD with a child commit (no unrelated histories)", async () => {
    const first = await materializer.materialize(makeRequest());

    const updatedSkill = makeSkill({
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      content: "# Updated body",
    });
    const second = await materializer.materialize(
      makeRequest({ skills: [updatedSkill] }),
    );

    expect(second.reused).toBe(false);
    expect(second.commitHash).not.toBe(first.commitHash);

    // assert parent(HEAD) === previous HEAD — proves clones can `git pull` fast-forward
    const parent = await readParent(second.repoPath);
    expect(parent).toBe(first.commitHash);
  });

  test("per-link mutex serializes concurrent calls into a single commit", async () => {
    const req = makeRequest();
    const [a, b] = await Promise.all([
      materializer.materialize(req),
      materializer.materialize(req),
    ]);

    // both calls finish, both return the same HEAD; the second is a no-op reuse
    expect(a.commitHash).toBe(b.commitHash);
    expect(a.reused || b.reused).toBe(true);

    // and the repo really only has one commit
    const count = await commitCount(a.repoPath);
    expect(count).toBe(1);
  });

  test("revoke removes the per-link directory", async () => {
    const req = makeRequest();
    const result = await materializer.materialize(req);
    await expect(fs.access(result.repoPath)).resolves.toBeUndefined();

    await materializer.revoke(req.linkId);
    await expect(fs.access(result.repoPath)).rejects.toThrow();
  });

  test("sweepOrphans removes directories not in the live link set", async () => {
    const liveId = "bbbbbbbb-1111-2222-3333-444444444444";
    const orphanId = "cccccccc-1111-2222-3333-444444444444";
    await materializer.materialize(makeRequest({ linkId: liveId }));
    await materializer.materialize(
      makeRequest({
        linkId: orphanId,
        skills: [makeSkill({ id: "22222222-2222-3333-4444-555555555555" })],
      }),
    );

    const removed = await materializer.sweepOrphans([liveId]);
    expect(removed).toEqual([orphanId]);
    await expect(
      fs.access(path.join(cacheDir, liveId)),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(cacheDir, orphanId))).rejects.toThrow();
  });

  test("sweepOrphans ignores non-UUID entries in cache dir", async () => {
    await fs.mkdir(path.join(cacheDir, "README"), { recursive: true });
    await fs.mkdir(path.join(cacheDir, ".gitkeep"), { recursive: true });
    const removed = await materializer.sweepOrphans([]);
    expect(removed).toEqual([]);
    await expect(
      fs.access(path.join(cacheDir, "README")),
    ).resolves.toBeUndefined();
  });

  test("sweepOrphans tolerates a missing cache dir", async () => {
    const empty = new MarketplaceMaterializer({
      cacheDir: path.join(cacheDir, "does-not-exist"),
    });
    await expect(empty.sweepOrphans([])).resolves.toEqual([]);
  });
});

// ===== test helpers =====

async function readParent(repoPath: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["rev-parse", "HEAD^"], { cwd: repoPath });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else if (/unknown revision/.test(stderr)) resolve(null);
      else reject(new Error(stderr));
    });
  });
}

async function commitCount(repoPath: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["rev-list", "--count", "HEAD"], {
      cwd: repoPath,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(Number.parseInt(stdout.trim(), 10));
      else reject(new Error(stderr));
    });
  });
}
