import { ADMIN_ROLE_NAME } from "@archestra/shared";
import GithubPatModel from "@/models/github-pat";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, describe, expect, test } from "@/test";
import { buildGithubPatTestApp } from "./github-pat.test-helpers";

describe("PUT /api/github-pats/:id", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("renames without touching the secret; rotates when a token is sent", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const created = await createGithubPat({
      organizationId: organization.id,
      data: { name: "original", token: "ghp_v1" },
    });
    const stored = await GithubPatModel.findByIdForOrganization({
      id: created.id,
      organizationId: organization.id,
    });
    const secretId = stored?.secretId;
    if (!secretId) throw new Error("expected a stored secret id");

    // rename only — the stored token stays intact
    const renamed = await app.inject({
      method: "PUT",
      url: `/api/github-pats/${created.id}`,
      payload: { name: "renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("renamed");
    const unrotated = await secretManager().getSecret(secretId);
    expect((unrotated?.secret as { apiToken?: string })?.apiToken).toBe(
      "ghp_v1",
    );

    // sending a token rotates the secret in place
    const rotated = await app.inject({
      method: "PUT",
      url: `/api/github-pats/${created.id}`,
      payload: { token: "ghp_v2" },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedSecret = await secretManager().getSecret(secretId);
    expect((rotatedSecret?.secret as { apiToken?: string })?.apiToken).toBe(
      "ghp_v2",
    );
  });

  test("404s for another organization's token", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    const otherOrg = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const foreign = await createGithubPat({
      organizationId: otherOrg.id,
      data: { name: "foreign", token: "ghp_x" },
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/github-pats/${foreign.id}`,
      payload: { name: "hijack" },
    });
    expect(response.statusCode).toBe(404);
  });
});
