import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import AgentModel from "@/models/agent";
import OrganizationModel from "@/models/organization";
import { organizationAgentRuntimeTiers } from "@/services/agent-runtime/runtime-tiers";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("Agent Runtime tiers: GET /api/organization/agent-runtime-tiers and PATCH /api/organization/agent-settings", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
    user = await makeAdmin();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/organization/agent-settings",
      payload,
    });
  const read = async () =>
    (
      await app.inject({
        method: "GET",
        url: "/api/organization/agent-runtime-tiers",
      })
    ).json();
  const tier = (
    name: string,
    cpuRequest: number,
    extra: Record<string, unknown> = {},
  ) => ({ name, cpuRequest, cpuLimit: null, warmSpares: 0, ...extra });

  test("an organization starts with S, M and L; an administrator saves a list of its own, smallest first, and runs then get those sizes", async () => {
    expect(await read()).toMatchObject({
      defaultTier: "M",
      tiers: [
        {
          name: "S",
          cpuRequest: 2,
          memoryRequestMiB: 4096,
          memoryLimitMiB: 8192,
        },
        { name: "M", cpuRequest: 4 },
        { name: "L", cpuRequest: 8, warmSpares: 0 },
      ],
    });

    const response = await patch({
      agentRuntimeTiers: {
        tiers: [
          tier("Large", 6, { cpuLimit: 8, warmSpares: 1 }),
          tier("Small", 1),
          tier("XL", 8, { warmSpares: 0 }),
        ],
        defaultTier: "Small",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().agentRuntimeTiers).toEqual({
      tiers: [
        { name: "Large", cpuRequest: 6, cpuLimit: 8, warmSpares: 1 },
        { name: "Small", cpuRequest: 1, cpuLimit: null, warmSpares: 0 },
        { name: "XL", cpuRequest: 8, cpuLimit: null, warmSpares: 0 },
      ],
      defaultTier: "Small",
    });
    const resolved = await read();
    expect(resolved.tiers.map((entry: { name: string }) => entry.name)).toEqual(
      ["Small", "Large", "XL"],
    );
    expect(resolved.tiers[1]).toEqual({
      name: "Large",
      cpuRequest: 6,
      cpuLimit: 8,
      warmSpares: 1,
      memoryRequestMiB: 12288,
      memoryLimitMiB: 16384,
    });
    expect(
      (await organizationAgentRuntimeTiers(organizationId)).defaultTier,
    ).toBe("Small");

    expect((await patch({ agentRuntimeTiers: null })).statusCode).toBe(200);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
    expect((await read()).defaultTier).toBe("M");
  });

  test("refuses a CPU request above 8, a limit above 16 or below its request, a repeated name and a default that is not in the list", async () => {
    const refused = async (tiers: unknown[], defaultTier = "S") => {
      const response = await patch({
        agentRuntimeTiers: { tiers, defaultTier },
      });
      expect(response.statusCode).toBe(400);
      return response.json().error.message as string;
    };
    expect(await refused([tier("S", 9)])).toContain("at most 8");
    expect(await refused([tier("S", 2, { cpuLimit: 17 })])).toContain(
      "at most 16",
    );
    expect(await refused([tier("S", 4, { cpuLimit: 2 })])).toContain(
      "Tier S: the CPU limit is below the CPU request",
    );
    expect(await refused([tier("S", 1), tier("s", 2)])).toContain(
      "Two tiers are named s",
    );
    expect(await refused([tier("S", 1)], "M")).toContain(
      "The default tier M is not in the list",
    );
    expect(await refused([tier("S", 2, { warmSpares: 11 })])).toBeTruthy();
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
  });

  test("a renamed tier is followed by the agents that name it; a tier still in use cannot be removed", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      runtime: {
        image: "example.com/agent:1",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        tier: "M",
        maxTier: "L",
        environment: null,
        credentials: null,
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
    });

    const removal = await patch({
      agentRuntimeTiers: {
        tiers: [tier("S", 2), tier("L", 8)],
        defaultTier: "S",
      },
    });
    expect(removal.statusCode).toBe(400);
    expect(removal.json().error.message).toBe(
      "Tier M is the default or scaleup tier of 1 agent; move them to another tier first",
    );

    const renamed = await patch({
      agentRuntimeTiers: {
        tiers: [
          tier("Small", 2, { previousName: "S" }),
          tier("Medium", 4, { previousName: "M" }),
          tier("Large", 8, { previousName: "L" }),
        ],
        defaultTier: "Medium",
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await AgentModel.findById(agent.id))?.runtime).toMatchObject({
      tier: "Medium",
      maxTier: "Large",
    });
    expect(
      (await read()).tiers.map((entry: { name: string }) => entry.name),
    ).toEqual(["Small", "Medium", "Large"]);
    // Removing a tier nobody names is fine.
    expect(
      (
        await patch({
          agentRuntimeTiers: {
            tiers: [tier("Medium", 4), tier("Large", 8)],
            defaultTier: "Medium",
          },
        })
      ).statusCode,
    ).toBe(200);
  });

  test("members who may update other agent settings cannot change the tiers", async ({
    makeUser,
    makeMember,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });
    const response = await patch({
      agentRuntimeTiers: { tiers: [tier("S", 1)], defaultTier: "S" },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
  });
});
