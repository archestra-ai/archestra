import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSkillManifest } from "@/skills/parser";
import type {
  RevisionPayload,
  SkillShareLinkRevision,
} from "@/types/skill-share-link-revision";
import {
  type AppendRevisionParams,
  MarketplaceMaterializer,
  type MaterializeRequest,
  type MaterializeSkillInput,
  type RevisionStore,
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

/** In-memory revision store for tests; mirrors SkillShareLinkRevisionModel. */
class InMemoryRevisionStore implements RevisionStore {
  private byLink = new Map<string, SkillShareLinkRevision[]>();

  async getLatestByLink(
    linkId: string,
  ): Promise<SkillShareLinkRevision | null> {
    const list = this.byLink.get(linkId);
    return list && list.length > 0 ? (list.at(-1) ?? null) : null;
  }

  async listByLink(linkId: string): Promise<SkillShareLinkRevision[]> {
    return [...(this.byLink.get(linkId) ?? [])];
  }

  async append(
    params: AppendRevisionParams,
    sequence: number,
  ): Promise<SkillShareLinkRevision> {
    const row: SkillShareLinkRevision = {
      id: `rev-${params.linkId}-${sequence}`,
      linkId: params.linkId,
      sequence,
      contentHash: params.contentHash,
      commitSha: params.commitSha,
      parentSha: params.parentSha,
      createdAt: params.createdAt,
      payload: params.payload as RevisionPayload,
    };
    const list = this.byLink.get(params.linkId) ?? [];
    list.push(row);
    this.byLink.set(params.linkId, list);
    return row;
  }
}

/**
 * Persists the revision (simulating another replica winning the sequence) and
 * then throws a unique-violation on the first append, to exercise the
 * cross-replica collision retry in doMaterialize.
 */
class CollideOnceRevisionStore extends InMemoryRevisionStore {
  private collided = false;

  override async append(
    params: AppendRevisionParams,
    sequence: number,
  ): Promise<SkillShareLinkRevision> {
    const row = await super.append(params, sequence);
    if (!this.collided) {
      this.collided = true;
      throw Object.assign(
        new Error(
          'duplicate key value violates unique constraint "skill_share_link_revision_link_seq_idx"',
        ),
        { code: "23505", constraint: "skill_share_link_revision_link_seq_idx" },
      );
    }
    return row;
  }
}

describe("MarketplaceMaterializer", () => {
  let cacheDir: string;
  let revisionStore: InMemoryRevisionStore;
  let materializer: MarketplaceMaterializer;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-materialize-test-"),
    );
    revisionStore = new InMemoryRevisionStore();
    materializer = new MarketplaceMaterializer({ cacheDir, revisionStore });
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
      ".cursor-plugin/marketplace.json",
      "plugins/org-abcd1234-skills/.claude-plugin/plugin.json",
      "plugins/org-abcd1234-skills/.codex-plugin/plugin.json",
      "plugins/org-abcd1234-skills/.cursor-plugin/plugin.json",
      "plugins/org-abcd1234-skills/skills/pdf-helper/SKILL.md",
      "plugins/org-abcd1234-skills/skills/pdf-helper/references/REFERENCE.md",
      "plugins/org-abcd1234-skills/skills/pdf-helper/scripts/run.sh",
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
    expect(claudeManifest.plugins).toHaveLength(1);
    expect(claudeManifest.plugins[0].name).toBe("org-abcd1234-skills");
    expect(claudeManifest.plugins[0].source).toBe(
      "./plugins/org-abcd1234-skills",
    );

    const codexManifest = JSON.parse(
      await fs.readFile(
        path.join(result.repoPath, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    );
    expect(codexManifest.displayName).toBe("Acme Skills");
    expect(codexManifest.plugins).toHaveLength(1);
    expect(codexManifest.plugins[0].source).toEqual({
      source: "local",
      path: "./plugins/org-abcd1234-skills",
    });
  });

  test("recovers from a cross-replica revision sequence collision", async () => {
    // a concurrent replica wins the sequence with the same content; the unique
    // violation must be caught and the existing revision reused, not surfaced
    const colliding = new CollideOnceRevisionStore();
    const racy = new MarketplaceMaterializer({
      cacheDir,
      revisionStore: colliding,
    });

    const result = await racy.materialize(makeRequest());

    expect(result.reused).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    // only the one revision the "winner" wrote exists — no duplicate sequence
    expect(await colliding.listByLink(makeRequest().linkId)).toHaveLength(1);
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
        "plugins/org-abcd1234-skills/skills/pdf-helper/SKILL.md",
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
        "plugins/org-abcd1234-skills/skills/pdf-helper/SKILL.md",
      ),
      "utf8",
    );
    expect(skillMd).toContain("name: PDF Helper");
    expect(skillMd).not.toContain("attacker-controlled content");
  });

  test("resource file with path SKILL.md/foo does not collide with the generated manifest", async () => {
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
    const skillMd = await fs.readFile(
      path.join(
        result.repoPath,
        "plugins/org-abcd1234-skills/skills/pdf-helper/SKILL.md",
      ),
      "utf8",
    );
    expect(skillMd).toContain("name: PDF Helper");
    await expect(
      fs.access(
        path.join(
          result.repoPath,
          "plugins/org-abcd1234-skills/skills/pdf-helper/SKILL.md/injected.txt",
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
    await expect(fs.access("/tmp/injected.txt")).rejects.toThrow();
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
        "plugins/org-abcd1234-skills/skills/pdf-helper/assets/icon.bin",
      ),
    );
    expect(Buffer.compare(written, original)).toBe(0);
  });

  test("bundle plugin contains a deterministic skills/<slug> dir per shared skill", async () => {
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
    // exactly one bundle plugin regardless of how many skills are shared
    expect(manifest.plugins.map((p: { name: string }) => p.name)).toEqual([
      "org-abcd1234-skills",
    ]);
    // each shared skill gets its own subdirectory inside the bundle plugin
    await expect(
      fs.access(
        path.join(result.repoPath, "plugins/org-abcd1234-skills/skills/beta"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(result.repoPath, "plugins/org-abcd1234-skills/skills/alpha"),
      ),
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

    // and only one revision was persisted
    const revs = await revisionStore.listByLink(req.linkId);
    expect(revs).toHaveLength(1);
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

    const parent = await readParent(second.repoPath);
    expect(parent).toBe(first.commitHash);

    // both revisions persisted with parent chain
    const revs = await revisionStore.listByLink(makeRequest().linkId);
    expect(revs).toHaveLength(2);
    expect(revs[0].parentSha).toBeNull();
    expect(revs[1].parentSha).toBe(revs[0].commitSha);
  });

  test("per-link mutex serializes concurrent calls into a single commit", async () => {
    const req = makeRequest();
    const [a, b] = await Promise.all([
      materializer.materialize(req),
      materializer.materialize(req),
    ]);

    expect(a.commitHash).toBe(b.commitHash);
    expect(a.reused || b.reused).toBe(true);

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
      revisionStore,
    });
    await expect(empty.sweepOrphans([])).resolves.toEqual([]);
  });

  test("wiping the cache replays revisions to byte-identical SHAs", async () => {
    const req = makeRequest();
    const first = await materializer.materialize(req);
    const updated = await materializer.materialize(
      makeRequest({
        skills: [makeSkill({ content: "# Updated body" })],
      }),
    );

    // simulate a cache wipe (server reboot, container restart, etc.)
    await fs.rm(materializer.repoPathFor(req.linkId), {
      recursive: true,
      force: true,
    });

    // re-materializing the same content should not write a new revision
    const replayed = await materializer.materialize(
      makeRequest({
        skills: [makeSkill({ content: "# Updated body" })],
      }),
    );

    expect(replayed.reused).toBe(true);
    expect(replayed.commitHash).toBe(updated.commitHash);

    // and the on-disk history must match: HEAD == updated, HEAD^ == first
    expect(await diskHead(replayed.repoPath)).toBe(updated.commitHash);
    expect(await readParent(replayed.repoPath)).toBe(first.commitHash);

    // store still holds exactly two revisions
    expect(await revisionStore.listByLink(req.linkId)).toHaveLength(2);
  });

  test("same content materialized twice produces the same commit SHA across instances", async () => {
    const req = makeRequest();

    // first instance writes revision 1
    const firstResult = await materializer.materialize(req);

    // second instance with a fresh cache but the same revisionStore — must
    // replay to identical SHA, not produce a new commit
    const cacheDir2 = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-materialize-test-"),
    );
    try {
      const materializer2 = new MarketplaceMaterializer({
        cacheDir: cacheDir2,
        revisionStore,
      });
      const replayed = await materializer2.materialize(req);
      expect(replayed.reused).toBe(true);
      expect(replayed.commitHash).toBe(firstResult.commitHash);
      expect(await diskHead(replayed.repoPath)).toBe(firstResult.commitHash);
      expect(await revisionStore.listByLink(req.linkId)).toHaveLength(1);
    } finally {
      await fs.rm(cacheDir2, { recursive: true, force: true });
    }
  });

  test("commit author and committer use the configured identity", async () => {
    const identity = { name: "Test Marketplace", email: "test@example.com" };
    const m = new MarketplaceMaterializer({
      cacheDir,
      revisionStore: new InMemoryRevisionStore(),
      identity,
    });
    const result = await m.materialize(makeRequest());
    const meta = await readCommitMeta(result.repoPath);
    expect(meta.authorName).toBe(identity.name);
    expect(meta.authorEmail).toBe(identity.email);
    expect(meta.committerName).toBe(identity.name);
    expect(meta.committerEmail).toBe(identity.email);
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

async function diskHead(repoPath: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["rev-parse", "HEAD"], { cwd: repoPath });
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
      else reject(new Error(stderr));
    });
  });
}

interface CommitMeta {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

async function readCommitMeta(repoPath: string): Promise<CommitMeta> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["log", "-1", "--pretty=%an%n%ae%n%cn%n%ce"], {
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
      if (code !== 0) return reject(new Error(stderr));
      const [authorName, authorEmail, committerName, committerEmail] = stdout
        .trim()
        .split("\n");
      resolve({ authorName, authorEmail, committerName, committerEmail });
    });
  });
}
