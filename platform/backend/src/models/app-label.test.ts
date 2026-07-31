import { describe, expect, test } from "@/test";
import AgentLabelModel from "./agent-label";
import AppModel from "./app";
import AppLabelModel from "./app-label";

describe("AppLabelModel.syncAppLabels", () => {
  test("assigns labels to an app", async ({ makeApp }) => {
    const app = await makeApp();

    await AppLabelModel.syncAppLabels(app.id, [
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);

    const labels = await AppLabelModel.getLabelsForApp(app.id);
    // Ordered by key, like every other label surface.
    expect(labels.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
  });

  test("replaces the previous set rather than merging", async ({ makeApp }) => {
    const app = await makeApp();

    await AppLabelModel.syncAppLabels(app.id, [{ key: "env", value: "prod" }]);
    await AppLabelModel.syncAppLabels(app.id, [{ key: "tier", value: "gold" }]);

    const labels = await AppLabelModel.getLabelsForApp(app.id);
    expect(labels.map((label) => label.key)).toEqual(["tier"]);
  });

  test("clears all labels when given an empty array", async ({ makeApp }) => {
    const app = await makeApp();
    await AppLabelModel.syncAppLabels(app.id, [{ key: "env", value: "prod" }]);

    await AppLabelModel.syncAppLabels(app.id, []);

    expect(await AppLabelModel.getLabelsForApp(app.id)).toEqual([]);
  });

  test("keeps one value per key when a key repeats", async ({ makeApp }) => {
    const app = await makeApp();

    // The composite PK is (app_id, key_id), so the last value for a key wins
    // rather than the write failing.
    await AppLabelModel.syncAppLabels(app.id, [
      { key: "env", value: "staging" },
      { key: "env", value: "prod" },
    ]);

    const labels = await AppLabelModel.getLabelsForApp(app.id);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.value).toBe("prod");
  });
});

describe("AppLabelModel.getLabelsForApps", () => {
  test("batch-loads labels keyed by app id", async ({ makeApp }) => {
    const first = await makeApp({ name: "First" });
    const second = await makeApp({ name: "Second" });
    const unlabelled = await makeApp({ name: "Third" });

    await AppLabelModel.syncAppLabels(first.id, [
      { key: "env", value: "prod" },
    ]);
    await AppLabelModel.syncAppLabels(second.id, [
      { key: "env", value: "dev" },
    ]);

    const byApp = await AppLabelModel.getLabelsForApps([
      first.id,
      second.id,
      unlabelled.id,
    ]);

    expect(byApp.get(first.id)?.map((l) => l.value)).toEqual(["prod"]);
    expect(byApp.get(second.id)?.map((l) => l.value)).toEqual(["dev"]);
    // Present but empty, so callers can read the map without a null check.
    expect(byApp.get(unlabelled.id)).toEqual([]);
  });

  test("returns an empty map for no ids", async () => {
    expect(await AppLabelModel.getLabelsForApps([])).toEqual(new Map());
  });
});

describe("AppLabelModel.getAppIdsMatchingLabels", () => {
  test("ANDs across keys and ORs within a key's values", async ({
    makeApp,
  }) => {
    const both = await makeApp({ name: "Both" });
    const envOnly = await makeApp({ name: "EnvOnly" });
    const otherValue = await makeApp({ name: "OtherValue" });

    await AppLabelModel.syncAppLabels(both.id, [
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
    await AppLabelModel.syncAppLabels(envOnly.id, [
      { key: "env", value: "prod" },
    ]);
    await AppLabelModel.syncAppLabels(otherValue.id, [
      { key: "env", value: "dev" },
      { key: "team", value: "platform" },
    ]);

    // Two keys: only the app carrying both matches.
    expect(
      await AppLabelModel.getAppIdsMatchingLabels({
        env: ["prod"],
        team: ["platform"],
      }),
    ).toEqual([both.id]);

    // Several values for one key are an OR.
    const envMatches = await AppLabelModel.getAppIdsMatchingLabels({
      env: ["prod", "dev"],
    });
    expect(envMatches.sort()).toEqual(
      [both.id, envOnly.id, otherValue.id].sort(),
    );
  });

  test("returns an empty array when nothing matches", async ({ makeApp }) => {
    const app = await makeApp();
    await AppLabelModel.syncAppLabels(app.id, [{ key: "env", value: "prod" }]);

    expect(
      await AppLabelModel.getAppIdsMatchingLabels({ env: ["nope"] }),
    ).toEqual([]);
  });
});

describe("AppLabelModel taxonomy reads", () => {
  test("scopes keys and values to the organization's apps", async ({
    makeApp,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const mine = await makeApp();
    const theirs = await makeApp({ organizationId: otherOrg.id });

    await AppLabelModel.syncAppLabels(mine.id, [{ key: "env", value: "prod" }]);
    await AppLabelModel.syncAppLabels(theirs.id, [
      { key: "secret-key", value: "secret-value" },
    ]);

    const keys = await AppLabelModel.getAllKeys(mine.organizationId);
    expect(keys).toEqual(["env"]);
    expect(keys).not.toContain("secret-key");

    expect(
      await AppLabelModel.getValuesByKey({
        organizationId: mine.organizationId,
        key: "env",
      }),
    ).toEqual(["prod"]);
    expect(await AppLabelModel.getAllValues(mine.organizationId)).toEqual([
      "prod",
    ]);
  });

  test("omits labels of soft-deleted apps", async ({ makeApp }) => {
    const app = await makeApp();
    await AppLabelModel.syncAppLabels(app.id, [
      { key: "gone", value: "value" },
    ]);

    await AppModel.delete(app.id);

    expect(await AppLabelModel.getAllKeys(app.organizationId)).toEqual([]);
    expect(await AppLabelModel.getAllValues(app.organizationId)).toEqual([]);
  });
});

describe("label taxonomy pruning with app labels", () => {
  test("does not prune a key/value still referenced by app_labels", async ({
    makeApp,
    makeAgent,
  }) => {
    const app = await makeApp();
    const agent = await makeAgent();

    await AgentLabelModel.syncAgentLabels(agent.id, [
      { key: "shared-env", value: "shared-prod", keyId: "", valueId: "" },
    ]);
    await AppLabelModel.syncAppLabels(app.id, [
      { key: "shared-env", value: "shared-prod" },
    ]);

    // Dropping the agent's copy must not collect the taxonomy row the app
    // still points at, or the app's label would lose its key/value.
    await AgentLabelModel.syncAgentLabels(agent.id, []);
    await AgentLabelModel.pruneKeysAndValues();

    expect(await AgentLabelModel.getAllKeys()).toContain("shared-env");
    expect(await AgentLabelModel.getAllValues()).toContain("shared-prod");
    expect(await AppLabelModel.getLabelsForApp(app.id)).toEqual([
      expect.objectContaining({ key: "shared-env", value: "shared-prod" }),
    ]);
  });

  test("prunes once the app's label is removed too", async ({ makeApp }) => {
    const app = await makeApp();
    await AppLabelModel.syncAppLabels(app.id, [
      { key: "app-only-key", value: "app-only-value" },
    ]);

    await AppLabelModel.syncAppLabels(app.id, []);
    await AgentLabelModel.pruneKeysAndValues();

    expect(await AgentLabelModel.getAllKeys()).not.toContain("app-only-key");
    expect(await AgentLabelModel.getAllValues()).not.toContain(
      "app-only-value",
    );
  });
});
