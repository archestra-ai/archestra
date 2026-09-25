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

  async function startAttach() {
    const index = pending.length;
    const done = service.handleMessage(
      { type: "subscribe_agent_run_attach", payload: { runId } },
      ws,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(index + 1));
    return { ...pending[index], done };
  }

  const messages = () =>
    send.mock.calls.map(([message]) => JSON.parse(message));

  test.each([
    "old first",
    "new first",
  ])("keeps the newest terminal when overlapping attaches finish %s", async (order) => {
    const old = await startAttach();
    const current = await startAttach();
    for (const attachment of order === "old first"
      ? [old, current]
      : [current, old]) {
      attachment.resolve();
      await attachment.done;
    }
    expect(messages().map(({ type }) => type)).toEqual([
      "agent_run_attach_started",
    ]);
    expect(old.socket.close).toHaveBeenCalledOnce();
    expect(current.socket.close).not.toHaveBeenCalled();

    await service.handleMessage(
      { type: "agent_run_attach_input", payload: { runId, data: "hello" } },
      ws,
    );
    expect(old.input).toEqual([]);
    expect(current.input).toEqual(["hello"]);
    current.params.stdout.write("hello");
    expect(messages().at(-1)).toEqual({
      type: "agent_run_attach_output",
      payload: { runId, data: "hello" },
    });
  });

  test.each([
    "unsubscribe",
    "disconnect",
  ])("closes a pending attach that completes after %s", async (action) => {
    const attachment = await startAttach();
    if (action === "disconnect") {
      service.cleanupAgentRunSubscriptions(ws);
      service.clientContexts.delete(ws);
    } else {
      await service.handleMessage(
        { type: "unsubscribe_agent_run_attach", payload: { runId } },
        ws,
      );
    }
    attachment.resolve();
    await attachment.done;
    expect(attachment.socket.close).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test("ignores an obsolete attach rejection after a replacement is live", async () => {
    const old = await startAttach();
    const current = await startAttach();
    current.resolve();
    await current.done;
    send.mockClear();
    old.reject(new Error("obsolete attach failed"));
    await old.done;
    expect(send).not.toHaveBeenCalled();
    expect(current.socket.close).not.toHaveBeenCalled();
  });

  test("ignores late events from a replaced terminal", async () => {
    const old = await startAttach();
    old.resolve();
    await old.done;
    const current = await startAttach();
    current.resolve();
    await current.done;
    send.mockClear();

    old.params.onProgress?.({
      phase: "attaching",
      message: "old progress",
      detail: null,
    });
    old.params.onStatus?.({ status: "Failure", message: "old failure" });
    old.params.stdout.emit("data", Buffer.from("old output"));
    old.socket.emit("close");
    expect(send).not.toHaveBeenCalled();
    expect(current.socket.close).not.toHaveBeenCalled();
  });
});
