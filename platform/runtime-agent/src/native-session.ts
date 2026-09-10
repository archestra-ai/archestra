import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  NativeSessionProvider,
  SessionControl,
  SessionEntry,
  SessionRequest,
  SessionSnapshot,
} from "./session-protocol.js";
import { type RpcMessage, type RpcObject, SessionRpc } from "./session-rpc.js";

export class NativeSession {
  readonly snapshot: SessionSnapshot;
  private rpc: SessionRpc;
  private sessionId = "";
  private turnId = "";
  private messageId = "";
  private acpMessage = "";
  private requests = new Map<string, { message: RpcMessage; kind: string }>();
  private stopped = false;
  private initialTurn = true;
  private ready = false;
  private restoring = false;
  private saveWork: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: {
      provider: NativeSessionProvider;
      command: string[];
      runtimeDir: string;
      continuing: boolean;
      onChange: () => void;
      onDone: (failed: boolean) => void;
    },
  ) {
    this.snapshot = {
      version: 1,
      provider: params.provider,
      entries: [],
      session: { state: "starting", requests: [] },
    };
    this.rpc = new SessionRpc({
      command: params.command,
      onMessage: (message) => this.onMessage(message),
      onExit: () =>
        this.fail(
          "The agent process disconnected. Resume the conversation to continue.",
        ),
    });
  }

  async start(text: string): Promise<void> {
    let saved: { sessionId: string; entries: SessionEntry[] } | undefined;
    if (this.params.continuing) {
      try {
        saved = JSON.parse(await readFile(this.historyPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved) this.snapshot.entries = saved.entries;
    }
    if (this.params.provider === "codex") {
      await this.rpc.request("initialize", {
        clientInfo: { name: "archestra", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.rpc.send({ method: "initialized", params: {} });
      const response = await this.rpc.request(
        saved?.sessionId ? "thread/resume" : "thread/start",
        {
          ...(saved?.sessionId ? { threadId: saved.sessionId } : {}),
          cwd: process.cwd(),
          model: process.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL,
          modelProvider: "archestra",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      );
      this.sessionId = string(object(response.thread).id);
    } else if (this.params.provider === "claude-code") {
      // --continue is resolved by the maintained launcher, in its isolated CLAUDE_CONFIG_DIR.
      this.sessionId = saved?.sessionId ?? "";
    } else {
      const initialized = await this.rpc.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "archestra", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const canLoad =
        object(initialized.agentCapabilities).loadSession === true;
      if (saved?.sessionId && !canLoad)
        throw new Error("This agent version cannot restore ACP sessions");
      this.restoring = !!saved?.sessionId;
      const response = await this.rpc.request(
        saved?.sessionId ? "session/load" : "session/new",
        {
          ...(saved?.sessionId ? { sessionId: saved.sessionId } : {}),
          cwd: process.cwd(),
          mcpServers: [],
        },
        120_000,
      );
      this.sessionId = saved?.sessionId ?? string(response.sessionId);
      this.restoring = false;
    }
    if (this.params.provider !== "claude-code" && !this.sessionId)
      throw new Error("Agent did not return a session ID");
    await this.save();
    this.ready = true;
    await this.control({ type: "message", text });
  }

  async control(control: SessionControl): Promise<void> {
    if (this.stopped || !this.ready) throw new Error("Session is not ready");
    if (control.type === "respond") {
      this.respond(control);
      return;
    }
    if (control.type === "interrupt") {
      if (this.params.provider === "codex") {
        if (this.turnId)
          await this.rpc.request("turn/interrupt", {
            threadId: this.sessionId,
            turnId: this.turnId,
          });
      } else if (this.params.provider === "claude-code") {
        this.rpc.send({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        });
      } else
        this.rpc.send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: this.sessionId },
        });
      return;
    }
    if (!["idle", "starting"].includes(this.snapshot.session.state))
      throw new Error(
        "Wait for the current turn or interrupt it before sending another message",
      );
    this.snapshot.session = { state: "working", requests: [] };
    this.acpMessage = "";
    this.upsert({
      id: randomUUID(),
      type: "message",
      role: "user",
      text: control.text,
    });
    if (this.params.provider === "codex") {
      const result = await this.rpc
        .request("turn/start", {
          threadId: this.sessionId,
          input: [{ type: "text", text: control.text }],
        })
        .catch((error) => {
          this.fail(
            "The agent did not acknowledge the new turn. Resume the conversation to continue.",
          );
          throw error;
        });
      if (this.snapshot.session.state === "working")
        this.turnId = string(object(result.turn).id);
    } else if (this.params.provider === "claude-code") {
      this.rpc.send({
        type: "user",
        session_id: this.sessionId,
        message: { role: "user", content: control.text },
        parent_tool_use_id: null,
      });
    } else {
      // ACP prompt stays pending for the entire turn; control requests must remain responsive.
      void this.rpc
        .request(
          "session/prompt",
          {
            sessionId: this.sessionId,
            prompt: [{ type: "text", text: control.text }],
          },
          0,
        )
        .then((result) =>
          this.complete(string(result.stopReason) === "cancelled"),
        )
        .catch(() => this.fail("The agent could not complete this turn."));
    }
  }

  close(): void {
    this.stopped = true;
    this.rpc.close();
  }

  async shutdown(): Promise<void> {
    this.close();
    if (this.ready) await this.save();
  }

  private get historyPath(): string {
    return `${this.params.runtimeDir}/${this.params.provider}-web-session.json`;
  }

  private save(): Promise<void> {
    const path = this.historyPath;
    const content = JSON.stringify({
      sessionId: this.sessionId,
      entries: this.snapshot.entries,
    });
    this.saveWork = this.saveWork.then(async () => {
      await writeFile(`${path}.tmp`, content, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return this.saveWork;
  }

  private changed(): void {
    this.params.onChange();
  }

  private upsert(entry: SessionEntry): void {
    const existing = this.snapshot.entries.findIndex(
      (value) => value.id === entry.id,
    );
    if (existing < 0) this.snapshot.entries.push(entry);
    else this.snapshot.entries[existing] = entry;
    this.changed();
  }

  private delta(id: string, text: string): void {
    const entry = this.snapshot.entries.find((entry) => entry.id === id);
    this.upsert({
      id,
      type: "message",
      role: "assistant",
      text: (entry?.type === "message" ? entry.text : "") + text,
    });
  }

  private complete(_cancelled = false): void {
    this.turnId = "";
    this.requests.clear();
    this.snapshot.session = { state: "idle", requests: [] };
    this.changed();
    void this.save()
      .then(() => {
        if (this.initialTurn) {
          this.initialTurn = false;
          this.params.onDone(false);
        }
      })
      .catch(() => this.fail("Could not save the agent conversation."));
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.snapshot.session = { state: "failed", requests: [], error: message };
    this.changed();
    this.params.onDone(true);
  }

  private onMessage(message: RpcMessage): void {
    if (this.stopped) return;
    if (this.params.provider === "codex") this.codexMessage(message);
    else if (this.params.provider === "claude-code")
      this.claudeMessage(message);
    else this.acpMessageReceived(message);
  }

  private codexMessage(message: RpcMessage): void {
    const params = message.params ?? {};
    if (message.id !== undefined && message.method) {
      this.requestInput(message);
      return;
    }
    if (params.threadId && params.threadId !== this.sessionId) return;
    if (message.method === "turn/started")
      this.turnId = string(object(params.turn).id);
    else if (message.method === "item/agentMessage/delta")
      this.delta(string(params.itemId), string(params.delta));
    else if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = object(params.item);
      const id = string(item.id);
      const type = string(item.type);
      if (type === "agentMessage")
        this.upsert({
          id,
          type: "message",
          role: "assistant",
          text: string(item.text),
        });
      else if (
        [
          "commandExecution",
          "mcpToolCall",
          "dynamicToolCall",
          "fileChange",
          "webSearch",
        ].includes(type)
      ) {
        this.upsert({
          id,
          type: "tool_call",
          toolCallId: id,
          name: string(item.tool) || type,
          input:
            typeof item.command === "string"
              ? item.command
              : JSON.stringify(
                  item.arguments ?? item.changes ?? item.action ?? {},
                ),
        });
        if (message.method === "item/completed")
          this.upsert({
            id: `${id}:result`,
            type: "tool_result",
            toolCallId: id,
            text:
              string(item.aggregatedOutput) ||
              JSON.stringify(item.result ?? item.changes ?? item.error ?? {}),
            isError: item.status === "failed",
          });
      }
    } else if (message.method === "turn/completed") {
      const turn = object(params.turn);
      if (turn.status === "failed")
        this.fail("The agent could not complete this turn.");
      else this.complete(turn.status === "interrupted");
    }
  }

  private claudeMessage(message: RpcMessage): void {
    if (message.type === "system" && message.subtype === "init")
      this.sessionId = string(message.session_id);
    else if (message.type === "stream_event") {
      const event = object(message.event);
      if (event.type === "message_start")
        this.messageId = string(object(event.message).id);
      if (event.type === "content_block_delta") {
        const delta = object(event.delta);
        if (delta.type === "text_delta")
          this.delta(`${this.messageId}:${event.index}`, string(delta.text));
      }
    } else if (message.type === "assistant" || message.type === "user") {
      const content = object(message.message);
      const id = string(content.id) || string(message.uuid);
      for (const [index, block] of objects(content.content).entries()) {
        if (block.type === "text" && message.type === "assistant")
          this.upsert({
            id: `${id}:${index}`,
            type: "message",
            role: "assistant",
            text: string(block.text),
          });
        else if (block.type === "tool_use")
          this.upsert({
            id: string(block.id),
            type: "tool_call",
            toolCallId: string(block.id),
            name: string(block.name),
            input: JSON.stringify(block.input),
          });
        else if (block.type === "tool_result")
          this.upsert({
            id: `${block.tool_use_id}:result`,
            type: "tool_result",
            toolCallId: string(block.tool_use_id),
            text: textContent(block.content),
            isError: block.is_error === true,
          });
      }
    } else if (message.type === "result") {
      this.sessionId = string(message.session_id) || this.sessionId;
      if (message.is_error)
        this.fail("The agent could not complete this turn.");
      else this.complete();
    } else if (message.type === "control_request") this.requestInput(message);
  }

  private acpMessageReceived(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.requestInput(message);
      return;
    }
    if (message.method !== "session/update" || this.restoring) return;
    const update = object(message.params?.update);
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk") {
      this.acpMessage ||= randomUUID();
      this.delta(this.acpMessage, textContent(update.content));
    } else if (type === "tool_call" || type === "tool_call_update") {
      this.acpMessage = "";
      const id = string(update.toolCallId);
      const old = this.snapshot.entries.find((entry) => entry.id === id);
      this.upsert({
        id,
        type: "tool_call",
        toolCallId: id,
        name:
          string(update.title) ||
          (old?.type === "tool_call" ? old.name : "Tool"),
        input:
          update.rawInput === undefined
            ? old?.type === "tool_call"
              ? old.input
              : undefined
            : JSON.stringify(update.rawInput),
      });
      if (
        update.content ||
        update.rawOutput !== undefined ||
        update.status === "failed"
      )
        this.upsert({
          id: `${id}:result`,
          type: "tool_result",
          toolCallId: id,
          text:
            textContent(update.content) ||
            (update.rawOutput !== undefined
              ? JSON.stringify(update.rawOutput)
              : update.status === "failed"
                ? "The tool did not complete successfully."
                : ""),
          isError: update.status === "failed",
        });
    }
  }

  private requestInput(message: RpcMessage): void {
    const params = message.params ?? object(message.request);
    const id = randomUUID();
    const kind = message.method ?? string(params.subtype);
    let request: SessionRequest;
    if (kind === "session/request_permission") {
      request = {
        id,
        title: string(object(params.toolCall).title) || "Permission requested",
        description: textContent(object(params.toolCall).content) || undefined,
        options: objects(params.options).map((option) => ({
          id: string(option.optionId),
          label: string(option.name),
        })),
      };
    } else if (kind === "item/tool/requestUserInput") {
      request = {
        id,
        title: "Input requested",
        options: [],
        questions: objects(params.questions).map((question) => ({
          id: string(question.id),
          text: string(question.question),
          options: objects(question.options).map((option) =>
            string(option.label),
          ),
        })),
      };
    } else if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(kind)
    ) {
      request = {
        id,
        title: "Permission requested",
        description: string(params.command) || string(params.reason),
        options: [
          { id: "accept", label: "Allow once" },
          { id: "decline", label: "Deny" },
        ],
      };
    } else if (kind === "can_use_tool") {
      const input = object(params.input);
      request =
        params.tool_name === "AskUserQuestion"
          ? {
              id,
              title: "Input requested",
              options: [],
              questions: objects(input.questions).map((question) => ({
                id: string(question.question),
                text: string(question.question),
                options: objects(question.options).map((option) =>
                  string(option.label),
                ),
              })),
            }
          : {
              id,
              title: `Allow ${string(params.tool_name)}?`,
              description: JSON.stringify(input),
              options: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            };
    } else {
      if (message.id !== undefined)
        this.rpc.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Client method not supported" },
        });
      return;
    }
    this.requests.set(id, { message, kind });
    this.snapshot.session.requests.push(request);
    this.snapshot.session.state = "input_required";
    this.changed();
  }

  private respond(control: Extract<SessionControl, { type: "respond" }>): void {
    const pending = this.requests.get(control.requestId);
    const request = this.snapshot.session.requests.find(
      (request) => request.id === control.requestId,
    );
    if (!pending || !request)
      throw new Error("This request has already been answered or expired");
    if (
      request.options.length &&
      !request.options.some((option) => option.id === control.optionId)
    )
      throw new Error("Choose an available response");
    if (
      request.questions?.some(
        (question) => !control.answers?.[question.id]?.trim(),
      )
    )
      throw new Error("Answer every question");
    const { message, kind } = pending;
    let result: RpcObject;
    if (kind === "session/request_permission")
      result = { outcome: { outcome: "selected", optionId: control.optionId } };
    else if (kind === "item/tool/requestUserInput")
      result = {
        answers: Object.fromEntries(
          Object.entries(control.answers ?? {}).map(([id, answer]) => [
            id,
            { answers: [answer] },
          ]),
        ),
      };
    else if (kind === "can_use_tool") {
      const native = object(message.request);
      result =
        control.optionId === "deny"
          ? { behavior: "deny", message: "Denied by the user" }
          : {
              behavior: "allow",
              updatedInput: {
                ...object(native.input),
                ...(control.answers ? { answers: control.answers } : {}),
              },
            };
      this.rpc.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: result,
        },
      });
    } else result = { decision: control.optionId };
    if (kind !== "can_use_tool")
      this.rpc.send({ jsonrpc: "2.0", id: message.id, result });
    this.requests.delete(control.requestId);
    this.snapshot.session.requests = this.snapshot.session.requests.filter(
      (request) => request.id !== control.requestId,
    );
    this.snapshot.session.state = this.requests.size
      ? "input_required"
      : "working";
    this.changed();
  }
}

function object(value: unknown): RpcObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RpcObject)
    : {};
}
function objects(value: unknown): RpcObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(textContent).filter(Boolean).join("\n");
  const part = object(value);
  if (part.type === "text") return string(part.text);
  if (part.type === "content") return textContent(part.content);
  if (part.type === "diff")
    return `${string(part.path)}\n${string(part.oldText)}\n${string(part.newText)}`;
  return "";
}
