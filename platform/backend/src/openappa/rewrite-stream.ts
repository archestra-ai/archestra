class RewriteStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewriteStreamError";
  }
}

type RewriteStreamFamily =
  | "anthropic:messages"
  | "openai:chatCompletions"
  | "openai:responses";

const RETENTION_LIMIT = 16 * 1024 * 1024;

export class RewriteStreamCapture {
  static readonly retentionLimit = RETENTION_LIMIT;

  private readonly original: Assembler;
  private readonly client: Assembler;
  private clientRemainder = "";
  private retained = 0;

  constructor(family: RewriteStreamFamily) {
    if (
      family !== "anthropic:messages" &&
      family !== "openai:chatCompletions" &&
      family !== "openai:responses"
    ) {
      throw new RewriteStreamError("Unsupported rewrite stream family");
    }
    const retain = (bytes: number) => this.retain(bytes);
    this.original = createAssembler(family, retain);
    this.client = createAssembler(family, retain);
  }

  observeProviderChunk(chunk: unknown): void {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      this.ingestFrames(this.original, decode(chunk));
      return;
    }
    this.original.ingest(chunk);
  }

  observeClientEvent(data: string | Uint8Array): void {
    this.ingestFrames(this.client, decode(data));
  }

  originalResponse(): unknown {
    return this.original.snapshot();
  }

  clientResponse(): unknown {
    return this.client.snapshot();
  }

  private ingestFrames(assembler: Assembler, text: string): void {
    const source =
      assembler === this.client ? this.clientRemainder + text : text;
    if (Buffer.byteLength(source, "utf8") > RETENTION_LIMIT) {
      throw new RewriteStreamError("Rewrite stream retention limit exceeded");
    }
    const frames = splitFrames(source);
    if (assembler === this.client) this.clientRemainder = frames.rest;
    for (const frame of frames.events) {
      const event = parseSseFrame(frame);
      if (event === undefined) continue;
      assembler.ingest(event);
    }
  }

  private retain(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RewriteStreamError("Rewrite stream retention limit exceeded");
    }
    if (this.retained + bytes > RETENTION_LIMIT) {
      throw new RewriteStreamError("Rewrite stream retention limit exceeded");
    }
    this.retained += bytes;
  }
}

type JsonRecord = Record<string, unknown>;
type Retain = (bytes: number) => void;

interface Assembler {
  ingest(event: unknown): void;
  snapshot(): unknown;
}

function createAssembler(
  family: RewriteStreamFamily,
  retain: Retain,
): Assembler {
  if (family === "anthropic:messages") return new AnthropicAssembler(retain);
  if (family === "openai:chatCompletions") return new ChatAssembler(retain);
  return new ResponsesAssembler(retain);
}

class AnthropicAssembler implements Assembler {
  private readonly blocks = new Map<number, JsonRecord>();
  private readonly partialJson = new Map<number, string>();
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {}

  ingest(event: unknown): void {
    const record = asRecord(event);
    if (!record) return;
    const type = record.type;
    if (type === "content_block_start") {
      this.startBlock(record);
      return;
    }
    if (type === "content_block_delta") {
      this.delta(record);
      return;
    }
    if (type === "message_start") {
      // Native clients retain the initial Message, including its content. Calls
      // here have no block lifecycle to reconstruct or pass through the gate.
      rejectUnknownCall(record.message);
      this.noteId(asRecord(record.message)?.id);
      return;
    }
    if (
      type === "content_block_stop" ||
      type === "message_delta" ||
      type === "message_stop" ||
      type === "ping"
    ) {
      return;
    }
    rejectUnknownCall(record);
  }

  snapshot(): unknown {
    const content = [...this.blocks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, block]) => this.finish(index, block));
    return withResponseId(this.responseId, { content });
  }

  private noteId(id: unknown): void {
    this.responseId = rememberResponseId(this.responseId, id, this.retain);
  }

  private startBlock(event: JsonRecord): void {
    const index = event.index;
    const block = asRecord(event.content_block);
    if (typeof index !== "number" || !block) {
      if (containsExecutableCall(event)) failClosed();
      return;
    }
    const copy = cloneRecord(block);
    this.retain(jsonBytes(copy));
    this.blocks.set(index, copy);
    if (copy.type === "tool_use") this.partialJson.set(index, "");
  }

  private delta(event: JsonRecord): void {
    const index = event.index;
    const delta = asRecord(event.delta);
    if (typeof index !== "number" || !delta) {
      if (containsExecutableCall(event)) failClosed();
      return;
    }
    const block = this.blocks.get(index);
    if (!block) {
      if (delta.type === "input_json_delta") failClosed();
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        this.blocks.set(index, { type: "text", text: "" });
      } else if (delta.type === "thinking_delta") {
        this.blocks.set(index, { type: "thinking", thinking: "" });
      } else {
        return;
      }
    }
    const target = this.blocks.get(index);
    if (!target || !delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.retain(Buffer.byteLength(delta.text, "utf8"));
      target.text = `${textOf(target.text)}${delta.text}`;
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      this.retain(Buffer.byteLength(delta.thinking, "utf8"));
      target.thinking = `${textOf(target.thinking)}${delta.thinking}`;
      return;
    }
    if (
      delta.type === "signature_delta" &&
      typeof delta.signature === "string"
    ) {
      this.retain(Buffer.byteLength(delta.signature, "utf8"));
      target.signature = `${textOf(target.signature)}${delta.signature}`;
      return;
    }
    if (delta.type === "input_json_delta") {
      if (target.type !== "tool_use") return;
      if (typeof delta.partial_json !== "string") failClosed();
      this.retain(Buffer.byteLength(delta.partial_json, "utf8"));
      this.partialJson.set(
        index,
        `${this.partialJson.get(index) ?? ""}${delta.partial_json}`,
      );
    }
  }

  private finish(index: number, block: JsonRecord): JsonRecord {
    if (block.type !== "tool_use") return block;
    if (typeof block.id !== "string" || block.id.length === 0) failClosed();
    const partial = this.partialJson.get(index) ?? "";
    if (partial.length === 0) {
      if (!asRecord(block.input)) failClosed();
      return block;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(partial);
    } catch {
      throw new RewriteStreamError("Invalid Anthropic tool input");
    }
    if (!asRecord(parsed)) {
      throw new RewriteStreamError("Invalid Anthropic tool input");
    }
    return { ...block, input: parsed };
  }
}

class ChatAssembler implements Assembler {
  private readonly choices = new Map<number, ChatChoice>();
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {}

  ingest(event: unknown): void {
    if (event === "[DONE]") return;
    const record = asRecord(event);
    if (!record) return;
    this.responseId = rememberResponseId(
      this.responseId,
      record.id,
      this.retain,
    );
    if (!Array.isArray(record.choices) || record.choices.length === 0) {
      rejectUnknownCall(record);
      return;
    }
    for (const choice of record.choices) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) continue;
      const index =
        typeof choiceRecord.index === "number" ? choiceRecord.index : 0;
      const delta = asRecord(choiceRecord.delta);
      if (!delta) continue;
      const current = this.choice(index);
      if (typeof delta.role === "string" && delta.role.length > 0) {
        current.role = delta.role;
      }
      if (typeof delta.content === "string") {
        this.retain(Buffer.byteLength(delta.content, "utf8"));
        current.content = `${current.content ?? ""}${delta.content}`;
      }
      this.absorbReasoning(current, delta);
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) this.mergeCall(current, call);
      }
    }
  }

  snapshot(): unknown {
    const choices = [...this.choices.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, choice]) => ({
        message: {
          role: choice.role,
          content: choice.content,
          ...(choice.reasoningContent === undefined
            ? {}
            : { reasoning_content: choice.reasoningContent }),
          ...(choice.toolCalls.size === 0
            ? {}
            : {
                tool_calls: [...choice.toolCalls.entries()]
                  .sort((left, right) => left[0] - right[0])
                  .map(([, call]) => {
                    if (typeof call.id !== "string" || call.id.length === 0) {
                      failClosed();
                    }
                    return call;
                  }),
              }),
        },
      }));
    return withResponseId(this.responseId, { choices });
  }

  private choice(index: number): ChatChoice {
    const existing = this.choices.get(index);
    if (existing) return existing;
    const created = {
      role: "assistant",
      content: null as string | null,
      toolCalls: new Map<number, JsonRecord>(),
    };
    this.choices.set(index, created);
    return created;
  }

  private absorbReasoning(choice: ChatChoice, delta: JsonRecord): void {
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning !== "string" || reasoning.length === 0) return;
    this.retain(Buffer.byteLength(reasoning, "utf8"));
    choice.reasoningContent = `${choice.reasoningContent ?? ""}${reasoning}`;
  }

  private mergeCall(choice: ChatChoice, value: unknown): void {
    const delta = asRecord(value);
    if (!delta || typeof delta.index !== "number") {
      if (containsExecutableCall(value)) failClosed();
      return;
    }
    const call = choice.toolCalls.get(delta.index) ?? {};
    if (!choice.toolCalls.has(delta.index)) {
      choice.toolCalls.set(delta.index, call);
    }
    for (const [key, field] of Object.entries(delta)) {
      if (key === "index" || key === "function") continue;
      if (typeof field === "string") {
        if (field.length === 0) continue;
        this.retain(Buffer.byteLength(field, "utf8"));
        if (key === "id" && typeof call.id === "string" && call.id.length > 0) {
          continue;
        }
      } else {
        this.retain(jsonBytes(field));
      }
      call[key] = cloneValue(field);
    }
    const fn = asRecord(delta.function);
    if (!fn) return;
    const target = asRecord(call.function) ?? {};
    call.function = target;
    if (typeof fn.name === "string" && fn.name.length > 0) {
      this.retain(Buffer.byteLength(fn.name, "utf8"));
      target.name = `${textOf(target.name)}${fn.name}`;
    }
    if (typeof fn.arguments === "string") {
      this.retain(Buffer.byteLength(fn.arguments, "utf8"));
      target.arguments = `${textOf(target.arguments)}${fn.arguments}`;
    }
    for (const [key, field] of Object.entries(fn)) {
      if (key === "name" || key === "arguments") continue;
      this.retain(jsonBytes(field));
      target[key] = cloneValue(field);
    }
  }
}

type ChatChoice = {
  role: string;
  content: string | null;
  reasoningContent?: string;
  toolCalls: Map<number, JsonRecord>;
};

class ResponsesAssembler implements Assembler {
  private readonly items = new Map<number, JsonRecord>();
  private readonly indexByItemId = new Map<string, number>();
  private completed: JsonRecord[] | undefined;
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {}

  ingest(event: unknown): void {
    const record = asRecord(event);
    if (!record || typeof record.type !== "string") {
      rejectUnknownCall(event);
      return;
    }
    this.responseId = rememberResponseId(
      this.responseId,
      asRecord(record.response)?.id,
      this.retain,
    );
    if (
      record.type === "response.output_item.added" ||
      record.type === "response.output_item.done"
    ) {
      this.itemEvent(record);
      return;
    }
    if (
      record.type === "response.function_call_arguments.delta" ||
      record.type === "response.function_call_arguments.done" ||
      record.type === "response.custom_tool_call_input.delta" ||
      record.type === "response.custom_tool_call_input.done"
    ) {
      this.argumentEvent(record);
      return;
    }
    if (
      record.type === "response.output_text.delta" ||
      record.type === "response.output_text.done"
    ) {
      this.textEvent(record);
      return;
    }
    if (record.type === "response.completed") {
      this.complete(record);
      return;
    }
    if (
      record.type === "response.created" ||
      record.type === "response.in_progress" ||
      record.type === "response.failed" ||
      record.type === "response.incomplete" ||
      record.type === "response.output_text.annotation.added" ||
      record.type === "error"
    ) {
      rejectUnknownCall(record);
      return;
    }
    rejectUnknownCall(record);
  }

  snapshot(): unknown {
    const output =
      this.completed ??
      [...this.items.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, item]) => item);
    for (const item of output) {
      const record = asRecord(item);
      if (!record) continue;
      if (
        (record.type === "function_call" ||
          record.type === "custom_tool_call") &&
        (typeof record.call_id !== "string" || record.call_id.length === 0)
      ) {
        failClosed();
      }
    }
    return withResponseId(this.responseId, { output });
  }

  private itemEvent(event: JsonRecord): void {
    const item = asRecord(event.item);
    const index = event.output_index;
    if (!item || typeof index !== "number") {
      if (containsExecutableCall(event)) failClosed();
      return;
    }
    const copy = cloneRecord(item);
    this.retain(jsonBytes(copy));
    if (event.type === "response.output_item.done") {
      const previous = this.items.get(index);
      if (previous && copy.arguments === undefined && previous.arguments) {
        copy.arguments = previous.arguments;
      }
      if (previous && copy.input === undefined && previous.input) {
        copy.input = previous.input;
      }
    } else if (this.items.has(index)) {
      const previous = this.items.get(index);
      if (previous?.arguments && !copy.arguments) {
        copy.arguments = previous.arguments;
      }
    }
    this.items.set(index, copy);
    const itemId = copy.id ?? copy.call_id;
    if (typeof itemId === "string") this.indexByItemId.set(itemId, index);
  }

  private argumentEvent(event: JsonRecord): void {
    const item = this.itemFor(event);
    if (!item) failClosed();
    if (event.type === "response.function_call_arguments.delta") {
      if (typeof event.delta !== "string") failClosed();
      this.retain(Buffer.byteLength(event.delta, "utf8"));
      item.arguments = `${textOf(item.arguments)}${event.delta}`;
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      if (typeof event.arguments !== "string") failClosed();
      this.retain(Buffer.byteLength(event.arguments, "utf8"));
      item.arguments = event.arguments;
      if (typeof event.name === "string" && !item.name) item.name = event.name;
      return;
    }
    if (event.type === "response.custom_tool_call_input.delta") {
      if (typeof event.delta !== "string") failClosed();
      this.retain(Buffer.byteLength(event.delta, "utf8"));
      item.input = `${textOf(item.input)}${event.delta}`;
      return;
    }
    if (typeof event.input !== "string") failClosed();
    this.retain(Buffer.byteLength(event.input, "utf8"));
    item.input = event.input;
  }

  private textEvent(event: JsonRecord): void {
    const index = event.output_index;
    const contentIndex =
      typeof event.content_index === "number" ? event.content_index : 0;
    if (typeof index !== "number") return;
    const item = this.items.get(index) ?? {
      type: "message",
      role: "assistant",
      content: [],
    };
    this.items.set(index, item);
    if (typeof item.id !== "string" && typeof event.item_id === "string") {
      item.id = event.item_id;
      this.indexByItemId.set(event.item_id, index);
    }
    const content = Array.isArray(item.content) ? item.content : [];
    item.content = content;
    const part = asRecord(content[contentIndex]) ?? {
      type: "output_text",
      text: "",
    };
    content[contentIndex] = part;
    if (event.type === "response.output_text.done") {
      if (typeof event.text !== "string") return;
      this.retain(Buffer.byteLength(event.text, "utf8"));
      part.text = event.text;
      return;
    }
    if (typeof event.delta !== "string") return;
    this.retain(Buffer.byteLength(event.delta, "utf8"));
    part.text = `${textOf(part.text)}${event.delta}`;
  }

  private complete(event: JsonRecord): void {
    const response = asRecord(event.response);
    const output = response?.output;
    if (!Array.isArray(output) || output.length === 0) return;
    const copy = output.map((item) => {
      const record = asRecord(item);
      if (!record) return item;
      const cloned = cloneRecord(record);
      this.retain(jsonBytes(cloned));
      return cloned;
    });
    this.completed = copy as JsonRecord[];
  }

  private itemFor(event: JsonRecord): JsonRecord | undefined {
    if (typeof event.output_index === "number") {
      const existing = this.items.get(event.output_index);
      if (existing) return existing;
    }
    if (typeof event.item_id === "string") {
      const index = this.indexByItemId.get(event.item_id);
      if (index !== undefined) return this.items.get(index);
    }
    if (typeof event.output_index !== "number") return undefined;
    const created: JsonRecord = {
      type:
        typeof event.type === "string" &&
        event.type.includes("custom_tool_call")
          ? "custom_tool_call"
          : "function_call",
      id: typeof event.item_id === "string" ? event.item_id : undefined,
    };
    this.items.set(event.output_index, created);
    if (typeof event.item_id === "string") {
      this.indexByItemId.set(event.item_id, event.output_index);
    }
    return created;
  }
}

function parseSseFrame(frame: string): unknown {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
    if (
      line.startsWith("event:") ||
      line.startsWith("id:") ||
      line.startsWith("retry:")
    ) {
    }
  }
  if (data.length === 0) return undefined;
  const payload = data.join("\n");
  if (payload === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(payload);
  } catch {
    if (looksLikeCallFrame(payload)) failClosed();
    return undefined;
  }
}

function splitFrames(text: string): { events: string[]; rest: string } {
  const parts = text.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  return { events: parts.filter((part) => part.length > 0), rest };
}

function rejectUnknownCall(value: unknown): void {
  if (containsExecutableCall(value)) failClosed();
}

function containsExecutableCall(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsExecutableCall(item, depth + 1));
  }
  const record = value as JsonRecord;
  if (
    record.type === "tool_use" ||
    record.type === "function_call" ||
    record.type === "custom_tool_call"
  ) {
    return true;
  }
  if (Array.isArray(record.tool_calls) && record.tool_calls.some(isToolCall)) {
    return true;
  }
  return Object.values(record).some((child) =>
    containsExecutableCall(child, depth + 1),
  );
}

function isToolCall(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.id === "string" ||
    asRecord(record.function)?.name !== undefined
  );
}

function looksLikeCallFrame(payload: string): boolean {
  return (
    payload.includes('"tool_use"') ||
    payload.includes('"function_call"') ||
    payload.includes('"custom_tool_call"') ||
    payload.includes('"tool_calls"')
  );
}

function failClosed(): never {
  throw new RewriteStreamError("Unreconstructed executable call");
}

function rememberResponseId(
  current: string | undefined,
  id: unknown,
  retain: Retain,
): string | undefined {
  if (current || typeof id !== "string" || id.length === 0) return current;
  retain(Buffer.byteLength(id, "utf8"));
  return id;
}

function withResponseId(id: string | undefined, body: JsonRecord): JsonRecord {
  return id ? { id, ...body } : body;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return cloneValue(value) as JsonRecord;
}

function cloneValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    throw new RewriteStreamError("Unreconstructed executable call");
  }
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    throw new RewriteStreamError("Rewrite stream retention limit exceeded");
  }
}

function decode(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}
