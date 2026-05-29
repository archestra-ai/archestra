import { SkillSandboxArtifactModel, SkillSandboxModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_FAKE = Buffer.concat([PNG_HEADER, Buffer.alloc(64, 0xab)]);

async function seedSandbox(params: { organizationId: string; userId: string }) {
  return await SkillSandboxModel.create({
    sandbox: {
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: null,
      defaultCwd: "/sandbox/skills/example",
      primarySkillId: null,
      agentId: null,
    },
    skillIds: [],
  });
}

async function seedArtifact(params: {
  sandboxId: string;
  organizationId: string;
  mimeType: string;
  data: Buffer;
  path?: string;
}) {
  return await SkillSandboxArtifactModel.create({
    sandboxId: params.sandboxId,
    organizationId: params.organizationId,
    path: params.path ?? "/sandbox/skills/example/out.png",
    mimeType: params.mimeType,
    sizeBytes: params.data.byteLength,
    data: params.data,
  });
}

describe("GET /api/skill-sandbox/artifacts/:artifactId", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillSandboxArtifactRoutes } = await import(
      "./skill-sandbox-artifact"
    );
    await app.register(skillSandboxArtifactRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("serves inline-safe images with inline disposition and security headers", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      organizationId,
      mimeType: "image/png",
      data: PNG_FAKE,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.rawPayload).toEqual(PNG_FAKE);
  });

  test("serves SVG as attachment + octet-stream (never inline as HTML)", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const svgPayload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      organizationId,
      mimeType: "image/svg+xml",
      data: svgPayload,
      path: "/sandbox/skills/example/icon.svg",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain("icon.svg");
  });

  test("returns 404 when the artifact's sandbox belongs to another user", async ({
    makeUser,
    makeOrganization,
  }) => {
    const otherUser = await makeUser({ email: "other@test.com" });
    const otherOrg = await makeOrganization();
    const otherSandbox = await seedSandbox({
      organizationId: otherOrg.id,
      userId: otherUser.id,
    });
    const artifact = await seedArtifact({
      sandboxId: otherSandbox.id,
      organizationId: otherOrg.id,
      mimeType: "image/png",
      data: PNG_FAKE,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for unknown artifact id (avoids existence-disclosure)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/artifacts/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  test("sanitizes filename in Content-Disposition", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      organizationId,
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 ..."),
      path: '/sandbox/skills/example/weird"name\\with-quote.pdf',
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    const cd = response.headers["content-disposition"] as string;
    // user-supplied quote and backslash inside the filename are stripped so
    // the header stays parseable. wrapping quotes around filename are fine.
    expect(cd).toMatch(/^attachment; filename="[^"\\]*"$/);
    expect(cd).toContain(".pdf");
  });
});
