import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { ConversationModel } from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import {
  ActiveChatRunService,
  activeChatRunService,
} from "@/services/active-chat-run";
import {
  InMemoryActiveChatRunNotifier,
  PollingActiveChatRunNotifier,
} from "@/services/active-chat-run-notifier";
import { expect, test } from "@/test";

test("drainStreamToEvents compacts adjacent text and reasoning deltas before marking terminal", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    stream: createChunkStream([
      { type: "start" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hel" },
      { type: "text-delta", id: "text-1", delta: "lo" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "a" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "b" },
      { type: "text-delta", id: "text-2", delta: "separate" },
      { type: "finish", finishReason: "stop" },
    ]),
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  await waitForTerminalRun(run?.id ?? "");
  const events = await ActiveChatRunModel.readEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.payloads).toEqual([
    { type: "start" },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "hello" },
    { type: "reasoning-start", id: "reasoning-1" },
    { type: "reasoning-delta", id: "reasoning-1", delta: "ab" },
    { type: "text-delta", id: "text-2", delta: "separate" },
    { type: "finish", finishReason: "stop" },
  ]);

  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(terminalRun?.status).toBe("completed");
});

test("terminalReady resolves only once the run is terminal, so an immediate next send is no longer 409-blocked", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  // While the run is `running`, a second send is rejected — this is the window
  // a client used to hit when it sent the next message the instant the stream
  // ended but the async drain hadn't flipped the row terminal yet.
  const blocked = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  expect(blocked).toBeNull();

  const { terminalReady } = activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    stream: createChunkStream([
      { type: "start" },
      { type: "text-delta", id: "text-1", delta: "hi" },
      { type: "finish", finishReason: "stop" },
    ]),
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  // The route releases the client stream's close only after this resolves.
  await terminalReady;

  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(terminalRun?.status).toBe("completed");
  // The same send that was blocked above now succeeds — no 409.
  const next = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  expect(next).not.toBeNull();
});

test("terminalReady resolves on the error path too, so a next send after a failed run isn't 409-blocked", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const { terminalReady } = activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    // An error chunk, then the stream closes (the common provider-error case).
    stream: createChunkStream([
      { type: "start" },
      { type: "error", errorText: "provider exploded" },
    ]),
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  await terminalReady;

  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(terminalRun?.status).toBe("failed");
  const next = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  expect(next).not.toBeNull();
});

test("drainStreamToEvents fails the run as soon as an error chunk arrives, even if the stream never closes", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  // A provider error surfaced mid-turn while the upstream connection wedges
  // open: the client already rendered the error, but the stream never ends.
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start" });
      controller.enqueue({ type: "error", errorText: "provider exploded" });
      // intentionally never closed
    },
  });

  activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    stream,
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  // The run must flip to failed without waiting for the stream to close —
  // otherwise the conversation stays 409-blocked until the stale reaper.
  await waitForTerminalRun(run?.id ?? "");
  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(terminalRun?.status).toBe("failed");
  expect(terminalRun?.error).toBe("provider exploded");

  // The error event is flushed before the status flips, so a replaying
  // client can never observe the failed run without the error chunk.
  const events = await ActiveChatRunModel.readEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });
  expect(events.flatMap((event) => event.payloads)).toContainEqual({
    type: "error",
    errorText: "provider exploded",
  });
});

test("createReplayStream uses polling fallback when no notification arrives", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const service = new ActiveChatRunService(
    new PollingActiveChatRunNotifier(),
    20,
    20,
  );

  const streamPromise = readStream(service.createReplayStream(run?.id ?? ""));
  setTimeout(() => {
    void (async () => {
      await ActiveChatRunModel.appendEvents({
        runId: run?.id ?? "",
        seq: 1,
        payloads: [{ type: "start" }],
      });
      await ActiveChatRunModel.markTerminal({
        runId: run?.id ?? "",
        status: "completed",
      });
    })();
  }, 5);

  await expect(streamPromise).resolves.toContainEqual({ type: "start" });
});

test("createReplayStream wakes from notifier without waiting for the polling interval", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const notifier = new InMemoryActiveChatRunNotifier();
  const service = new ActiveChatRunService(notifier, 10_000, 10_000);

  const streamPromise = Promise.race([
    readStream(service.createReplayStream(run?.id ?? "")),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Replay did not wake up")), 200),
    ),
  ]);

  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 1,
    payloads: [{ type: "start" }],
  });
  await ActiveChatRunModel.markTerminal({
    runId: run?.id ?? "",
    status: "completed",
  });
  await notifier.notifyEvent(run?.id ?? "");

  await expect(streamPromise).resolves.toContainEqual({ type: "start" });
});

test("startStopPolling aborts after a durable stop request notification", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const notifier = new InMemoryActiveChatRunNotifier();
  const service = new ActiveChatRunService(notifier, 10_000, 10_000);
  const abortController = new AbortController();
  const stopPolling = service.startStopPolling({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController,
  });

  await notifier.notifyStop(run?.id ?? "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(abortController.signal.aborted).toBe(false);

  await ActiveChatRunModel.requestStop({
    conversationId: conversation.id,
    organizationId: organization.id,
  });
  await notifier.notifyStop(run?.id ?? "");

  await waitForAbort(abortController.signal);
  stopPolling();
});

test("drainStreamToEvents aborts the source stream when event persistence fails", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const appendSpy = vi
    .spyOn(ActiveChatRunModel, "appendEvents")
    .mockRejectedValueOnce(new Error("event persistence failed"));
  const abortController = new AbortController();

  activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    stream: createChunkStream([{ type: "start" }]),
    abortController,
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  await waitForAbort(abortController.signal);
  await waitForTerminalRun(run?.id ?? "");
  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");

  expect(terminalRun?.status).toBe("failed");
  appendSpy.mockRestore();
});

test("createRun throttles terminal cleanup and only checks stale runs after conflicts", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const firstConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const secondConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const deleteSpy = vi
    .spyOn(ActiveChatRunModel, "deleteTerminalOlderThan")
    .mockResolvedValue(0);
  const staleSpy = vi
    .spyOn(ActiveChatRunModel, "markStaleRunningAsFailed")
    .mockResolvedValue(0);
  const service = new ActiveChatRunService(
    new InMemoryActiveChatRunNotifier(),
    10_000,
    10_000,
  );

  const first = await service.createRun({
    conversationId: firstConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const second = await service.createRun({
    conversationId: secondConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const duplicate = await service.createRun({
    conversationId: firstConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(duplicate).toBeNull();
  expect(deleteSpy).toHaveBeenCalledTimes(1);
  expect(staleSpy).toHaveBeenCalledTimes(1);

  deleteSpy.mockRestore();
  staleSpy.mockRestore();
});

test("failInFlightRuns fails this pod's running runs and clears the set", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const runningConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const completedConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const service = new ActiveChatRunService(
    new InMemoryActiveChatRunNotifier(),
    10_000,
    10_000,
  );

  const runningRun = await service.createRun({
    conversationId: runningConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const completedRun = await service.createRun({
    conversationId: completedConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  // A completed run leaves the in-flight set and must not be re-failed.
  await service.markTerminal({
    runId: completedRun?.id ?? "",
    status: "completed",
  });

  expect(await service.failInFlightRuns()).toBe(1);
  expect(
    (await ActiveChatRunModel.findById(runningRun?.id ?? ""))?.status,
  ).toBe("failed");
  expect(
    (await ActiveChatRunModel.findById(completedRun?.id ?? ""))?.status,
  ).toBe("completed");

  // The set is cleared, so a second shutdown pass fails nothing.
  expect(await service.failInFlightRuns()).toBe(0);
});

test("createRun refuses new runs once shutdown has begun", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const service = new ActiveChatRunService(
    new InMemoryActiveChatRunNotifier(),
    10_000,
    10_000,
  );

  service.beginShutdown();
  expect(service.shuttingDown).toBe(true);

  const run = await service.createRun({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  // No run is created after shutdown begins, so there is nothing to orphan.
  expect(run).toBeNull();
  expect(
    await ActiveChatRunModel.findRunningByConversation(conversation.id),
  ).toBeNull();
  expect(await service.failInFlightRuns()).toBe(0);
});

test("reapStaleRuns fails runs past the stale cutoff", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const service = new ActiveChatRunService(
    new InMemoryActiveChatRunNotifier(),
    10_000,
    10_000,
  );

  const run = await service.createRun({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  await db
    .update(schema.chatActiveRunsTable)
    .set({ updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(schema.chatActiveRunsTable.id, run?.id ?? ""));

  await service.reapStaleRuns();

  expect((await ActiveChatRunModel.findById(run?.id ?? ""))?.status).toBe(
    "failed",
  );
});

test("startStopPolling aborts when the run row no longer exists", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const notifier = new InMemoryActiveChatRunNotifier();
  const service = new ActiveChatRunService(notifier, 10_000, 20);
  const abortController = new AbortController();
  const stopPolling = service.startStopPolling({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController,
  });

  // Deleting the conversation cascades the run row away. The stop poll observes
  // the now-missing row and aborts, the same as DELETE waking it via notify.
  await ConversationModel.delete(conversation.id, user.id, organization.id);
  await notifier.notifyStop(run?.id ?? "");

  await waitForAbort(abortController.signal);
  stopPolling();
});

test("drainStreamToEvents stops cleanly when the run is deleted before a scheduled flush", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const service = new ActiveChatRunService(
    new InMemoryActiveChatRunNotifier(),
    10_000,
    10_000,
  );
  const run = await service.createRun({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  // One chunk then the stream stays open: the batcher schedules a timer flush
  // rather than an immediate batch flush, so the flush fires only after the
  // conversation is deleted out from under the drain.
  let sourceCancelled = false;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start" });
    },
    cancel() {
      sourceCancelled = true;
    },
  });
  const abortController = new AbortController();

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  try {
    service.drainStreamToEvents({
      runId: run?.id ?? "",
      conversationId: conversation.id,
      stream,
      abortController,
      getTerminalStatus: async () => ({ status: "completed" }),
    });

    await ConversationModel.delete(conversation.id, user.id, organization.id);

    // The scheduled flush sees run_missing, so the drain aborts the chat and
    // cancels the source instead of leaving a process-level unhandled rejection.
    // These waits throw if the controlled run-gone path does not run.
    await waitForCondition(() => abortController.signal.aborted, 3_000);
    await waitForCondition(() => sourceCancelled, 1_000);
    // Brief settle so any stray rejection surfaces before we stop listening.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  expect(rejections).toEqual([]);
  expect(await ActiveChatRunModel.findById(run?.id ?? "")).toBeNull();
});

function createChunkStream(
  payloads: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(payload);
      }
      controller.close();
    },
  });
}

async function readStream(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return chunks;
    }
    chunks.push(value);
  }
}

async function waitForTerminalRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await ActiveChatRunModel.findById(runId);
    if (run && run.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Active chat run did not reach terminal status");
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal.aborted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Active chat run was not aborted");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition was not met within timeout");
}
