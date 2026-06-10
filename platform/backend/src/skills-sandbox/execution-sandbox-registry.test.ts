import { SkillSandboxModel } from "@/models";
import { afterEach, describe, expect, test, vi } from "@/test";
import { executionSandboxRegistry } from "./execution-sandbox-registry";

describe("executionSandboxRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("concurrent first calls resolve to the same sandbox row", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const isolationKey = crypto.randomUUID();
    const params = {
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      defaultCwd: "/home/sandbox",
    };

    const [a, b] = await Promise.all([
      executionSandboxRegistry.getOrCreateDefault(params),
      executionSandboxRegistry.getOrCreateDefault(params),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.conversationId).toBeNull();
    expect(a.isDefault).toBe(false);
    expect(
      executionSandboxRegistry.isOwned({ ...params, sandboxId: a.id }),
    ).toBe(true);

    executionSandboxRegistry.release(isolationKey);
  });

  test("a failed creation is retried instead of caching the rejection", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const isolationKey = crypto.randomUUID();
    const params = {
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      defaultCwd: "/home/sandbox",
    };

    vi.spyOn(SkillSandboxModel, "create").mockRejectedValueOnce(
      new Error("transient insert failure"),
    );
    await expect(
      executionSandboxRegistry.getOrCreateDefault(params),
    ).rejects.toThrow("transient insert failure");

    const sandbox = await executionSandboxRegistry.getOrCreateDefault(params);
    expect(sandbox.conversationId).toBeNull();

    executionSandboxRegistry.release(isolationKey);
  });

  test("release drops ownership and the cached default", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const isolationKey = crypto.randomUUID();
    const params = {
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      defaultCwd: "/home/sandbox",
    };

    const sandbox = await executionSandboxRegistry.getOrCreateDefault(params);
    executionSandboxRegistry.registerOwned({
      ...params,
      sandboxId: "extra-sandbox",
    });

    executionSandboxRegistry.release(isolationKey);

    expect(
      executionSandboxRegistry.isOwned({ ...params, sandboxId: sandbox.id }),
    ).toBe(false);
    expect(
      executionSandboxRegistry.isOwned({
        ...params,
        sandboxId: "extra-sandbox",
      }),
    ).toBe(false);
    expect(await executionSandboxRegistry.findDefault(params)).toBeNull();

    const recreated = await executionSandboxRegistry.getOrCreateDefault(params);
    expect(recreated.id).not.toBe(sandbox.id);
    executionSandboxRegistry.release(isolationKey);
  });

  test("ownership does not leak across isolation keys or users", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    const isolationKey = crypto.randomUUID();
    const params = {
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      defaultCwd: "/home/sandbox",
    };

    const sandbox = await executionSandboxRegistry.getOrCreateDefault(params);

    expect(
      executionSandboxRegistry.isOwned({
        organizationId: org.id,
        userId: user.id,
        isolationKey: crypto.randomUUID(),
        sandboxId: sandbox.id,
      }),
    ).toBe(false);
    expect(
      executionSandboxRegistry.isOwned({
        organizationId: org.id,
        userId: otherUser.id,
        isolationKey,
        sandboxId: sandbox.id,
      }),
    ).toBe(false);

    executionSandboxRegistry.release(isolationKey);
  });
});
