import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillModel, SkillShareLinkModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { marketplaceMaterializer } from "@/skills/marketplace";
import { MarketplaceMaterializer } from "@/skills/marketplace/materialize";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";

async function seedSkill(params: {
  organizationId: string;
  name: string;
  content?: string;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: params.content ?? `# ${params.name}\n\nbody`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

async function buildApp(): Promise<FastifyInstanceWithZod> {
  const app = createFastifyInstance();
  const { default: skillMarketplacePublicRoutes } = await import(
    "./skill-marketplace-public"
  );
  await app.register(skillMarketplacePublicRoutes);
  return app;
}

const GIT_HTTP_BACKEND_AVAILABLE = (() => {
  // Probe by running `git http-backend` with empty CGI env; presence is enough
  // to flip the integration test on. Errors → backend missing, skip cleanly.
  try {
    const result = spawnSync("git", ["http-backend"], {
      env: { PATH: process.env.PATH ?? "" },
    });
    if (result.error) return false;
    // git http-backend errors loudly when CGI env is missing; the binary
    // existing is all we need.
    const stderr = (result.stderr ?? Buffer.from("")).toString();
    return !/is not a git command/.test(stderr);
  } catch {
    return false;
  }
})();

describe("skill marketplace public route — token validation", () => {
  let app: FastifyInstanceWithZod;
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(
      path.join(tmpdir(), "archestra-marketplace-routes-"),
    );
    marketplaceMaterializer.reset();
    vi.spyOn(marketplaceMaterializer, "get").mockReturnValue(
      new MarketplaceMaterializer({ cacheDir }),
    );
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    marketplaceMaterializer.reset();
  });

  test("unknown token returns 404", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/skills/m/archestra_skl_unknown/repo.git/info/refs?service=git-upload-pack",
    });
    expect(response.statusCode).toBe(404);
  });

  test("GET info/refs without service=git-upload-pack returns 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/skills/m/archestra_skl_unknown/repo.git/info/refs",
    });
    expect(response.statusCode).toBe(403);
  });

  test("GET info/refs with service=git-receive-pack returns 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/skills/m/archestra_skl_unknown/repo.git/info/refs?service=git-receive-pack",
    });
    expect(response.statusCode).toBe(403);
  });

  test("POST git-receive-pack returns 403", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/skills/m/archestra_skl_unknown/repo.git/git-receive-pack",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      payload: "",
    });
    expect(response.statusCode).toBe(403);
  });

  test("revoked link returns 404 (same shape as miss — no leak)", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({
      organizationId: org.id,
      name: "revoke-me",
    });

    const { link, rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-test-skills",
    });
    await SkillShareLinkModel.revoke({ id: link.id, organizationId: org.id });

    const response = await app.inject({
      method: "GET",
      url: `/skills/m/${rawToken}/repo.git/info/refs?service=git-upload-pack`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("expired link returns 404", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({
      organizationId: org.id,
      name: "expire-me",
    });

    const { rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-test-skills",
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await app.inject({
      method: "GET",
      url: `/skills/m/${rawToken}/repo.git/info/refs?service=git-upload-pack`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe.skipIf(!GIT_HTTP_BACKEND_AVAILABLE)(
  "skill marketplace public route — git clone integration",
  () => {
    let app: FastifyInstanceWithZod;
    let cacheDir: string;
    let cloneDir: string;
    let baseUrl: string;

    beforeEach(async () => {
      cacheDir = await fs.mkdtemp(
        path.join(tmpdir(), "archestra-marketplace-int-"),
      );
      cloneDir = await fs.mkdtemp(
        path.join(tmpdir(), "archestra-marketplace-clone-"),
      );
      marketplaceMaterializer.reset();
      vi.spyOn(marketplaceMaterializer, "get").mockReturnValue(
        new MarketplaceMaterializer({ cacheDir }),
      );
      app = await buildApp();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await app.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.rm(cloneDir, { recursive: true, force: true });
      vi.restoreAllMocks();
      marketplaceMaterializer.reset();
    });

    test("git clone fetches a valid marketplace repo for a single skill", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const skill = await seedSkill({
        organizationId: org.id,
        name: "Clone Me",
        content: "# Clone Me\n\nDoes things.",
      });

      const { rawToken } = await SkillShareLinkModel.create({
        organizationId: org.id,
        createdByUserId: user.id,
        skillIds: [skill.id],
        marketplaceName: "org-test-skills",
      });

      const cloneUrl = `${baseUrl}/skills/m/${rawToken}/repo.git`;
      const target = path.join(cloneDir, "out");
      // must be async spawn — spawnSync blocks the event loop in this same
      // process, which prevents the in-process Fastify server from servicing
      // the incoming git request and deadlocks the test.
      const result = await runGitClone(cloneUrl, target);
      if (result.code !== 0) {
        throw new Error(
          `git clone failed (${result.code}, signal=${result.signal ?? "none"}): ${result.stderr}`,
        );
      }

      const claudeManifest = JSON.parse(
        await fs.readFile(
          path.join(target, ".claude-plugin/marketplace.json"),
          "utf8",
        ),
      );
      expect(claudeManifest.name).toBe("org-test-skills");
      // single bundle plugin named after the marketplace; individual skills
      // live as subdirs under that plugin's skills/ directory.
      expect(claudeManifest.plugins).toHaveLength(1);
      expect(claudeManifest.plugins[0].name).toBe("org-test-skills");
      expect(claudeManifest.plugins[0].source).toBe(
        "./plugins/org-test-skills",
      );

      const codexManifest = JSON.parse(
        await fs.readFile(
          path.join(target, ".agents/plugins/marketplace.json"),
          "utf8",
        ),
      );
      expect(codexManifest.plugins[0].source).toEqual({
        source: "local",
        path: "./plugins/org-test-skills",
      });

      const cursorManifest = JSON.parse(
        await fs.readFile(
          path.join(target, ".cursor-plugin/marketplace.json"),
          "utf8",
        ),
      );
      expect(cursorManifest.plugins).toHaveLength(1);
      expect(cursorManifest.plugins[0].source).toBe(
        "./plugins/org-test-skills",
      );

      const skillMd = await fs.readFile(
        path.join(target, "plugins/org-test-skills/skills/clone-me/SKILL.md"),
        "utf8",
      );
      expect(skillMd).toContain("name: clone-me");
      expect(skillMd).toContain("# Clone Me");
    }, 30_000);
  },
);

async function runGitClone(
  cloneUrl: string,
  target: string,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("git", ["clone", "--quiet", cloneUrl, target], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);
    child.once("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stderr });
    });
  });
}
