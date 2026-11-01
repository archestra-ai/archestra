import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";

vi.mock("@/observability");

/**
 * An agent's own network policy replaces its environment's for the agent's
 * Agent Runtime and Code Sandbox, so it can loosen what an environment
 * administrator locked down. Writing one takes the permission that edits
 * environment policies; everything else about the agent stays editable.
 */
describe("agent routes - per-agent network policy", () => {
  let organizationId: string;
  let admin: User;
  let member: User;
  const apps: FastifyInstanceWithZod[] = [];

  beforeEach(async ({ makeOrganization, makeAdmin, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeAdmin();
    await makeMember(admin.id, organizationId, { role: "admin" });
    member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appFor(user: User) {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
    apps.push(app);
    return app;
  }

  test("stores a normalized policy on create and clears it back to inherit on update", async () => {
    const app = await appFor(admin);
    const reconcile = vi.spyOn(
      daggerEnvironmentRuntimeManager,
      "reconcileAgent",
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Locked agent",
        agentType: "agent",
        networkPolicy: {
          egressMode: "restricted",
          allowedDomains: ["api.example.com"],
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const agentId = created.json().id;
    expect(created.json().networkPolicy).toEqual({
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["api.example.com"],
      allowedCidrs: [],
    });

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}`,
      payload: { networkPolicy: null },
    });
    expect(cleared.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
    });
    expect(read.json().networkPolicy).toBeNull();

    // Both writes converge the agent's own engine: provisioned, then removed.
    await drainBackgroundWork();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(agentId);
  });

  test("rejects an invalid policy", async () => {
    const app = await appFor(admin);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Bad policy",
        agentType: "agent",
        networkPolicy: {
          egressMode: "restricted",
          allowedCidrs: ["not-a-cidr"],
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("a member without environment update permission cannot set a policy but can still edit the agent", async () => {
    const memberApp = await appFor(member);

    const refused = await memberApp.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Member agent",
        agentType: "agent",
        networkPolicy: { egressMode: "unrestricted" },
      },
    });
    expect(refused.statusCode).toBe(403);

    const created = await memberApp.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Member agent", agentType: "agent" },
    });
    expect(created.statusCode).toBe(200);
    const agentId = created.json().id;

    const loosened = await memberApp.inject({
      method: "PUT",
      url: `/api/agents/${agentId}`,
      payload: { networkPolicy: { egressMode: "unrestricted" } },
    });
    expect(loosened.statusCode).toBe(403);

    // An administrator locks the agent down; the member keeps editing the
    // rest, including resending the unchanged policy, but cannot clear it.
    const adminApp = await appFor(admin);
    const locked = await adminApp.inject({
      method: "PUT",
      url: `/api/agents/${agentId}`,
      payload: { networkPolicy: { egressMode: "off" } },
    });
    expect(locked.statusCode).toBe(200);

    const renamed = await memberApp.inject({
      method: "PUT",
      url: `/api/agents/${agentId}`,
      payload: { name: "Renamed", networkPolicy: locked.json().networkPolicy },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().networkPolicy.egressMode).toBe("off");

    const unlocked = await memberApp.inject({
      method: "PUT",
      url: `/api/agents/${agentId}`,
      payload: { networkPolicy: null },
    });
    expect(unlocked.statusCode).toBe(403);
  });
});
