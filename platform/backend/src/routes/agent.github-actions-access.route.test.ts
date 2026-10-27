import type { GitHubActionsAccess } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import {
  AgentModel,
  AuditLogModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import type { User } from "@/types";
import agentRoutes from "./agent";

const SETTING: GitHubActionsAccess = {
  githubAppCredentialKey: "review-app",
  repositories: ["acme/widgets"],
  workflows: [
    "acme/review-workflows/.github/workflows/review.yml@refs/heads/main",
  ],
};

describe("PUT /api/agents/:id with githubActionsAccess", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let editor: User;
  let gatewayId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      organizationId = (await makeOrganization()).id;
      admin = await makeAdmin();
      await makeMember(admin.id, organizationId, { role: "admin" });
      // A member who may edit this one gateway, and nothing more.
      editor = await makeUser();
      await makeMember(editor.id, organizationId);
      gatewayId = (
        await makeAgent({
          organizationId,
          agentType: "mcp_gateway",
          authorId: admin.id,
          access: { users: [editor.id], preset: "edit" },
        })
      ).id;
      app = await authenticatedRouteApp({
        organizationId,
        routes: [agentRoutes],
        auditLog: true,
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("saves the setting for an editor who may use the GitHub App, and audits it", async () => {
    await makeReviewApp({ usableBy: "organization" });

    const response = await update(editor, { githubActionsAccess: SETTING });

    expect(response.statusCode).toBe(200);
    expect(response.json().githubActionsAccess).toEqual(SETTING);
    const [record] = await auditRecords();
    expect(record).toMatchObject({
      action: "agent.updated",
      outcome: "success",
      resourceId: gatewayId,
      actorId: editor.id,
    });
    expect(record.before).toMatchObject({ githubActionsAccess: null });
    expect(record.after).toMatchObject({ githubActionsAccess: SETTING });
  });

  test("refuses the setting when the editor may not use the GitHub App", async () => {
    await makeReviewApp({ usableBy: "admin" });

    const response = await update(editor, { githubActionsAccess: SETTING });

    expect(response.statusCode).toBe(403);
    expect(
      (await AgentModel.findGitHubActionsGateway(gatewayId))
        ?.githubActionsAccess,
    ).toBeNull();
  });

  test("lets the editor turn the exchange off without access to the App", async () => {
    await makeReviewApp({ usableBy: "admin" });
    await AgentModel.update(gatewayId, { githubActionsAccess: SETTING });

    const response = await update(editor, { githubActionsAccess: null });

    expect(response.statusCode).toBe(200);
    expect(response.json().githubActionsAccess).toBeNull();
    // Turning it off is a change worth a record of its own.
    const [record] = await auditRecords();
    expect(record).toMatchObject({
      action: "agent.updated",
      resourceId: gatewayId,
    });
    expect(record.before).toMatchObject({ githubActionsAccess: SETTING });
    expect(record.after).toMatchObject({ githubActionsAccess: null });
  });

  test("refuses a credential that is not an organization GitHub App", async () => {
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: admin.id,
      definition: {
        description: "",
        icon: null,
        key: "review-app",
        name: "A token",
        kind: "secret",
        allowPersonal: false,
        allowOrganization: true,
      },
    });

    const response = await update(admin, { githubActionsAccess: SETTING });

    expect(response.statusCode).toBe(400);
  });

  test("refuses a workflow pinned to a pull request ref", async () => {
    await makeReviewApp({ usableBy: "organization" });

    const response = await update(admin, {
      githubActionsAccess: {
        ...SETTING,
        workflows: [
          "acme/widgets/.github/workflows/review.yml@refs/pull/42/merge",
        ],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  // ===== Helpers =====

  function update(as: User, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/agents/${gatewayId}`,
      headers: { [USER_HEADER]: as.id },
      payload,
    });
  }

  async function auditRecords() {
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: gatewayId,
      action: "agent.updated",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    return data;
  }

  async function makeReviewApp(params: { usableBy: "organization" | "admin" }) {
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: admin.id,
      definition: {
        description: "",
        icon: null,
        key: "review-app",
        name: "Code Review App",
        kind: "github_app",
        allowPersonal: false,
        allowOrganization: true,
        githubUrl: "https://api.github.com",
        appId: "123",
        installationId: "456",
        githubClientId: "review-client",
      },
      initialPermissionGrants:
        params.usableBy === "organization"
          ? [
              {
                subject: { type: "organization", id: "*" },
                actions: ["read", "use"],
              },
            ]
          : [
              {
                subject: { type: "user", id: admin.id },
                actions: ["read", "use"],
              },
            ],
    });
  }
});
