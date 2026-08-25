import { afterEach, describe, expect, test, vi } from "vitest";
import { STUB_COMMIT_SHA, stubGithub } from "@/test/github-skills-stub";
import { PLUGIN_MAX_TOTAL_BYTES } from "@/types";
import { importPluginFromGithub, PluginImportError } from "./github-import";

const gitFallback = vi.hoisted(() => ({
  readPublicGithubTree: vi.fn(),
  resolvePublicGithubCommit: vi.fn(),
}));

vi.mock("./github-public-git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-public-git")>();
  return {
    ...actual,
    readPublicGithubTree: gitFallback.readPublicGithubTree,
    resolvePublicGithubCommit: gitFallback.resolvePublicGithubCommit,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  gitFallback.readPublicGithubTree.mockReset();
  gitFallback.resolvePublicGithubCommit.mockReset();
});

describe("importPluginFromGithub", () => {
  test("pins a commit, preserves plugin components/modes, and strips CI files", async () => {
    const binary = Buffer.from([0xff, 0x00, 0x01]);
    stubGithub([
      {
        owner: "plugin-import",
        repo: "plugin",
        files: {
          "hooks/hooks.json": '  { "hooks": {} }  \n',
          "scripts/run.sh": "#!/bin/sh\ntrue\n",
          "assets/icon.bin": binary,
          ".mcp.json": '{"mcpServers":{"danger":{}}}',
          ".github/workflows/ci.yml": "on: push",
        },
        modes: { "scripts/run.sh": "100755" },
      },
    ]);

    const imported = await importPluginFromGithub({
      repoUrl: "https://github.com/plugin-import/plugin/tree/main",
    });

    expect(imported).toMatchObject({
      repo: "plugin-import/plugin",
      requestedRef: "main",
      commitSha: STUB_COMMIT_SHA,
      subdir: "",
    });
    expect(imported.files).toEqual([
      {
        path: ".mcp.json",
        content: '{"mcpServers":{"danger":{}}}',
        encoding: "utf8",
        mode: "100644",
      },
      {
        path: "assets/icon.bin",
        content: binary.toString("base64"),
        encoding: "base64",
        mode: "100644",
      },
      {
        path: "hooks/hooks.json",
        content: '  { "hooks": {} }  \n',
        encoding: "utf8",
        mode: "100644",
      },
      {
        path: "scripts/run.sh",
        content: "#!/bin/sh\ntrue\n",
        encoding: "utf8",
        mode: "100755",
      },
    ]);
    expect(imported.skippedFiles).toEqual([".github/workflows/ci.yml"]);
  });

  test("imports only the selected subtree and applies explicit excludes", async () => {
    stubGithub([
      {
        owner: "plugin-subdir",
        repo: "plugins",
        files: {
          "plugins/one/hooks/hooks.json": "{}\n",
          "plugins/one/scripts/run.sh": "true\n",
          "plugins/one/notes/private.txt": "skip\n",
          "plugins/two/hooks/hooks.json": "other\n",
        },
      },
    ]);

    const imported = await importPluginFromGithub({
      repoUrl: "plugin-subdir/plugins",
      ref: "v1",
      subdir: "plugins/one",
      exclude: ["notes/**"],
    });

    expect(imported.requestedRef).toBe("v1");
    expect(imported.subdir).toBe("plugins/one");
    expect(imported.files.map((file) => file.path)).toEqual([
      "hooks/hooks.json",
      "scripts/run.sh",
    ]);
    expect(imported.skippedFiles).toEqual(["notes/private.txt"]);
  });

  test("rejects unsafe sources while accepting hookless plugin files", async () => {
    await expect(
      importPluginFromGithub({ repoUrl: "gitlab.example.com/org/repo" }),
    ).rejects.toThrow(PluginImportError);

    stubGithub([
      {
        owner: "plugin-unsafe-path",
        repo: "plugin",
        files: { "../hooks/hooks.json": "{}\n" },
      },
    ]);
    await expect(
      importPluginFromGithub({ repoUrl: "plugin-unsafe-path/plugin" }),
    ).rejects.toThrow("unsafe plugin path");
    vi.unstubAllGlobals();

    stubGithub([
      {
        owner: "plugin-hookless",
        repo: "plugin",
        files: { "scripts/run.sh": "true\n" },
      },
    ]);
    const hookless = await importPluginFromGithub({
      repoUrl: "plugin-hookless/plugin",
    });
    expect(hookless.files).toEqual([
      expect.objectContaining({ path: "scripts/run.sh", content: "true\n" }),
    ]);
  });

  test("enforces the aggregate limit on fetched bytes, not tree metadata", async () => {
    const files: Record<string, string> = {
      "hooks/hooks.json": "{}\n",
    };
    const treeSizes: Record<string, number> = { "hooks/hooks.json": 0 };
    // More candidates than the worker pool can claim before the aggregate
    // budget fills: unattempted entries must become skipped files, not holes
    // that crash the assembly pass.
    for (let index = 0; index < 20; index += 1) {
      const path = `zz-assets/${index}.txt`;
      files[path] = "x".repeat(700 * 1024);
      treeSizes[path] = 0;
    }
    stubGithub([
      {
        owner: "plugin-aggregate",
        repo: "plugin",
        files,
        treeSizes,
      },
    ]);

    const imported = await importPluginFromGithub({
      repoUrl: "plugin-aggregate/plugin",
    });
    const totalBytes = imported.files.reduce(
      (sum, file) =>
        sum +
        (file.encoding === "base64"
          ? Buffer.from(file.content, "base64").length
          : Buffer.byteLength(file.content)),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(PLUGIN_MAX_TOTAL_BYTES);
    expect(imported.skippedFiles.length).toBeGreaterThan(0);
  });

  test("imports the approved commit even when the tracking branch moved", async () => {
    const reviewedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const movedSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const fetchMock = stubGithub([
      {
        owner: "plugin-moved",
        repo: "plugin",
        commitSha: reviewedSha,
        files: { "hooks/hooks.json": "{}\n" },
      },
    ]);
    const githubStub = fetchMock.getMockImplementation() as
      | ((input: string | URL | Request) => Promise<Response>)
      | undefined;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      // The branch advanced after the review: resolving "main" now yields a
      // commit whose raw files the stub does not serve.
      if (
        url.hostname === "api.github.com" &&
        url.pathname.endsWith("/commits/main")
      ) {
        return Response.json({ sha: movedSha });
      }
      if (!githubStub) throw new Error("GitHub stub is not configured");
      return githubStub(input);
    });

    const imported = await importPluginFromGithub({
      repoUrl: "plugin-moved/plugin",
      ref: reviewedSha,
      trackingRef: "main",
    });

    expect(imported.commitSha).toBe(reviewedSha);
    expect(imported.requestedRef).toBe("main");
    expect(imported.files.map((file) => file.path)).toEqual([
      "hooks/hooks.json",
    ]);
  });

  test("imports through public Git when the anonymous REST quota is exhausted", async () => {
    const files = {
      "hooks/hooks.json": '{"hooks":{}}\n',
      "scripts/run.sh": "#!/bin/sh\ntrue\n",
    };
    const fetchMock = stubGithub([
      {
        owner: "rate-limited-import",
        repo: "plugin",
        files,
        modes: { "scripts/run.sh": "100755" },
      },
    ]);
    const githubStub = fetchMock.getMockImplementation() as
      | ((input: string | URL | Request) => Promise<Response>)
      | undefined;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      if (url.hostname === "api.github.com") {
        return Response.json(
          { message: "API rate limit exceeded for shared egress" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          },
        );
      }
      if (!githubStub) throw new Error("GitHub stub is not configured");
      return githubStub(input);
    });
    gitFallback.resolvePublicGithubCommit.mockResolvedValue(STUB_COMMIT_SHA);
    gitFallback.readPublicGithubTree.mockResolvedValue([
      {
        type: "blob",
        path: "hooks/hooks.json",
        mode: "100644",
        size: 0,
      },
      {
        type: "blob",
        path: "scripts/run.sh",
        mode: "100755",
        size: 0,
      },
    ]);

    const imported = await importPluginFromGithub({
      repoUrl: "rate-limited-import/plugin",
      ref: "main",
    });

    expect(imported).toMatchObject({
      commitSha: STUB_COMMIT_SHA,
      requestedRef: "main",
    });
    expect(imported.files.map((file) => file.path)).toEqual([
      "hooks/hooks.json",
      "scripts/run.sh",
    ]);
    expect(gitFallback.resolvePublicGithubCommit).toHaveBeenCalledOnce();
    expect(gitFallback.readPublicGithubTree).toHaveBeenCalledOnce();
  });
});
