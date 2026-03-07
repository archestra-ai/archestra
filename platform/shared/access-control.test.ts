import { describe, expect, test } from "vitest";
import { allAvailableActions, permissionDescriptions } from "./access-control";
import { internalResources, type Resource } from "./permission.types";

describe("access-control", () => {
  test("every resource:action combination has a permissionDescription", () => {
    const missing: string[] = [];

    for (const resource of Object.keys(allAvailableActions) as Resource[]) {
      if (internalResources.includes(resource)) continue;

      for (const action of allAvailableActions[resource]) {
        const key = `${resource}:${action}`;
        if (!permissionDescriptions[key]) {
          missing.push(key);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("permissionDescriptions has no stale entries", () => {
    const validKeys = new Set<string>();

    for (const resource of Object.keys(allAvailableActions) as Resource[]) {
      for (const action of allAvailableActions[resource]) {
        validKeys.add(`${resource}:${action}`);
      }
    }

    const stale = Object.keys(permissionDescriptions).filter(
      (key) => !validKeys.has(key),
    );

    expect(stale).toEqual([]);
  });
});
