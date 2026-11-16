import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { describe, expect, test, vi } from "@/test";
import { spyOnLogger } from "@/test/logging";
import {
  readGuardrailsV2Activation,
  setGuardrailsDeployment,
} from "./guardrails-deployment";

spyOnLogger();

describe("readGuardrailsV2Activation", () => {
  test("a stored false is inactive, and a thrown read is not that result", async () => {
    const previous = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      await expect(readGuardrailsV2Activation(async () => false)).resolves.toBe(
        "inactive",
      );
      await expect(
        readGuardrailsV2Activation(async () => {
          throw new Error("deployment row unavailable");
        }),
      ).rejects.toThrow("deployment row unavailable");
    } finally {
      config.openappa.enabled = previous;
    }
  });

  test("the persisted row toggles the same predicate between reads", async () => {
    const previous = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      await GuardrailsDeploymentModel.setEnabled(false);
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
      await GuardrailsDeploymentModel.setEnabled(true);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
      config.openappa.enabled = false;
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
    } finally {
      config.openappa.enabled = previous;
    }
  });

  test("enforcement turns off at the small-team threshold unless the enterprise licence is set", async () => {
    const previous = config.openappa.enabled;
    const previousCore = config.enterpriseFeatures.core;
    const setCore = (value: boolean) =>
      Object.defineProperty(config.enterpriseFeatures, "core", {
        value,
        writable: true,
        configurable: true,
      });
    config.openappa.enabled = true;
    setCore(false);
    try {
      await GuardrailsDeploymentModel.setEnabled(true);
      enterpriseTier.setUserCountForTesting(29);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
      enterpriseTier.setUserCountForTesting(30);
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
      setCore(true);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
    } finally {
      config.openappa.enabled = previous;
      setCore(previousCore);
      enterpriseTier.setUserCountForTesting(0);
    }
  });
});

describe("setGuardrailsDeployment", () => {
  test("logs who switched enforcement and what it was before and after", async () => {
    await GuardrailsDeploymentModel.setEnabled(true);
    const info = vi.mocked(logger.info);

    await setGuardrailsDeployment({ enabled: false }, { userId: "user-1" });

    expect(info).toHaveBeenCalledWith(
      {
        userId: "user-1",
        before: expect.objectContaining({ enabled: true }),
        after: expect.objectContaining({ enabled: false }),
      },
      expect.stringMatching(
        /^Guardrails (enforcement switched off|deployment settings changed)$/,
      ),
    );
  });

  test("turning enforcement back on queues a pull for every organization whose policy syncs from a repository", async ({
    makeOrganization,
  }) => {
    const syncing = (await makeOrganization()).id;
    const stopped = (await makeOrganization()).id;
    for (const organizationId of [syncing, stopped])
      await OpenAppaGithubSyncModel.save(organizationId, {
        repo: "acme/policies",
        ref: null,
        path: "appa.toml",
        interval: "15m",
        githubPatId: null,
        githubAppConfigId: null,
      });
    await OpenAppaGithubSyncModel.setInterval(stopped, null);
    const queued = async () =>
      (
        await db
          .select()
          .from(schema.tasksTable)
          .where(eq(schema.tasksTable.taskType, "openappa_github_sync"))
      ).map(
        (task) => (task.payload as { organizationId: string }).organizationId,
      );
    const clear = () =>
      db
        .delete(schema.tasksTable)
        .where(eq(schema.tasksTable.taskType, "openappa_github_sync"));
    await GuardrailsDeploymentModel.setEnabled(false);
    await clear();

    // What merged while enforcement was off is pulled now, not at the next
    // scheduled check.
    await setGuardrailsDeployment({ enabled: true });
    expect(await queued()).toContain(syncing);
    expect(await queued()).not.toContain(stopped);

    // Already on: another settings change queues nothing.
    await clear();
    await setGuardrailsDeployment({ enabled: true });
    expect(await queued()).toEqual([]);
  });
});
