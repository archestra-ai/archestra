import { describe, expect, test } from "vitest";
import { resolveDefaultEnvironmentId } from "./resolve-default-environment";

const explore = { id: "env-explore", restricted: false };
const locked = { id: "env-locked", restricted: true };

describe("resolveDefaultEnvironmentId", () => {
  test("returns the environment configured for the resource kind", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [explore],
        resourceDefaults: { mcpRegistry: "env-explore" },
        resource: "mcpRegistry",
        canDeployToRestricted: false,
      }),
    ).toBe("env-explore");
  });

  test("falls back to the Default environment when the kind is unconfigured", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [explore],
        resourceDefaults: { app: "env-explore" },
        resource: "mcpRegistry",
        canDeployToRestricted: false,
      }),
    ).toBeNull();
  });

  test("falls back when the configured environment no longer exists", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [],
        resourceDefaults: { mcpRegistry: "env-deleted" },
        resource: "mcpRegistry",
        canDeployToRestricted: true,
      }),
    ).toBeNull();
  });

  test("falls back when the configured environment is restricted to others", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [locked],
        resourceDefaults: { mcpRegistry: "env-locked" },
        resource: "mcpRegistry",
        canDeployToRestricted: false,
      }),
    ).toBeNull();
  });

  test("uses a restricted environment for a user who may deploy there", () => {
    expect(
      resolveDefaultEnvironmentId({
        environments: [locked],
        resourceDefaults: { mcpRegistry: "env-locked" },
        resource: "mcpRegistry",
        canDeployToRestricted: true,
      }),
    ).toBe("env-locked");
  });
});
