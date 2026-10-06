import { eq } from "drizzle-orm";
import { authPlugin } from "@/auth/fastify-plugin";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { FileModel, OrganizationModel, PublicFileLinkModel } from "@/models";
import { publicFileSharing } from "@/public-files/public-file-sharing";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import publicFilesRoutes from "./public-files.routes";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-the-image"),
]);

describe("GET /public-files/:token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let url: string;
  let linkId: string;
  let fileId: string;
  let userId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    userId = user.id;
    await OrganizationModel.patch(organizationId, {
      allowPublicFileSharing: true,
    });
    const file = await fileStore.put({
      organizationId,
      userId: user.id,
      projectId: null,
      conversationId: null,
      filename: "launch banner.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      data: PNG,
    });
    fileId = file.id;
    const shared = await publicFileSharing.share({
      organizationId,
      userId: user.id,
      agentId: null,
      conversationId: null,
      file: { id: file.id, filename: file.filename, data: PNG },
    });
    if ("error" in shared) throw new Error(shared.message);
    linkId = shared.link.id;
    url = new URL(shared.url).pathname;

    // The real auth middleware, with no session on any request: the public
    // route must answer anyway, and nothing else may.
    app = createFastifyInstance();
    await app.register(authPlugin);
    await app.register(publicFilesRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("serves the bytes to an anonymous caller with locked-down headers", async () => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.equals(PNG)).toBe(true);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": 'inline; filename="launch banner.png"',
      "cache-control": "public, max-age=600",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  test("the token alone authorizes: the filename suffix is optional", async () => {
    const tokenOnly = url.split("/").slice(0, 3).join("/");
    const response = await app.inject({ method: "GET", url: tokenOnly });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(PNG)).toBe(true);
  });

  test("HEAD answers with the headers and no body", async () => {
    const response = await app.inject({ method: "HEAD", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe(String(PNG.byteLength));
    expect(response.body).toBe("");
  });

  test("serves a single byte range for seeking players", async () => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { range: "bytes=2-5" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(
      `bytes 2-5/${PNG.byteLength}`,
    );
    expect(response.rawPayload.equals(PNG.subarray(2, 6))).toBe(true);
  });

  test("revoked, unknown, and switched-off links are the same 404", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: `/public-files/${"A".repeat(32)}/x.png`,
    });

    await OrganizationModel.patch(organizationId, {
      allowPublicFileSharing: false,
    });
    const switchedOff = await app.inject({ method: "GET", url });
    await OrganizationModel.patch(organizationId, {
      allowPublicFileSharing: true,
    });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);

    await PublicFileLinkModel.revoke({ id: linkId, organizationId });
    const revoked = await app.inject({ method: "GET", url });

    for (const response of [unknown, switchedOff, revoked]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(unknown.body);
    }
  });

  test("serves the copy frozen at share time, whatever happens to the source", async () => {
    // A post scheduled hours ahead must fetch exactly what was approved.
    const row = await FileModel.findById(fileId);
    if (!row) throw new Error("file row missing");
    await fileStore.update({
      file: row,
      mimeType: "image/png",
      sizeBytes: 23,
      data: Buffer.from("<html><script></script>"),
    });
    const afterEdit = await app.inject({ method: "GET", url });
    expect(afterEdit.statusCode).toBe(200);
    expect(afterEdit.rawPayload.equals(PNG)).toBe(true);

    expect(
      await fileStore.delete({ ref: fileId, organizationId, userId }),
    ).toBe(true);
    const afterDelete = await app.inject({ method: "GET", url });
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.rawPayload.equals(PNG)).toBe(true);
  });

  test("revoking is the one way down, and it drops the frozen bytes", async () => {
    await PublicFileLinkModel.revoke({ id: linkId, organizationId });

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    const [row] = await db
      .select({ data: schema.publicFileLinksTable.data })
      .from(schema.publicFileLinksTable)
      .where(eq(schema.publicFileLinksTable.id, linkId));
    expect(row.data).toBeNull();
  });

  test("other methods on the prefix still require a session", async () => {
    const response = await app.inject({ method: "POST", url });
    expect(response.statusCode).toBe(401);
  });
});
