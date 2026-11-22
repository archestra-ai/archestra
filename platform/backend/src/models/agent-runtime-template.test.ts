import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";
import AgentRuntimeTemplateModel from "./agent-runtime-template";
import SecretModel from "./secret";

describe("AgentRuntimeTemplateModel.getSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reads and parses the stored settings once for each change, and sees a save at once", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const save = (revision: number, ttlHours: number) =>
      AgentRuntimeTemplateModel.saveSettings({
        organizationId,
        settings: {
          revision,
          templates: [],
          builtIns: { "claude-code": { settings: { ttlHours } } },
        },
        popularAgentOverrides: null,
      });
    await save(0, 6);
    const decrypted = vi.spyOn(SecretModel, "findByName");

    const first = await AgentRuntimeTemplateModel.getSettings(organizationId);
    const second = await AgentRuntimeTemplateModel.getSettings(organizationId);
    expect(first.builtIns["claude-code"]?.settings.ttlHours).toBe(6);
    expect(second.builtIns).toBe(first.builtIns);
    expect(decrypted).toHaveBeenCalledTimes(1);
    // What every reader shares cannot be changed by one of them.
    expect(Object.isFrozen(first.builtIns)).toBe(true);

    // A save, here or on another replica, changes the secret's update time:
    // the next read sees it.
    await save(first.revision, 12);
    decrypted.mockClear();
    const saved = await AgentRuntimeTemplateModel.getSettings(organizationId);
    expect(saved.builtIns["claude-code"]?.settings.ttlHours).toBe(12);
    expect(decrypted).toHaveBeenCalledTimes(1);
  });

  test("gives the defaults for an organization that stored none", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();

    expect(
      await AgentRuntimeTemplateModel.getSettings(organizationId),
    ).toMatchObject({ revision: 0, templates: [], builtIns: {} });
  });
});
