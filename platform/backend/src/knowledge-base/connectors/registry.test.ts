import { describe, expect, test } from "vitest";
import { getPermissionSyncConnectorTypes } from "./registry";

describe("getPermissionSyncConnectorTypes", () => {
  /**
   * Five call sites gate permission sync on a connector's
   * `supportsPermissionSync` flag — the due-loop trigger, the sync run itself,
   * the source-access-control check, the knowledge-base route, and this
   * function, which the scheduler uses to ask the database for exactly the
   * connectors it could schedule. Flipping one connector's flag to `false`
   * compiles cleanly and silently stops permission syncing for that source,
   * so the capability matrix is pinned here rather than as fifteen separate
   * assertions that each restate one connector's own literal.
   *
   * `perforce` is excluded on purpose: it derives the flag from
   * `isK8sConfigured()`, so its membership follows the environment rather than
   * the source.
   */
  test("pins the connector types that implement permission sync", () => {
    const types = getPermissionSyncConnectorTypes()
      .filter((type) => type !== "perforce")
      .sort();

    expect(types).toEqual([
      "asana",
      "confluence",
      "dropbox",
      "gdrive",
      "github",
      "gitlab",
      "jira",
      "linear",
      "mfiles",
      "notion",
      "onedrive",
      "outline",
      "salesforce",
      "servicenow",
      "sharepoint",
    ]);
  });

  test("excludes a connector that does not implement permission sync", () => {
    expect(getPermissionSyncConnectorTypes()).not.toContain("web_crawler");
  });
});
