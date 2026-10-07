import { HttpResponse, http } from "msw";
import config from "@/config";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-policy-tests.routes";

const commit = "a".repeat(40);
const content = "files/read {}\nexpect allow\n";
describe("Git policy test loading", () => {
  const ctx = useRouteTestApp(routes);
  const server = useMswServer();
  beforeEach(async () => {
    config.openappa.enabled = true;
    await OpenAppaGithubSyncModel.save(ctx.organizationId, {
      repo: "example/policy",
      path: "appa.toml",
      ref: "main",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
    });
  });
  test("a blank configured directory gives an empty Git collection with no local fallback", async () => {
    await OpenAppaGithubSyncModel.save(ctx.organizationId, {
      repo: "example/policy",
      path: "appa.toml",
      ref: "main",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      validationDirectory: "",
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(response.json()).toMatchObject({
      source: "github",
      files: [],
      directory: "",
      activeDirectory: "",
      error: null,
    });
  });
  test("reads only the accepted commit and retains imported definitions after disconnect", async () => {
    const source = await OpenAppaGithubSyncModel.find(ctx.organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId: ctx.organizationId,
      revision: source?.revision ?? "missing",
      outcome: {
        content: "[policy]\nversion = 2\n",
        contentHash: "policy-hash",
        sourceCommit: commit,
      },
    });
    const requestedRefs: string[] = [];
    server.use(
      http.get(
        "https://api.github.com/repos/example/policy/contents/traces",
        ({ request }) => {
          requestedRefs.push(
            new URL(request.url).searchParams.get("ref") ?? "missing",
          );
          return HttpResponse.json([
            { type: "file", path: "traces/read.appa", size: content.length },
            { type: "file", path: "traces/run.sh", size: 1 },
          ]);
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policy/contents/traces/read.appa",
        ({ request }) => {
          requestedRefs.push(
            new URL(request.url).searchParams.get("ref") ?? "missing",
          );
          return HttpResponse.text(content);
        },
      ),
    );
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      source: "github",
      sourceCommit: commit,
      files: [{ path: "traces/read.appa", content }],
      error: null,
    });
    expect(requestedRefs).toEqual([commit, commit]);
    await OpenAppaGithubSyncModel.setInterval(ctx.organizationId, null);
    const local = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(local.json()).toMatchObject({
      source: "local",
      files: [{ path: "traces/read.appa", content }],
    });
  });
  test("missing accepted commit is an explicit Git error without local fallback", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(response.json()).toMatchObject({ source: "github", files: [] });
    expect(response.json().error).toContain("no accepted commit");
  });
  test("a failed fetch retains Git ownership and separates inaccessible directories", async () => {
    const source = await OpenAppaGithubSyncModel.find(ctx.organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId: ctx.organizationId,
      revision: source?.revision ?? "missing",
      outcome: {
        content: "[policy]\nversion = 2\n",
        contentHash: "policy-hash",
        sourceCommit: commit,
      },
    });
    server.use(
      http.get(
        "https://api.github.com/repos/example/policy/contents/traces",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(response.json()).toMatchObject({ source: "github", files: [] });
    expect(response.json().error).toContain("denied access");
  });
});
