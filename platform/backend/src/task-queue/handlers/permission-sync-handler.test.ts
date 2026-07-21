// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

const mockExecutePass = vi.hoisted(() => vi.fn());
vi.mock("@/knowledge-base", () => ({
  permissionSyncService: { executePass: mockExecutePass },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

const mockWithinResumeBudget = vi.hoisted(() => vi.fn());
vi.mock("./connector-resume-budget", () => ({
  withinResumeBudget: mockWithinResumeBudget,
}));

vi.mock("@/entrypoints/_shared/log-capture", () => ({
  createCapturingLogger: () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
    },
    getLogOutput: () => "",
  }),
}));

import { handlePermissionSync } from "./permission-sync-handler";

describe("handlePermissionSync", () => {
  let connectorId: string;

  beforeEach(() => {
    connectorId = randomUUID();
    vi.clearAllMocks();
    mockWithinResumeBudget.mockResolvedValue(true);
    config.kb.autoSyncPermissionsEnabled = true;
  });

  test("a mapping follow-up (refreshAudiences) runs a plain delta pass — every delta verifies audiences", async () => {
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "success" });

    await handlePermissionSync({ connectorId, refreshAudiences: true });

    expect(mockExecutePass).toHaveBeenCalledTimes(1);
    const options = mockExecutePass.mock.calls[0][1];
    expect(options).not.toHaveProperty("mode");
  });

  test("a forced audience refresh that loses the claim to a running pass throws so the task retries", async () => {
    mockExecutePass.mockResolvedValue({ runId: "", status: "skipped" });

    await expect(
      handlePermissionSync({ connectorId, refreshAudiences: true }),
    ).rejects.toThrow(/Audience refresh deferred/);

    // A plain pass losing the claim stays a silent no-op.
    await expect(
      handlePermissionSync({ connectorId }),
    ).resolves.toBeUndefined();
  });

  test("enqueues a continuation on a partial result when within the permission-run budget", async () => {
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "partial" });

    await handlePermissionSync({ connectorId });

    expect(mockWithinResumeBudget).toHaveBeenCalledWith({
      connectorId,
      runType: "permission",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "permission_sync",
      payload: { connectorId },
    });
  });

  test("does not enqueue a continuation when the connector is over its permission-run budget", async () => {
    // A pass that persistently fails fast ends partial every time; without the
    // budget gate it re-enqueues itself in a hot loop with no backoff.
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "partial" });
    mockWithinResumeBudget.mockResolvedValue(false);

    await handlePermissionSync({ connectorId });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("does not fail the task when the continuation enqueue fails", async () => {
    // The pass itself finished; a lost continuation is the reaper's job to
    // recover, not a reason to mark the completed task failed.
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "partial" });
    mockEnqueue.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      handlePermissionSync({ connectorId }),
    ).resolves.toBeUndefined();
  });

  test("does not enqueue a continuation on success", async () => {
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "success" });

    await handlePermissionSync({ connectorId });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("completes as a no-op when the beta flag is disabled", async () => {
    // A task enqueued before the flag flipped off must not run a pass for a
    // hidden feature (and must not throw, which would burn retries).
    config.kb.autoSyncPermissionsEnabled = false;
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "success" });

    await handlePermissionSync({ connectorId });

    expect(mockExecutePass).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("throws when connectorId is missing", async () => {
    await expect(handlePermissionSync({})).rejects.toThrow(
      "permission_sync payload has no usable connectorId",
    );
    expect(mockExecutePass).not.toHaveBeenCalled();
  });

  test("throws instead of running a pass when connectorId is not a string", async () => {
    // The payload is jsonb, so nothing stops a non-string landing here. It used
    // to be cast to `string` and only checked for truthiness, which let a number
    // through to be compared against uuid columns deep inside the pass.
    await expect(handlePermissionSync({ connectorId: 12345 })).rejects.toThrow(
      "permission_sync payload has no usable connectorId (got number)",
    );
    expect(mockExecutePass).not.toHaveBeenCalled();
  });
});
