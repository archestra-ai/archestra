import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SkillModel, SkillShareLinkModel } from "@/models";
import SkillShareLinkRevisionModel from "@/models/skill-share-link-revision";
import { parseSkillManifest } from "@/skills/parser";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
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
    allowedTools: null,
    templated: false,
    metadata: {},
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    files: [],
    ...overrides,
  };
}

function makeRequest(
  linkId: string,
  overrides: Partial<Omit<MaterializeRequest, "linkId">> = {},
): MaterializeRequest {
  return {
    linkId,
    marketplaceName: "org-abcd1234-skills",
    ownerName: "Acme Corp",
    displayName: "Acme Skills",
    skills: [makeSkill()],
    ...overrides,
  };
}

/**
 * Revision rows FK to `skill_share_links`, so every test that materializes
 * needs a real link row; each call seeds an isolated org/user/skill chain.
 */
async function seedLink(fx: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (userId: string, organizationId: string) => Promise<unknown>;
}): Promise<string> {
  const org = await fx.makeOrganization();
  const user = await fx.makeUser();
  await fx.makeMember(user.id, org.id);
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: org.id,
      authorId: null,
      name: "shared-skill",
      description: "shared skill description",
      content: "# shared skill",
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  const { link } = await SkillShareLinkModel.create({
    organizationId: org.id,
    createdByUserId: user.id,
    skillIds: [skill.id],
    marketplaceName: "org-abcd1234-skills",
  });
  return link.id;
}

describe("MarketplaceMaterializer", () => {
  let cacheDir: string;
  let materializer: MarketplaceMaterializer;
  let linkId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    cacheDir = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-materialize-test-"),
    );
    materializer = new MarketplaceMaterializer({ cacheDir });
    linkId = await seedLink({ makeOrganization, makeUser, makeMember });
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  test("produces the documented on-disk layout for a single skill", async () => {
    const req = makeRequest(linkId, {
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
    expect(result.repoPath).toBe(path.join(cacheDir, linkId, "repo"));

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
    // Simulate a concurrent replica winning the same sequence: the first
    // append persists the winner's row for real, then re-appends with the
    // same sequence so the caller receives a genuine unique violation from
    // the real index. The materializer must catch it and reuse the winner's
    // revision, not surface the error.
    const realAppend = SkillShareLinkRevisionModel.append.bind(
      SkillShareLinkRevisionModel,
    );
    const spy = vi
      .spyOn(SkillShareLinkRevisionModel, "append")
      .mockImplementationOnce(async (params, sequence) => {
        await realAppend(params, sequence);
        return realAppend(params, sequence);
      });

    try {
      const result = await materializer.materialize(makeRequest(linkId));

      expect(result.reused).toBe(true);
      expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
      // only the one revision the "winner" wrote exists — no duplicate sequence
      expect(await SkillShareLinkRevisionModel.listByLink(linkId)).toHaveLength(
        1,
      );
    } finally {
      // the global test setup clears mocks but does not restore originals
      spy.mockRestore();
    }
  });

  test("SKILL.md frontmatter round-trips through the parser", async () => {
    const req = makeRequest(linkId, {
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
    const req = makeRequest(linkId, {
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
    const req = makeRequest(linkId, {
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
    const req = makeRequest(linkId, {
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
    const req = makeRequest(linkId, {
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
    const req = makeRequest(linkId, { skills });
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
    const req = makeRequest(linkId);
    const first = await materializer.materialize(req);
    expect(first.reused).toBe(false);

    const second = await materializer.materialize(req);
    expect(second.reused).toBe(true);
    expect(second.commitHash).toBe(first.commitHash);
    expect(second.contentHash).toBe(first.contentHash);

    // and only one revision was persisted
    const revs = await SkillShareLinkRevisionModel.listByLink(linkId);
    expect(revs).toHaveLength(1);
  });

  test("changed content advances HEAD with a child commit (no unrelated histories)", async () => {
    const first = await materializer.materialize(makeRequest(linkId));

    const updatedSkill = makeSkill({
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      content: "# Updated body",
    });
    const second = await materializer.materialize(
      makeRequest(linkId, { skills: [updatedSkill] }),
    );

    expect(second.reused).toBe(false);
    expect(second.commitHash).not.toBe(first.commitHash);

    const parent = await readParent(second.repoPath);
    expect(parent).toBe(first.commitHash);

    // both revisions persisted with parent chain
    const revs = await SkillShareLinkRevisionModel.listByLink(linkId);
    expect(revs).toHaveLength(2);
    expect(revs[0].parentSha).toBeNull();
    expect(revs[1].parentSha).toBe(revs[0].commitSha);
  });

  test("per-link mutex serializes concurrent calls into a single commit", async () => {
    const req = makeRequest(linkId);
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
    const req = makeRequest(linkId);
    const result = await materializer.materialize(req);
    await expect(fs.access(result.repoPath)).resolves.toBeUndefined();

    await materializer.revoke(linkId);
    await expect(fs.access(result.repoPath)).rejects.toThrow();
  });

  test("sweepOrphans removes directories not in the live link set", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const orphanId = await seedLink({ makeOrganization, makeUser, makeMember });
    await materializer.materialize(makeRequest(linkId));
    await materializer.materialize(
      makeRequest(orphanId, {
        skills: [makeSkill({ id: "22222222-2222-3333-4444-555555555555" })],
      }),
    );

    const removed = await materializer.sweepOrphans([linkId]);
    expect(removed).toEqual([orphanId]);
    await expect(
      fs.access(path.join(cacheDir, linkId)),
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

  test("wiping the cache replays revisions to byte-identical SHAs", async () => {
    const req = makeRequest(linkId);
    const first = await materializer.materialize(req);
    const updated = await materializer.materialize(
      makeRequest(linkId, {
        skills: [makeSkill({ content: "# Updated body" })],
      }),
    );

    // simulate a cache wipe (server reboot, container restart, etc.)
    await fs.rm(materializer.repoPathFor(linkId), {
      recursive: true,
      force: true,
    });

    // re-materializing the same content should not write a new revision
    const replayed = await materializer.materialize(
      makeRequest(linkId, {
        skills: [makeSkill({ content: "# Updated body" })],
      }),
    );

    expect(replayed.reused).toBe(true);
    expect(replayed.commitHash).toBe(updated.commitHash);

    // and the on-disk history must match: HEAD == updated, HEAD^ == first
    expect(await diskHead(replayed.repoPath)).toBe(updated.commitHash);
    expect(await readParent(replayed.repoPath)).toBe(first.commitHash);

    // store still holds exactly two revisions
    expect(await SkillShareLinkRevisionModel.listByLink(linkId)).toHaveLength(
      2,
    );
  });

  test("same content materialized twice produces the same commit SHA across instances", async () => {
    const req = makeRequest(linkId);

    // first instance writes revision 1
    const firstResult = await materializer.materialize(req);

    // second instance with a fresh cache but the same revision history — must
    // replay to identical SHA, not produce a new commit
    const cacheDir2 = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-materialize-test-"),
    );
    try {
      const materializer2 = new MarketplaceMaterializer({
        cacheDir: cacheDir2,
      });
      const replayed = await materializer2.materialize(req);
      expect(replayed.reused).toBe(true);
      expect(replayed.commitHash).toBe(firstResult.commitHash);
      expect(await diskHead(replayed.repoPath)).toBe(firstResult.commitHash);
      expect(await SkillShareLinkRevisionModel.listByLink(linkId)).toHaveLength(
        1,
      );
    } finally {
      await fs.rm(cacheDir2, { recursive: true, force: true });
    }
  });

  test("commit author and committer use the configured identity", async () => {
    const identity = { name: "Test Marketplace", email: "test@example.com" };
    const m = new MarketplaceMaterializer({ cacheDir, identity });
    const result = await m.materialize(makeRequest(linkId));
    const meta = await readCommitMeta(result.repoPath);
    expect(meta.authorName).toBe(identity.name);
    expect(meta.authorEmail).toBe(identity.email);
    expect(meta.committerName).toBe(identity.name);
    expect(meta.committerEmail).toBe(identity.email);
  });
});

// ===== test helpers =====

const execFileAsync = promisify(execFile);

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout.trim();
}

async function readParent(repoPath: string): Promise<string | null> {
  try {
    return await git(repoPath, "rev-parse", "HEAD^");
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/unknown revision/.test(stderr)) return null;
    throw error;
  }
}

async function commitCount(repoPath: string): Promise<number> {
  return Number.parseInt(
    await git(repoPath, "rev-list", "--count", "HEAD"),
    10,
  );
}

function diskHead(repoPath: string): Promise<string> {
  return git(repoPath, "rev-parse", "HEAD");
}

async function readCommitMeta(repoPath: string): Promise<{
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}> {
  const [authorName, authorEmail, committerName, committerEmail] = (
    await git(repoPath, "log", "-1", "--pretty=%an%n%ae%n%cn%n%ce")
  ).split("\n");
  return { authorName, authorEmail, committerName, committerEmail };
}
