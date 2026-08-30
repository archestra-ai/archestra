import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

describe("Execution credential routes", () => {
  let app: FastifyInstanceWithZod;
  let agent: Agent;
  let user: User;
  let organizationId: string;
  let previousFeatureEnabled: boolean;
  let previousClusterReachable: unknown;

  beforeEach(async ({ makeAgent, makeAdmin, makeMember, makeOrganization }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });
    agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
      backgroundExecution: {
        image: "example.com/coding-agent:latest",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: [
          {
            key: "GITHUB_TOKEN",
            credentialId: "github",
            scope: "per_user",
            label: "GitHub token",
            required: true,
          },
        ],
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./execution-credential.routes");
    await app.register(routes);

    previousFeatureEnabled = config.agentBackgroundExecution.enabled;
    previousClusterReachable = Reflect.get(
      runnerRuntimeManager,
      "clusterReachable",
    );
    config.agentBackgroundExecution.enabled = true;
    Reflect.set(runnerRuntimeManager, "clusterReachable", true);
  });

  afterEach(async () => {
    config.agentBackgroundExecution.enabled = previousFeatureEnabled;
    Reflect.set(
      runnerRuntimeManager,
      "clusterReachable",
      previousClusterReachable,
    );
    await app.close();
  });

  test("lists built-ins and tracks a personal connection without exposing its value", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/execution-credentials",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "github",
          builtIn: true,
          personalConfigured: false,
          organizationConfigured: false,
        }),
      ]),
    );

    const connected = await app.inject({
      method: "PUT",
      url: "/api/execution-credentials/github/personal",
      payload: { value: "personal-github-token" },
    });
    expect(connected.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: "/api/execution-credentials",
    });
    const github = listed
      .json<Array<Record<string, unknown>>>()
      .find((definition) => definition.key === "github");
    expect(github).toEqual(
      expect.objectContaining({
        personalConfigured: true,
        organizationConfigured: false,
      }),
    );
    expect(JSON.stringify(listed.json())).not.toContain(
      "personal-github-token",
    );
  });

  test("lists Agents that use a credential", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/execution-credentials/github/usage",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [{ id: agent.id, name: agent.name }],
    });
  });

  test("creates a custom credential and reuses its organization connection", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/execution-credentials",
      payload: {
        key: "gitlab-pat",
        name: "GitLab access token",
        description: "Access GitLab repositories",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    expect(created.statusCode).toBe(200);

    const connected = await app.inject({
      method: "PUT",
      url: "/api/execution-credentials/gitlab-pat/organization",
      payload: { value: "shared-gitlab-token" },
    });
    expect(connected.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: "/api/execution-credentials",
    });
    expect(
      listed
        .json<Array<{ key: string }>>()
        .slice(0, 2)
        .map(({ key }) => key),
    ).toEqual(["claude-code", "github"]);
    expect(listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "gitlab-pat",
          builtIn: false,
          organizationConfigured: true,
        }),
      ]),
    );

    const [audit] = await db
      .select({
        action: schema.auditLogsTable.action,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, organizationId),
          eq(schema.auditLogsTable.action, "executionCredential.updated"),
        ),
      );
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain("shared-gitlab-token");
  });

  test("rejects an organization connection for a personal-only credential", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/execution-credentials/github/organization",
      payload: { value: "not-stored" },
    });

    expect(response.statusCode).toBe(400);
  });

  test("hides credential endpoints when Background execution is disabled", async () => {
    config.agentBackgroundExecution.enabled = false;

    const response = await app.inject({
      method: "GET",
      url: "/api/execution-credentials",
    });

    expect(response.statusCode).toBe(404);
  });
});
