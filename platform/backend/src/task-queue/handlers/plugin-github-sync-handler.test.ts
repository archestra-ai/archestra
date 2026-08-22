import { vi } from "vitest";
import { PluginModel } from "@/models";
import { afterEach, expect, test } from "@/test";
import { STUB_COMMIT_SHA, stubGithub } from "@/test/github-skills-stub";
import { handlePluginGithubSync } from "./plugin-github-sync-handler";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("records a pinned update candidate without replacing approved bytes", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const originalContent = '{"version":1}\n';
  const plugin = await PluginModel.create({
    organizationId: organization.id,
    userId: user.id,
    input: {
      displayName: "Tracked plugin",
      description: "Periodic sync test",
      clientType: "claude-code",
      files: [
        {
          path: "hooks/hooks.json",
          content: originalContent,
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
    source: {
      repo: "sync-owner/plugin",
      ref: "main",
      sha: "old-commit",
      subdir: "",
      exclude: [],
      syncInterval: "15m",
      syncRef: "main",
    },
  });
  if (!plugin) throw new Error("failed to seed plugin");
  stubGithub([
    {
      owner: "sync-owner",
      repo: "plugin",
      files: { "hooks/hooks.json": '{"version":2}\n' },
    },
  ]);

  await handlePluginGithubSync({ pluginId: plugin.id });

  const checked = await PluginModel.findById({
    id: plugin.id,
    organizationId: organization.id,
  });
  expect(checked).toMatchObject({
    sourceSha: "old-commit",
    pendingSourceSha: STUB_COMMIT_SHA,
    pendingContentHash: expect.any(String),
    lastSyncError: null,
  });
  expect(checked?.files[0].content).toBe(originalContent);
});

test("a stale sync result cannot restore state after disconnect", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const plugin = await PluginModel.create({
    organizationId: organization.id,
    userId: user.id,
    input: {
      displayName: "Disconnect race",
      description: "CAS guard test",
      clientType: "claude-code",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}\n",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
    source: {
      repo: "sync-owner/race",
      ref: "main",
      sha: "old-commit",
      subdir: "",
      exclude: [],
      syncInterval: "15m",
      syncRef: "main",
    },
  });
  if (!plugin) throw new Error("failed to seed plugin");
  const syncRow = await PluginModel.findByIdForSync(plugin.id);
  if (!syncRow) throw new Error("failed to load sync generation");
  await PluginModel.setGithubSync({ id: plugin.id, interval: null });

  const written = await PluginModel.markGithubSyncResult({
    id: plugin.id,
    expectedSyncGeneration: syncRow.syncGeneration,
    expectedPendingSourceSha: syncRow.pendingSourceSha,
    sourceSha: STUB_COMMIT_SHA,
    files: plugin.files.map(({ path, content, encoding, mode }) => ({
      path,
      content,
      encoding,
      mode,
    })),
    error: null,
  });

  expect(written).toBe(false);
  const checked = await PluginModel.findById({
    id: plugin.id,
    organizationId: organization.id,
  });
  expect(checked).toMatchObject({
    githubSyncInterval: null,
    pendingSourceSha: null,
    lastSyncError: null,
  });
});

test("an older sync result cannot clear a newer pending candidate", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const plugin = await PluginModel.create({
    organizationId: organization.id,
    userId: user.id,
    input: {
      displayName: "Candidate race",
      description: "Pending candidate CAS test",
      clientType: "claude-code",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}\n",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
    source: {
      repo: "sync-owner/candidate-race",
      ref: "main",
      sha: "approved-commit",
      subdir: "",
      exclude: [],
      syncInterval: "15m",
      syncRef: "main",
    },
  });
  if (!plugin) throw new Error("failed to seed plugin");
  const observed = await PluginModel.findByIdForSync(plugin.id);
  if (!observed) throw new Error("failed to load sync state");

  const candidateWritten = await PluginModel.markGithubSyncResult({
    id: plugin.id,
    expectedSyncGeneration: observed.syncGeneration,
    expectedPendingSourceSha: observed.pendingSourceSha,
    sourceSha: "newer-candidate",
    files: plugin.files,
    error: null,
  });
  const staleWritten = await PluginModel.markGithubSyncResult({
    id: plugin.id,
    expectedSyncGeneration: observed.syncGeneration,
    expectedPendingSourceSha: observed.pendingSourceSha,
    sourceSha: "approved-commit",
    files: plugin.files,
    error: null,
  });

  expect(candidateWritten).toBe(true);
  expect(staleWritten).toBe(false);
  await expect(PluginModel.findByIdForSync(plugin.id)).resolves.toMatchObject({
    pendingSourceSha: "newer-candidate",
    pendingContentHash: expect.any(String),
  });
});
