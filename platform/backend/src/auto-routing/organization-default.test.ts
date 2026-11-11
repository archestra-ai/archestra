import config from "@/config";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ensureAutoRouter } from "@/test/auto-routing";
import type { GatewayAgent } from "@/types";
import { agentAutoRouterId } from "./organization-default";

describe("agentAutoRouterId", () => {
  const deployed = config.autoRouting.enabled;
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });
  afterEach(() => {
    config.autoRouting.enabled = deployed;
  });

  const inherits = {
    autoRouterId: null,
    llmApiKeyId: null,
    modelId: null,
    modelPoolId: null,
    runtime: null,
  } satisfies Parameters<typeof agentAutoRouterId>[0];

  test("an agent set to a router uses it", async ({ makeOrganization }) => {
    const { id } = await makeOrganization();
    const router = await ensureAutoRouter(id);

    expect(
      await agentAutoRouterId({ ...inherits, autoRouterId: router.id }, id),
    ).toBe(router.id);
  });

  test("an agent on the organization default uses the default router, when there is one", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    const router = await ensureAutoRouter(id);
    expect(await agentAutoRouterId(inherits, id)).toBeNull();

    await OrganizationModel.patch(id, { defaultAutoRouterId: router.id });

    expect(await agentAutoRouterId(inherits, id)).toBe(router.id);
  });

  test("an agent with its own model, key or pool does not follow a router default", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    const router = await ensureAutoRouter(id);
    await OrganizationModel.patch(id, { defaultAutoRouterId: router.id });
    const ownId = crypto.randomUUID();

    for (const own of [
      { modelId: ownId },
      { llmApiKeyId: ownId },
      { modelPoolId: ownId },
    ]) {
      expect(await agentAutoRouterId({ ...inherits, ...own }, id)).toBeNull();
    }
  });

  test("an Agent Runtime agent, or a deployment without auto routing, never uses a router", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    const router = await ensureAutoRouter(id);
    const runtime = {} as NonNullable<GatewayAgent["runtime"]>;

    expect(
      await agentAutoRouterId(
        { ...inherits, autoRouterId: router.id, runtime },
        id,
      ),
    ).toBeNull();
    config.autoRouting.enabled = false;
    expect(
      await agentAutoRouterId({ ...inherits, autoRouterId: router.id }, id),
    ).toBeNull();
  });
});
