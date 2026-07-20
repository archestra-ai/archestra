import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import AuditLogModel from "@/models/audit-log";
import GithubPatModel from "@/models/github-pat";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import {
  buildGithubPatTestApp,
  settleAuditWrites,
} from "./github-pat.test-helpers";

describe("POST /api/github-pats", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("stores the token in the secret manager and never returns it", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/github-pats",
      payload: { name: "Skills token", token: "ghp_secret_value" },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.name).toBe("Skills token");
    // the token and its secret reference must never leave the API
    expect(body.token).toBeUndefined();
    expect(body.secretId).toBeUndefined();

    const stored = await GithubPatModel.findByIdForOrganization({
      id: body.id,
      organizationId: organization.id,
    });
    const secretId = stored?.secretId;
    if (!secretId) throw new Error("expected a stored secret id");
    const secret = await secretManager().getSecret(secretId);
    expect((secret?.secret as { apiToken?: string })?.apiToken).toBe(
      "ghp_secret_value",
    );

    await settleAuditWrites();
    const { data: auditRows } = await AuditLogModel.findPaginated({
      organizationId: organization.id,
      resourceType: "githubPat",
      sortDirection: "asc",
      limit: 10,
      offset: 0,
    });
    expect(auditRows.map((row) => row.action)).toEqual(["githubPat.created"]);
  });

  test("default members cannot store tokens", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: MEMBER_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/github-pats",
      payload: { name: "Nope", token: "ghp_x" },
    });
    expect(created.statusCode).toBe(403);
  });
});
