import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("Independent MCP runtime tiers", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
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
    registerRoutePermissions(app);
    await app.register((await import("./organization")).default);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });
  const tier = (
    name: string,
    cpuRequest = 0.1,
    extra: Record<string, unknown> = {},
  ) => ({
    name,
    cpuRequest,
    cpuLimit: null,
    memoryRequestMiB: 128,
    memoryLimitMiB: 512,
    ...extra,
  });
  const patch = (tiers: ReturnType<typeof tier>[] | null) =>
    app.inject({
      method: "PATCH",
      url: "/api/organization/mcp-runtime-tiers",
      headers: { "content-type": "application/json" },
      payload: tiers === null ? "null" : { tiers },
    });
  test("MCP tiers have small defaults and do not follow Agent Runtime settings", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/organization/mcp-runtime-tiers",
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().tiers[0]).toMatchObject(tier("S"));
    await OrganizationModel.patch(organizationId, {
      agentRuntimeTiers: {
        tiers: [
          {
            name: "Agent only",
            cpuRequest: 8,
            cpuLimit: null,
            warmSpares: 0,
            workspaceGiB: null,
          },
        ],
        defaultTier: "Agent only",
      },
    });
    expect(
      await InternalMcpCatalogModel.resolveRuntimeResources(
        { command: "node", runtimeTier: "S" },
        organizationId,
      ),
    ).toMatchObject({ cpuRequest: 0.1, memoryRequestMiB: 128 });
    await expect(
      InternalMcpCatalogModel.resolveRuntimeResources(
        { command: "node", runtimeTier: "Agent only" },
        organizationId,
      ),
    ).rejects.toThrow("not one of");
    const response = await patch([tier("MCP only")]);
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toMatchObject({ defaultTier: "Agent only" });
  });
  test("reset restores MCP defaults without changing Agent Runtime settings", async () => {
    expect((await patch([tier("Custom")])).statusCode).toBe(200);
    const reset = await patch(null);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(
      reset.json().tiers.map((entry: { name: string }) => entry.name),
    ).toEqual(["S", "M", "L"]);
    expect(
      (await OrganizationModel.getById(organizationId))?.mcpRuntimeTiers,
    ).toBeNull();
  });
  test("references block removal/reset, follow rename case-insensitively, and resolve current resources", async ({
    makeInternalMcpCatalog,
  }) => {
    expect((await patch([tier("Small"), tier("Medium", 0.5)])).statusCode).toBe(
      200,
    );
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", runtimeTier: "medium" },
    });
    expect((await patch([tier("Small")])).statusCode).toBe(400);
    expect((await patch(null)).statusCode).toBe(400);
    const renamed = await patch([
      tier("Small"),
      tier("Renamed", 0.75, {
        previousName: "Medium",
        memoryRequestMiB: 64,
        memoryLimitMiB: 256,
      }),
    ]);
    expect(renamed.statusCode, renamed.body).toBe(200);
    const saved = await InternalMcpCatalogModel.findById(catalog.id);
    expect(saved?.localConfig?.runtimeTier).toBe("Renamed");
    expect(
      await InternalMcpCatalogModel.resolveRuntimeResources(
        { runtimeTier: "renamed" },
        organizationId,
      ),
    ).toEqual({
      cpuRequest: 0.75,
      cpuLimit: null,
      memoryRequestMiB: 64,
      memoryLimitMiB: 256,
    });
  });
  test("CPU/RAM resize flags single/shared and empty YAML, not default/custom deployments", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const create = (extra: Record<string, unknown> = {}) =>
      makeInternalMcpCatalog({
        organizationId,
        serverType: "local",
        localConfig: { command: "node", runtimeTier: "S" },
        ...extra,
      });
    const single = await create();
    const install = await makeMcpServer({
      catalogId: single.id,
      serverType: "local",
    });
    const shared = await create({ multitenant: true });
    const empty = await create({ deploymentSpecYaml: "" });
    const emptyInstall = await makeMcpServer({
      catalogId: empty.id,
      serverType: "local",
    });
    const emptyShared = await create({
      deploymentSpecYaml: "",
      multitenant: true,
    });
    const custom = await create({ deploymentSpecYaml: "kind: Deployment" });
    const customInstall = await makeMcpServer({
      catalogId: custom.id,
      serverType: "local",
    });
    const defaults = await create({ localConfig: { command: "node" } });
    const defaultInstall = await makeMcpServer({
      catalogId: defaults.id,
      serverType: "local",
    });
    // Agent tier edits must never flag MCP workloads with the same tier name.
    const agentEdit = await app.inject({
      method: "PATCH",
      url: "/api/organization/agent-settings",
      payload: {
        agentRuntimeTiers: {
          tiers: [
            {
              name: "Agent only",
              cpuRequest: 3,
              cpuLimit: null,
              pooled: false,
            },
          ],
          defaultTier: "Agent only",
        },
      },
    });
    expect(agentEdit.statusCode, agentEdit.body).toBe(200);
    expect((await McpServerModel.findById(install.id))?.reinstallRequired).toBe(
      false,
    );
    const changed = await patch([
      tier("S", 0.1, { memoryRequestMiB: 64, memoryLimitMiB: 256 }),
      tier("M", 0.5),
      tier("L", 1),
    ]);
    expect(changed.statusCode, changed.body).toBe(200);
    for (const id of [install.id, emptyInstall.id])
      expect(await McpServerModel.findById(id)).toMatchObject({
        reinstallRequired: true,
        reinstallReason: "restart",
      });
    for (const id of [shared.id, emptyShared.id])
      expect(
        (await InternalMcpCatalogModel.findById(id))?.catalogReinstallRequired,
      ).toBe(true);
    for (const id of [customInstall.id, defaultInstall.id])
      expect((await McpServerModel.findById(id))?.reinstallRequired).toBe(
        false,
      );
  });
  test("blank memory stays derived through save/read/CPU edits; omission preserves explicit overrides", async () => {
    const save = (cpu: number, extra: Record<string, unknown>) =>
      patch([tier("Custom", cpu, extra)]);
    const initial = await save(0.5, {
      memoryRequestMiB: null,
      memoryLimitMiB: null,
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().tiers[0]).toMatchObject({
      memoryRequestMiB: 1024,
      memoryLimitMiB: 2048,
    });
    expect(initial.json().tiers[0]).not.toHaveProperty(
      "memoryRequestMiBOverride",
    );
    expect(
      (await OrganizationModel.getById(organizationId))?.mcpRuntimeTiers
        ?.tiers[0].memoryRequestMiB,
    ).toBeNull();
    const edited = await save(1, {
      memoryRequestMiB: undefined,
      memoryLimitMiB: undefined,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().tiers[0]).toMatchObject({
      memoryRequestMiB: 2048,
      memoryLimitMiB: 4096,
    });
    const overridden = await save(1, {
      memoryRequestMiB: 64,
      memoryLimitMiB: 128,
    });
    expect(overridden.json().tiers[0]).toMatchObject({
      memoryRequestMiBOverride: 64,
      memoryLimitMiBOverride: 128,
    });
    const preserved = await save(2, {
      memoryRequestMiB: undefined,
      memoryLimitMiB: undefined,
    });
    expect(preserved.json().tiers[0]).toMatchObject({
      memoryRequestMiB: 64,
      memoryLimitMiB: 128,
    });
    const cleared = await save(2, {
      memoryRequestMiB: null,
      memoryLimitMiB: null,
    });
    expect(cleared.json().tiers[0]).toMatchObject({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 8192,
    });
    expect(cleared.json().tiers[0]).not.toHaveProperty(
      "memoryLimitMiBOverride",
    );
  });
  test("only administrators manage tiers", async ({ makeUser, makeMember }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });
    expect((await patch([tier("Small")])).statusCode).toBe(403);
  });
  test("rejects overflow in derived RAM without saving settings", async () => {
    const before = (await OrganizationModel.getById(organizationId))
      ?.mcpRuntimeTiers;
    const response = await patch([
      tier("Huge", 1, {
        memoryRequestMiB: Number.MAX_SAFE_INTEGER,
        memoryLimitMiB: null,
      }),
    ]);
    expect(response.statusCode, response.body).toBe(400);
    expect(
      (await OrganizationModel.getById(organizationId))?.mcpRuntimeTiers,
    ).toEqual(before);
  });
  test("rejects invalid resources, ambiguous names and agent-only settings", async () => {
    for (const tiers of [
      [tier("S", 0.01)],
      [tier("S", 1, { cpuLimit: 0.5 })],
      [tier("S", 1, { memoryRequestMiB: 513 })],
      [tier("S"), tier("s")],
      [tier("S", 1, { pooled: true })],
    ])
      expect((await patch(tiers)).statusCode).toBe(400);
  });
});
