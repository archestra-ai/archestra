import config from "@/config";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-policy-tests.routes";

const files = [
  { path: "traces/read.appa", content: "files/read {}\nexpect allow\n" },
];
describe("policy test collection ownership", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(() => {
    config.openappa.enabled = true;
  });
  test("persists local definitions and refuses stale edits", async () => {
    const save = await ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/policy-tests",
      payload: { files, expectedVersion: "empty" },
    });
    expect(save.statusCode, save.body).toBe(200);
    const saved = save.json();
    expect(saved.files).toEqual(files);
    const stale = await ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/policy-tests",
      payload: { files: [], expectedVersion: "empty" },
    });
    expect(stale.statusCode).toBe(409);
    const read = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(read.json()).toMatchObject({
      source: "local",
      files,
      version: saved.version,
    });
  });
  test("connecting Git prevents local overrides and does not restore older local files on disconnect", async () => {
    await OpenAppaPolicyTestsModel.saveLocal({
      organizationId: ctx.organizationId,
      files,
      expectedVersion: "empty",
    });
    await OpenAppaGithubSyncModel.save(ctx.organizationId, {
      repo: "example/policy",
      path: "appa.toml",
      ref: "main",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
    });
    const blocked = await ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/policy-tests",
      payload: { files, expectedVersion: "empty" },
    });
    expect(blocked.statusCode).toBe(409);
    const source = await OpenAppaGithubSyncModel.find(ctx.organizationId);
    expect(
      await OpenAppaPolicyTestsModel.cacheGithub({
        organizationId: ctx.organizationId,
        files,
        sourceRevision: source?.revision ?? "missing",
        sourceCommit: "a".repeat(40),
        directory: "traces",
      }),
    ).toBe(false);
    await OpenAppaGithubSyncModel.setInterval(ctx.organizationId, null);
    const read = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(read.json()).toMatchObject({ source: "local", files: [] });
  });
  test("rejects duplicate files, parent paths and non-appa files", async () => {
    for (const invalid of [
      [...files, ...files],
      [{ path: "../read.appa", content: "" }],
      [{ path: "run.sh", content: "" }],
    ]) {
      const response = await ctx.app.inject({
        method: "PUT",
        url: "/api/openappa/policy-tests",
        payload: { files: invalid, expectedVersion: "empty" },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
