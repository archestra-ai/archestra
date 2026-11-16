// @vitest-environment node
import { describe, expect, test } from "vitest";
import { resolveDefaultEnvironmentId } from "./resolve-default-environment";

const explore = { id: "env-explore", deployKinds: ["mcpRegistry", "app"] };
const locked = { id: "env-locked", deployKinds: [] };
const unlocked = { id: "env-locked", deployKinds: ["mcpRegistry"] };

describe("resolveDefaultEnvironmentId", () => {
  test("returns the environment configured for the resource kind", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [explore],
        resourceDefaults: { mcpRegistry: "env-explore" },
        resource: "mcpRegistry",
      }),
    ).toBe("env-explore");
  });

  test("falls back to the Default environment when the kind is unconfigured", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [explore],
        resourceDefaults: { app: "env-explore" },
        resource: "mcpRegistry",
      }),
    ).toBeNull();
  });

  test("falls back when the configured environment no longer exists", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [],
        resourceDefaults: { mcpRegistry: "env-deleted" },
        resource: "mcpRegistry",
      }),
    ).toBeNull();
  });

  test("falls back when the configured environment is restricted to others", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [locked],
        resourceDefaults: { mcpRegistry: "env-locked" },
        resource: "mcpRegistry",
      }),
    ).toBeNull();
  });

  test("falls back when the user may deploy other kinds there but not this one", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [unlocked],
        resourceDefaults: { agent: "env-locked", mcpRegistry: "env-locked" },
        resource: "agent",
      }),
    ).toBeNull();
  });

  test("uses a restricted environment for a user who may deploy there", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [unlocked],
        resourceDefaults: { mcpRegistry: "env-locked" },
        resource: "mcpRegistry",
      }),
    ).toBe("env-locked");
  });
});
