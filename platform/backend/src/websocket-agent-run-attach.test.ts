import { EventEmitter } from "node:events";
import type { ClientWebSocketMessage } from "@archestra/shared";
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import websocketService from "@/websocket";

const service = websocketService as unknown as {
  handleMessage: (message: ClientWebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<
    WS,
    { userId: string; organizationId: string; userIsMcpServerAdmin: boolean }
  >;
  cleanupAgentRunSubscriptions: (ws: WS) => void;
};

type AttachParams = Parameters<typeof agentRuntimeManager.attach>[0];
type Attachment = Awaited<ReturnType<typeof agentRuntimeManager.attach>>;

function deferredAttachment(params: AttachParams) {
  let resolve!: (attachment: Attachment) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Attachment>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const socket = Object.assign(new EventEmitter(), {
    readyState: WS.OPEN,
    close: vi.fn(),
    send: vi.fn(),
  });
  const input: string[] = [];
  params.stdin.on("data", (chunk: Buffer) => input.push(chunk.toString()));
  return {
    params,
    socket,
    input,
    promise,
    resolve: () =>
      resolve({
        podName: "agent-run-pod",
        command: "tmux attach",
        socket: socket as unknown as Attachment["socket"],
      }),
    reject,
  };
}

describe("websocket Agent run attach ownership", () => {
  let runId: string;
  let ws: WS;
  let send: ReturnType<typeof vi.fn>;
  let pending: ReturnType<typeof deferredAttachment>[];

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    pending = [];
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "org",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    runId = task.id;
    await AgentRunModel.create({
      organizationId: organization.id,
      taskId: runId,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      workloadName: `agent-run-${runId}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    send = vi.fn();
    ws = { readyState: WS.OPEN, send } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: owner.id,
      organizationId: organization.id,
      userIsMcpServerAdmin: false,
    });
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(agentRuntimeManager, "attach").mockImplementation((params) => {
      const attachment = deferredAttachment(params);
      pending.push(attachment);
      return attachment.promise;
    });
  });

  afterEach(() => {
    service.cleanupAgentRunSubscriptions(ws);
    service.clientContexts.delete(ws);
    for (const { params, socket } of pending) {
      params.stdin.destroy();
      params.stdout.destroy();
      params.stderr.destroy();
      socket.removeAllListeners();
    }
    vi.restoreAllMocks();
  });

  const subscribe = () =>
    service.handleMessage(
      { type: "subscribe_agent_run_attach", payload: { runId } },
      ws,
    );
  const unsubscribe = () =>
    service.handleMessage(
      { type: "unsubscribe_agent_run_attach", payload: { runId } },
      ws,
    );

  async function expectCurrentTerminalWorks() {
    send.mockClear();
    await service.handleMessage(
      { type: "agent_run_attach_input", payload: { runId, data: "abc123" } },
      ws,
    );
    await service.handleMessage(
      {
        type: "agent_run_attach_resize",
        payload: { runId, cols: 120, rows: 40 },
      },
      ws,
    );
    const current = pending[1];
    current.params.stdout.write("abc123");
    current.params.stderr.write("stderr");
    expect(pending.map((attachment) => attachment.input)).toEqual([
      [],
      ["abc123"],
    ]);
    expect(pending[0].socket.send).not.toHaveBeenCalled();
    expect(current.socket.send).toHaveBeenCalledWith(
      Buffer.concat([
        Buffer.from([4]),
        Buffer.from(JSON.stringify({ Width: 120, Height: 40 })),
      ]),
    );
    expect(send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: "agent_run_attach_output", payload: { runId, data: "abc123" } },
      { type: "agent_run_attach_output", payload: { runId, data: "stderr" } },
    ]);
  }

  function emitObsoleteCallbacks() {
    const old = pending[0];
    old.params.onProgress?.({
      phase: "attaching",
      message: "old progress",
      detail: null,
    });
    old.params.onStatus?.({ status: "Failure", message: "old failure" });
    old.params.stdout.emit("data", Buffer.from("old stdout"));
    old.params.stderr.emit("data", Buffer.from("old stderr"));
    old.socket.emit("close");
  }

  for (const reopen of [false, true]) {
    for (const completionOrder of [
      [0, 1],
      [1, 0],
    ]) {
      test(`keeps only the newest attach after ${reopen ? "close/reopen" : "overlap"}, completion order ${completionOrder}`, async () => {
        const first = subscribe();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        if (reopen) await unsubscribe();
        const second = subscribe();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        const requests = [first, second];
        for (const index of completionOrder) {
          pending[index].resolve();
          await requests[index];
        }
        expect(
          send.mock.calls.map(([message]) => JSON.parse(message).type),
        ).toEqual(["agent_run_attach_started"]);
        expect(pending[0].socket.close).toHaveBeenCalledOnce();
        expect(pending[0].params.stdin.destroyed).toBe(true);
        expect(pending[0].params.stdout.destroyed).toBe(true);
        expect(pending[0].params.stderr.destroyed).toBe(true);
        send.mockClear();
        emitObsoleteCallbacks();
        expect(send).not.toHaveBeenCalled();
        expect(pending[1].socket.close).not.toHaveBeenCalled();
        await expectCurrentTerminalWorks();
      });
    }
  }

  for (const disconnect of [false, true]) {
    test(`disposes an attach completing after ${disconnect ? "disconnect" : "unsubscribe"}`, async () => {
      const request = subscribe();
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      if (disconnect) {
        Object.assign(ws, { readyState: WS.CLOSED });
        service.cleanupAgentRunSubscriptions(ws);
        service.clientContexts.delete(ws);
      } else {
        await unsubscribe();
      }
      pending[0].resolve();
      await request;
      expect(pending[0].socket.close).toHaveBeenCalledOnce();
      expect(pending[0].params.stdin.destroyed).toBe(true);
      expect(pending[0].params.stdout.destroyed).toBe(true);
      expect(pending[0].params.stderr.destroyed).toBe(true);
      emitObsoleteCallbacks();
      expect(send).not.toHaveBeenCalled();
    });
  }

  test("ignores an obsolete attach rejection after a replacement is live", async () => {
    const first = subscribe();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = subscribe();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve();
    await second;
    send.mockClear();
    pending[0].reject(new Error("obsolete attach failed"));
    await first;
    expect(send).not.toHaveBeenCalled();
    expect(pending[1].socket.close).not.toHaveBeenCalled();
    expect(pending[0].params.stdin.destroyed).toBe(true);
    expect(pending[0].params.stdout.destroyed).toBe(true);
    expect(pending[0].params.stderr.destroyed).toBe(true);
    await expectCurrentTerminalWorks();
  });

  test("ignores late callbacks from an already attached terminal after replacement", async () => {
    const first = subscribe();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve();
    await first;
    const second = subscribe();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve();
    await second;
    send.mockClear();
    emitObsoleteCallbacks();
    expect(send).not.toHaveBeenCalled();
    expect(pending[1].socket.close).not.toHaveBeenCalled();
    await expectCurrentTerminalWorks();
  });
});
