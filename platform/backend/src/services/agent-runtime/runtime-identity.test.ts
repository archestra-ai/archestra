import { randomUUID } from "node:crypto";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  VirtualApiKeyModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { AgentRunActorKind } from "@/types/agent-runtime";
import {
  issueRuntimeBinding,
  resolveGatewayRuntimeSession,
  resolveRuntimeIdentityByVirtualKeys,
  resolveRuntimeSessionForWorkspace,
  runtimeBindingAuthorizes,
  runtimeOpenAppaSession,
  runtimeSessionConflicts,
  stampRuntimeBinding,
  workloadPrincipal,
} from "./runtime-identity";

const SECRET = "test-runtime-binding-secret-32chars";

async function persistWorkspace(params: {
  organizationId: string;
  agentId: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  actorUserId?: string | null;
  workloadName?: string;
}) {
  const task = await A2ATaskModel.create({
    contextId: (
      await A2AContextModel.create({
        actorKind: params.actorKind,
        actorId: params.actorId,
      })
    ).id,
    agentId: params.agentId,
    state: "TASK_STATE_WORKING",
  });
  const workloadName = params.workloadName ?? `workspace-${task.id}`;
  const virtualKey = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `run-${task.id.slice(0, 8)}`,
    scope: params.actorKind === "user" ? "personal" : "org",
    authorId: params.actorUserId ?? null,
  });
  const workspace = await AgentWorkspaceModel.create({
    organizationId: params.organizationId,
    agentId: params.agentId,
    actorKind: params.actorKind,
    actorId: params.actorId,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const run = await AgentRunModel.create({
    organizationId: params.organizationId,
    taskId: task.id,
    agentId: params.agentId,
    actorKind: params.actorKind,
    actorId: params.actorId,
    actorUserId: params.actorUserId ?? null,
    workloadName,
    backend: "kubernetes",
    runtimeScope: "test",
    virtualApiKeyId: virtualKey.virtualKey.id,
  });
  return { task, workspace, run, virtualKeyId: virtualKey.virtualKey.id };
}

describe("runtime OpenAPPA identity", () => {
  test("application workspace bindings cannot be used by another application or task", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const current = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "oauthClient",
      actorId: "mcp_oauth_first",
    });
    const binding = issueRuntimeBinding({
      secret: SECRET,
      organizationId: org.id,
      agentId: agent.id,
      workspaceId: current.workspace.id,
      workloadName: current.workspace.workloadName,
      taskId: current.task.id,
      actorKind: "oauthClient",
      actorId: "mcp_oauth_first",
      expiresAt: Date.now() + 60_000,
    });
    if (!binding) throw new Error("Expected signed runtime binding");
    const resolve = (oauthClientId: string, runTaskId = current.task.id) =>
      resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token: { isOrganizationToken: false, oauthClientId },
        secret: SECRET,
        bindingToken: binding,
        runTaskId,
      });
    expect(await resolve("mcp_oauth_first")).toMatchObject({
      kind: "session",
      identity: {
        actorKind: "oauthClient",
        actorId: "mcp_oauth_first",
        workspaceId: current.workspace.id,
      },
    });
    expect(await resolve("mcp_oauth_second")).toMatchObject({ kind: "reject" });
    expect(await resolve("mcp_oauth_first", randomUUID())).toMatchObject({
      kind: "reject",
    });
    expect(
      await resolveRuntimeIdentityByVirtualKeys({
        organizationId: org.id,
        virtualKeyIds: [current.virtualKeyId],
      }),
    ).toMatchObject({
      status: "bound",
      identity: { actorKind: "oauthClient", actorId: "mcp_oauth_first" },
    });
  });

  test("the launcher stamps only secret environment from persisted identity and refuses replay on a sibling", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const run = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "organization",
      actorId: org.id,
    });
    const prior = config.openappa.offerSigningSecret;
    config.openappa.offerSigningSecret = SECRET;
    try {
      const spec = {
        env: { ARCHESTRA_AGENT_RUNTIME_BINDING: "untrusted" } as Record<
          string,
          string
        >,
        secretEnv: {} as Record<string, string>,
        activeDeadlineSeconds: 60,
      };
      await stampRuntimeBinding({
        spec,
        organizationId: org.id,
        workspaceId: run.workspace.id,
        taskId: run.task.id,
      });
      expect(spec.env).not.toHaveProperty("ARCHESTRA_AGENT_RUNTIME_BINDING");
      const token = spec.secretEnv.ARCHESTRA_AGENT_RUNTIME_BINDING;
      const resolved = await resolveRuntimeIdentityByVirtualKeys({
        organizationId: org.id,
        virtualKeyIds: [run.virtualKeyId],
      });
      if (resolved.status !== "bound")
        throw new Error("The persisted fixture is unbound");
      expect(
        runtimeBindingAuthorizes({
          token,
          secret: SECRET,
          identity: resolved.identity,
        }),
      ).toBe(true);
      expect(
        runtimeBindingAuthorizes({
          token: `${token}tampered`,
          secret: SECRET,
          identity: resolved.identity,
        }),
      ).toBe(false);
      expect(
        runtimeBindingAuthorizes({
          token,
          secret: SECRET,
          identity: { ...resolved.identity, workspaceId: randomUUID() },
        }),
      ).toBe(false);
      expect(
        runtimeBindingAuthorizes({
          token,
          secret: SECRET,
          identity: resolved.identity,
          now: Date.now() + 120_000,
        }),
      ).toBe(false);
      await expect(
        stampRuntimeBinding({
          spec,
          organizationId: org.id,
          workspaceId: run.workspace.id,
          taskId: randomUUID(),
        }),
      ).rejects.toThrow("persisted workspace");
    } finally {
      config.openappa.offerSigningSecret = prior;
    }
  });

  test("two virtual keys for one workspace share a principal a sibling key does not", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const actorId = randomUUID();
    const first = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
    });
    const continuation = await A2ATaskModel.create({
      contextId: (await A2AContextModel.create({ actorKind: "team", actorId }))
        .id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const secondKey = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: `run-${continuation.id.slice(0, 8)}`,
      scope: "org",
    });
    await AgentRunModel.create({
      organizationId: org.id,
      taskId: continuation.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
      actorUserId: null,
      workloadName: first.workspace.workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
      virtualApiKeyId: secondKey.virtualKey.id,
    });
    const sibling = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
    });

    const firstLookup = await resolveRuntimeIdentityByVirtualKeys({
      virtualKeyIds: [first.virtualKeyId],
      organizationId: org.id,
    });
    const secondLookup = await resolveRuntimeIdentityByVirtualKeys({
      virtualKeyIds: [secondKey.virtualKey.id],
      organizationId: org.id,
    });
    const siblingLookup = await resolveRuntimeIdentityByVirtualKeys({
      virtualKeyIds: [sibling.virtualKeyId],
      organizationId: org.id,
    });
    const firstIdentity =
      firstLookup.status === "bound" ? firstLookup.identity : null;
    const secondIdentity =
      secondLookup.status === "bound" ? secondLookup.identity : null;
    const siblingIdentity =
      siblingLookup.status === "bound" ? siblingLookup.identity : null;

    expect(firstIdentity?.principal).toBe(
      workloadPrincipal(first.workspace.id),
    );
    expect(secondIdentity).toMatchObject({
      principal: firstIdentity?.principal,
      workspaceId: first.workspace.id,
      workloadName: first.workspace.workloadName,
      actorUserId: null,
      taskId: continuation.id,
    });
    expect(firstIdentity?.principal).not.toBe(
      `virtual-key:${first.virtualKeyId}`,
    );
    expect(siblingIdentity?.principal).not.toBe(firstIdentity?.principal);
    expect(
      runtimeSessionConflicts({
        workloadName: first.workspace.workloadName,
        presentedSession: sibling.workspace.workloadName,
      }),
    ).toBe(true);
    expect(
      runtimeSessionConflicts({
        workloadName: first.workspace.workloadName,
        presentedSession: first.workspace.workloadName,
      }),
    ).toBe(false);
  });

  test("a virtual key for another organization or no run is not this workspace", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const bound = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "organization",
      actorId: org.id,
    });
    const loose = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "unbound",
      scope: "org",
    });

    expect(
      await resolveRuntimeIdentityByVirtualKeys({
        virtualKeyIds: [bound.virtualKeyId],
        organizationId: other.id,
      }),
    ).toEqual({ status: "unbound" });
    expect(
      await resolveRuntimeIdentityByVirtualKeys({
        virtualKeyIds: [loose.virtualKey.id],
        organizationId: org.id,
      }),
    ).toEqual({ status: "unbound" });
  });

  test("a user runtime key stays user-scoped and does not invent a workspace principal", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const bound = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
    });

    const lookup = await resolveRuntimeIdentityByVirtualKeys({
      virtualKeyIds: [bound.virtualKeyId],
      organizationId: org.id,
    });
    const identity = lookup.status === "bound" ? lookup.identity : null;
    expect(identity).toMatchObject({
      principal: `user:${user.id}`,
      actorUserId: user.id,
      workloadName: bound.workspace.workloadName,
    });
    if (!identity) throw new Error("missing user runtime identity");
    expect(runtimeOpenAppaSession(identity)).toEqual({
      organization_id: org.id,
      caller_id: `user:${user.id}`,
      session_id: `user:${user.id}|${bound.workspace.workloadName}`,
    });
  });

  test("a shared actor token cannot select a sibling workspace without a binding for it", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const actorId = randomUUID();
    const owned = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
    });
    const sibling = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
    });
    const otherTeam = randomUUID();
    const binding = issueRuntimeBinding({
      secret: SECRET,
      organizationId: org.id,
      workspaceId: owned.workspace.id,
      workloadName: owned.workspace.workloadName,
      taskId: owned.task.id,
      agentId: agent.id,
      actorKind: "team",
      actorId,
      expiresAt: Date.now() + 60_000,
    });
    if (!binding) throw new Error("runtime binding was not issued");
    const token = {
      teamId: actorId,
      isOrganizationToken: false,
    };

    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        bindingToken: binding,
        secret: SECRET,
        sessionName: owned.workspace.workloadName,
        runTaskId: owned.task.id,
      }),
    ).toMatchObject({
      kind: "session",
      identity: { principal: workloadPrincipal(owned.workspace.id) },
    });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        bindingToken: binding,
        secret: SECRET,
        sessionName: sibling.workspace.workloadName,
        runTaskId: owned.task.id,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        secret: SECRET,
        sessionName: sibling.workspace.workloadName,
        runTaskId: sibling.task.id,
      }),
    ).toEqual({ kind: "none" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token: { teamId: otherTeam, isOrganizationToken: false },
        bindingToken: binding,
        secret: SECRET,
        sessionName: owned.workspace.workloadName,
        runTaskId: owned.task.id,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token: { teamId: null, isOrganizationToken: true },
        bindingToken: binding,
        secret: SECRET,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        bindingToken: binding,
        secret: SECRET,
        now: Date.now() + 120_000,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  test("a service account acting for a team owns its own run, never the team's", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const teamId = randomUUID();
    const serviceAccountId = randomUUID();
    const bindingFor = async (
      actorKind: "team" | "serviceAccount",
      actorId: string,
    ) => {
      const { workspace, task } = await persistWorkspace({
        organizationId: org.id,
        agentId: agent.id,
        actorKind,
        actorId,
      });
      const binding = issueRuntimeBinding({
        secret: SECRET,
        organizationId: org.id,
        workspaceId: workspace.id,
        workloadName: workspace.workloadName,
        taskId: task.id,
        agentId: agent.id,
        actorKind,
        actorId,
        expiresAt: Date.now() + 60_000,
      });
      if (!binding) throw new Error("runtime binding was not issued");
      return { binding, workspace, task };
    };
    const own = await bindingFor("serviceAccount", serviceAccountId);
    const team = await bindingFor("team", teamId);
    const token = { serviceAccountId, teamId, isOrganizationToken: false };

    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        bindingToken: own.binding,
        secret: SECRET,
        sessionName: own.workspace.workloadName,
        runTaskId: own.task.id,
      }),
    ).toMatchObject({ kind: "session" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token,
        bindingToken: team.binding,
        secret: SECRET,
        sessionName: team.workspace.workloadName,
        runTaskId: team.task.id,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  test("a workspace's runtime session resolves only in its own organization", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const team = await persistWorkspace({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId: randomUUID(),
    });
    const principal = workloadPrincipal(team.workspace.id);
    expect(
      await resolveRuntimeSessionForWorkspace({
        organizationId: other.id,
        workspaceId: team.workspace.id,
      }),
    ).toBeNull();
    expect(
      (
        await resolveRuntimeSessionForWorkspace({
          organizationId: org.id,
          workloadName: team.workspace.workloadName,
        })
      )?.session.caller_id,
    ).toBe(principal);
  });
});
