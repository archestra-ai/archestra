import config from "@/config";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { GatewayAgent } from "@/types";
import { agentUsesAutoModel } from "./organization-default";

describe("agentUsesAutoModel", () => {
  const deployed = config.autoRouting.enabled;
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });
  afterEach(() => {
    config.autoRouting.enabled = deployed;
  });

  const inherits = {
    autoModel: false,
    llmApiKeyId: null,
    modelId: null,
    modelPoolId: null,
    runtime: null,
  } satisfies Parameters<typeof agentUsesAutoModel>[0];

  test("an agent set to auto uses it", async ({ makeOrganization }) => {
    const { id } = await makeOrganization();

    expect(await agentUsesAutoModel({ ...inherits, autoModel: true }, id)).toBe(
      true,
    );
  });

  test("an agent on the organization default uses auto only when the default is auto", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    expect(await agentUsesAutoModel(inherits, id)).toBe(false);

    await OrganizationModel.patch(id, { defaultAutoModel: true });

    expect(await agentUsesAutoModel(inherits, id)).toBe(true);
  });

  test("an agent with its own model, key or pool does not follow an auto default", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    await OrganizationModel.patch(id, { defaultAutoModel: true });
    const ownId = crypto.randomUUID();

    for (const own of [
      { modelId: ownId },
      { llmApiKeyId: ownId },
      { modelPoolId: ownId },
    ]) {
      expect(await agentUsesAutoModel({ ...inherits, ...own }, id)).toBe(false);
    }
  });

  test("an Agent Runtime agent, or a deployment without auto routing, never uses auto", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    const runtime = {} as NonNullable<GatewayAgent["runtime"]>;

    expect(
      await agentUsesAutoModel({ ...inherits, autoModel: true, runtime }, id),
    ).toBe(false);
    config.autoRouting.enabled = false;
    expect(await agentUsesAutoModel({ ...inherits, autoModel: true }, id)).toBe(
      false,
    );
  });
});
