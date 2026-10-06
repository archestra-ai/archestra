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
  private readonly providerFrames = createFrameState();
  private readonly clientFrames = createFrameState();
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
      this.ingestFrames(this.original, chunk);
      return;
    }
    this.original.ingest(chunk);
  }

  observeClientEvent(data: string | Uint8Array): void {
    this.ingestFrames(this.client, data);
  }

  originalResponse(): unknown {
    rejectTruncatedFrames(this.providerFrames);
    return this.original.snapshot();
  }

  clientResponse(): unknown {
    rejectTruncatedFrames(this.clientFrames);
    return this.client.snapshot();
  }

  private ingestFrames(assembler: Assembler, data: string | Uint8Array): void {
    const frames =
      assembler === this.client ? this.clientFrames : this.providerFrames;
    const text = this.decode(frames, data);
    if (text.length === 0) return;
    // Scan only the new text and the suffix that can straddle an SSE delimiter.
    const source = frames.tail + text;
    const sourceBytes =
      frames.bytes +
      Buffer.byteLength(text, "utf8") -
      (joinsSurrogates(frames.tail.charCodeAt(frames.tail.length - 1), text)
        ? 2
        : 0);
    if (sourceBytes > RETENTION_LIMIT) {
      throw new RewriteStreamError("Rewrite stream retention limit exceeded");
    }
    const delimiter = /\r?\n\r?\n/g;
    let start = 0;
    let match = delimiter.exec(source);
    if (!match) {
      this.retain(sourceBytes - frames.bytes);
      const prefix = source.slice(0, Math.max(0, source.length - 3));
      if (prefix.length > 0) frames.fragments.push(prefix);
      frames.tail = source.slice(-3);
      frames.bytes = sourceBytes;
      return;
    }
    this.retain(-frames.bytes);
    frames.bytes = 0;
    const prefix = frames.fragments.join("");
    frames.fragments = [];
    frames.tail = "";
    while (match) {
      const frame =
        (start === 0 ? prefix : "") + source.slice(start, match.index);
      // SSE permits one initial BOM; keep all subsequent Unicode unchanged.
      const event = parseSseFrame(
        frames.firstFrame && frame.startsWith("\ufeff")
          ? frame.slice(1)
          : frame,
      );
      frames.firstFrame = false;
      start = delimiter.lastIndex;
      if (event !== undefined) assembler.ingest(event);
      match = delimiter.exec(source);
    }
    const rest = source.slice(start);
    const bytes = Buffer.byteLength(rest, "utf8");
    this.retain(bytes);
    if (rest.length > 3) frames.fragments.push(rest.slice(0, -3));
    frames.tail = rest.slice(-3);
    frames.bytes = bytes;
  }

  private decode(frames: FrameState, data: string | Uint8Array): string {
    if (frames.failure) throw frames.failure;
    if (typeof data === "string") {
      // Strings are already decoded: never encode/repair their surrogate halves
      // or splice them into an unfinished byte sequence.
      if (data.length > 0 && frames.pendingBytes > 0) {
        frames.failure = new RewriteStreamError("Invalid rewrite stream UTF-8");
        throw frames.failure;
      }
      return data;
    }
    let text: string;
    try {
      text = frames.decoder.decode(data, { stream: true });
    } catch {
      frames.failure = new RewriteStreamError("Invalid rewrite stream UTF-8");
      throw frames.failure;
    }
    // With fatal decoding and BOM preservation, emitted UTF-8 bytes plus the
    // decoder's (at most three) pending bytes exactly equal the input bytes.
    const pendingBytes =
      frames.pendingBytes + data.byteLength - Buffer.byteLength(text, "utf8");
    try {
      this.retain(pendingBytes - frames.pendingBytes);
    } catch (error) {
      // The decoder cannot be rewound if its new pending bytes exceed the cap.
      frames.failure = new RewriteStreamError(
        "Rewrite stream retention limit exceeded",
      );
      throw error;
    }
    frames.pendingBytes = pendingBytes;
    return text;
  }

  private retain(bytes: number): void {
    // Replacements adjust retained JSON bytes; appends charge only the new suffix.
    if (!Number.isSafeInteger(bytes) || this.retained + bytes < 0) {
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
type FieldTails = WeakMap<object, Map<string, number>>;

type FrameState = {
  decoder: TextDecoder;
  pendingBytes: number;
  failure: RewriteStreamError | undefined;
  fragments: string[];
  tail: string;
  bytes: number;
  firstFrame: boolean;
};

function createFrameState(): FrameState {
  return {
    decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    pendingBytes: 0,
    failure: undefined,
    fragments: [],
    tail: "",
    bytes: 0,
    firstFrame: true,
  };
}

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
  private readonly partialJsonTails = new Map<number, number>();
  private readonly fieldTails: FieldTails = new WeakMap();
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {
    retain(jsonBytes({ content: [] }));
  }

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
    const previous = this.blocks.get(index);
    const partial = this.partialJson.get(index);
    this.retain(
      jsonBytes(copy) -
        (previous ? jsonBytes(previous) : 0) +
        (previous ? 0 : jsonBytes(index) + 1) +
        (copy.type === "tool_use" ? jsonBytes([index, ""]) : 0) -
        (partial === undefined ? 0 : jsonBytes([index, partial])),
    );
    rememberFieldTails(copy, this.fieldTails);
    this.blocks.set(index, copy);
    this.partialJson.delete(index);
    this.partialJsonTails.delete(index);
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
        this.startBlock({ index, content_block: { type: "text", text: "" } });
      } else if (delta.type === "thinking_delta") {
        this.startBlock({
          index,
          content_block: { type: "thinking", thinking: "" },
        });
      } else {
        return;
      }
    }
    const target = this.blocks.get(index);
    if (!target || !delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      appendRetainedField({
        target,
        key: "text",
        delta: delta.text,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      appendRetainedField({
        target,
        key: "thinking",
        delta: delta.thinking,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (
      delta.type === "signature_delta" &&
      typeof delta.signature === "string"
    ) {
      appendRetainedField({
        target,
        key: "signature",
        delta: delta.signature,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (delta.type === "input_json_delta") {
      if (target.type !== "tool_use") return;
      if (typeof delta.partial_json !== "string") failClosed();
      this.retain(
        appendedBytes(this.partialJsonTails.get(index), delta.partial_json),
      );
      this.partialJson.set(
        index,
        `${this.partialJson.get(index) ?? ""}${delta.partial_json}`,
      );
      if (delta.partial_json.length > 0) {
        this.partialJsonTails.set(
          index,
          delta.partial_json.charCodeAt(delta.partial_json.length - 1),
        );
      }
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
  private readonly fieldTails: FieldTails = new WeakMap();
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {
    retain(jsonBytes({ choices: [] }));
  }

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
        setRetainedField({
          target: current,
          key: "role",
          value: delta.role,
          retain: this.retain,
          tails: this.fieldTails,
        });
      }
      if (typeof delta.content === "string") {
        appendRetainedField({
          target: current,
          key: "content",
          delta: delta.content,
          retain: this.retain,
          tails: this.fieldTails,
        });
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
    this.retain(jsonBytes(created) + jsonBytes(index) + 1);
    this.choices.set(index, created);
    return created;
  }

  private absorbReasoning(choice: ChatChoice, delta: JsonRecord): void {
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning !== "string" || reasoning.length === 0) return;
    appendRetainedField({
      target: choice,
      key: "reasoningContent",
      delta: reasoning,
      retain: this.retain,
      tails: this.fieldTails,
    });
  }

  private mergeCall(choice: ChatChoice, value: unknown): void {
    const delta = asRecord(value);
    if (!delta || typeof delta.index !== "number") {
      if (containsExecutableCall(value)) failClosed();
      return;
    }
    const call = choice.toolCalls.get(delta.index) ?? {};
    if (!choice.toolCalls.has(delta.index)) {
      this.retain(jsonBytes(call) + jsonBytes(delta.index) + 1);
      choice.toolCalls.set(delta.index, call);
    }
    for (const [key, field] of Object.entries(delta)) {
      if (key === "index" || key === "function") continue;
      if (typeof field === "string") {
        if (field.length === 0) continue;
        if (key === "id" && typeof call.id === "string" && call.id.length > 0) {
          continue;
        }
      }
      setRetainedField({
        target: call,
        key,
        value: cloneValue(field),
        retain: this.retain,
        tails: this.fieldTails,
      });
    }
    const fn = asRecord(delta.function);
    if (!fn) return;
    const target = asRecord(call.function) ?? {};
    if (target !== call.function) {
      setRetainedField({
        target: call,
        key: "function",
        value: target,
        retain: this.retain,
        tails: this.fieldTails,
      });
    }
    if (typeof fn.name === "string" && fn.name.length > 0) {
      appendRetainedField({
        target,
        key: "name",
        delta: fn.name,
        retain: this.retain,
        tails: this.fieldTails,
      });
    }
    if (typeof fn.arguments === "string") {
      appendRetainedField({
        target,
        key: "arguments",
        delta: fn.arguments,
        retain: this.retain,
        tails: this.fieldTails,
      });
    }
    for (const [key, field] of Object.entries(fn)) {
      if (key === "name" || key === "arguments") continue;
      setRetainedField({
        target,
        key,
        value: cloneValue(field),
        retain: this.retain,
        tails: this.fieldTails,
      });
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
  private fieldTails: FieldTails = new WeakMap();
  private completed: JsonRecord[] | undefined;
  private responseId: string | undefined;

  constructor(private readonly retain: Retain) {
    retain(jsonBytes({ output: [] }));
  }

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
    const previous = this.items.get(index);
    if (event.type === "response.output_item.done") {
      if (previous && copy.arguments === undefined && previous.arguments) {
        copy.arguments = previous.arguments;
      }
      if (previous && copy.input === undefined && previous.input) {
        copy.input = previous.input;
      }
    } else if (this.items.has(index)) {
      if (previous?.arguments && !copy.arguments) {
        copy.arguments = previous.arguments;
      }
    }
    this.retain(
      jsonBytes(copy) -
        (previous ? jsonBytes(previous) : 0) +
        (previous ? 0 : jsonBytes(index) + 1),
    );
    rememberFieldTails(copy, this.fieldTails);
    if (Array.isArray(copy.content)) {
      for (const part of copy.content) {
        const record = asRecord(part);
        if (record) rememberFieldTails(record, this.fieldTails);
      }
    }
    this.items.set(index, copy);
    const previousId = previous?.id ?? previous?.call_id;
    const itemId = copy.id ?? copy.call_id;
    if (
      previousId !== itemId &&
      typeof previousId === "string" &&
      this.indexByItemId.get(previousId) === index
    ) {
      this.retain(-jsonBytes([previousId, index]));
      this.indexByItemId.delete(previousId);
    }
    this.noteItemId(itemId, index);
  }

  private argumentEvent(event: JsonRecord): void {
    const item = this.itemFor(event);
    if (!item) failClosed();
    if (event.type === "response.function_call_arguments.delta") {
      if (typeof event.delta !== "string") failClosed();
      appendRetainedField({
        target: item,
        key: "arguments",
        delta: event.delta,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      if (typeof event.arguments !== "string") failClosed();
      setRetainedField({
        target: item,
        key: "arguments",
        value: event.arguments,
        retain: this.retain,
        tails: this.fieldTails,
      });
      if (typeof event.name === "string" && !item.name) {
        setRetainedField({
          target: item,
          key: "name",
          value: event.name,
          retain: this.retain,
          tails: this.fieldTails,
        });
      }
      return;
    }
    if (event.type === "response.custom_tool_call_input.delta") {
      if (typeof event.delta !== "string") failClosed();
      appendRetainedField({
        target: item,
        key: "input",
        delta: event.delta,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (typeof event.input !== "string") failClosed();
    setRetainedField({
      target: item,
      key: "input",
      value: event.input,
      retain: this.retain,
      tails: this.fieldTails,
    });
  }

  private textEvent(event: JsonRecord): void {
    const index = event.output_index;
    const contentIndex =
      typeof event.content_index === "number" ? event.content_index : 0;
    if (typeof index !== "number") return;
    const existing = this.items.get(index);
    const item = existing ?? {
      type: "message",
      role: "assistant",
      content: [],
    };
    if (!existing) this.retain(jsonBytes(item) + jsonBytes(index) + 1);
    this.items.set(index, item);
    if (typeof item.id !== "string" && typeof event.item_id === "string") {
      setRetainedField({
        target: item,
        key: "id",
        value: event.item_id,
        retain: this.retain,
        tails: this.fieldTails,
      });
      this.noteItemId(event.item_id, index);
    }
    const content = Array.isArray(item.content) ? item.content : [];
    if (content !== item.content) {
      setRetainedField({
        target: item,
        key: "content",
        value: content,
        retain: this.retain,
        tails: this.fieldTails,
      });
    }
    const existingPart = asRecord(content[contentIndex]);
    const part = existingPart ?? {
      type: "output_text",
      text: "",
    };
    if (!existingPart) {
      setRetainedPart({
        content,
        index: contentIndex,
        part,
        retain: this.retain,
      });
    }
    if (event.type === "response.output_text.done") {
      if (typeof event.text !== "string") return;
      setRetainedField({
        target: part,
        key: "text",
        value: event.text,
        retain: this.retain,
        tails: this.fieldTails,
      });
      return;
    }
    if (typeof event.delta !== "string") return;
    appendRetainedField({
      target: part,
      key: "text",
      delta: event.delta,
      retain: this.retain,
      tails: this.fieldTails,
    });
  }

  private complete(event: JsonRecord): void {
    const response = asRecord(event.response);
    const output = response?.output;
    if (!Array.isArray(output) || output.length === 0) return;
    const copy = cloneValue(output) as JsonRecord[];
    let released = this.completed ? jsonBytes(this.completed) - 2 : 0;
    for (const [index, item] of this.items) {
      released += jsonBytes(item) + jsonBytes(index) + 1;
    }
    for (const entry of this.indexByItemId) released += jsonBytes(entry);
    this.retain(jsonBytes(copy) - 2 - released);
    this.completed = copy;
    // The terminal snapshot supersedes the accumulated items, including metadata.
    this.items.clear();
    this.indexByItemId.clear();
    this.fieldTails = new WeakMap();
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
    this.retain(jsonBytes(created) + jsonBytes(event.output_index) + 1);
    this.items.set(event.output_index, created);
    if (typeof event.item_id === "string") {
      this.noteItemId(event.item_id, event.output_index);
    }
    return created;
  }

  private noteItemId(id: unknown, index: number): void {
    if (typeof id !== "string") return;
    const previous = this.indexByItemId.get(id);
    this.retain(
      jsonBytes([id, index]) -
        (previous === undefined ? 0 : jsonBytes([id, previous])),
    );
    this.indexByItemId.set(id, index);
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

function rejectTruncatedFrames(frames: FrameState): void {
  if (frames.failure) throw frames.failure;
  if (frames.pendingBytes > 0) {
    throw new RewriteStreamError("Truncated rewrite stream UTF-8");
  }
  if (
    frames.tail.trim().length > 0 ||
    frames.fragments.some((fragment) => fragment.trim().length > 0)
  ) {
    throw new RewriteStreamError("Truncated rewrite stream frame");
  }
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
  retain(jsonBytes(id) + jsonBytes("id") + 2);
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

function setRetainedField(params: {
  target: object;
  key: string;
  value: unknown;
  retain: Retain;
  tails: FieldTails;
}): void {
  const { target, key, value, retain, tails } = params;
  const record = target as JsonRecord;
  const previous = record[key];
  const keyBytes = jsonBytes(key) + 1;
  const present = previous !== undefined;
  const nextPresent = value !== undefined;
  const hasOtherFields = Object.keys(record).some(
    (field) => field !== key && record[field] !== undefined,
  );
  const overhead = keyBytes + (hasOtherFields ? 1 : 0);
  retain(
    (nextPresent ? jsonBytes(value) + overhead : 0) -
      (present ? jsonBytes(previous) + overhead : 0),
  );
  record[key] = value;
  rememberFieldTail({ target, key, value, tails });
}

function appendRetainedField(params: {
  target: object;
  key: string;
  delta: string;
  retain: Retain;
  tails: FieldTails;
}): void {
  const { target, key, delta, retain, tails } = params;
  const record = target as JsonRecord;
  if (typeof record[key] !== "string") {
    setRetainedField({ target: record, key, value: "", retain, tails });
  }
  const previous = textOf(record[key]);
  retain(appendedBytes(tails.get(target)?.get(key), delta));
  record[key] = previous + delta;
  if (delta.length > 0) {
    rememberFieldTail({ target, key, value: delta, tails });
  }
}

function rememberFieldTails(target: JsonRecord, tails: FieldTails): void {
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === "string") {
      rememberFieldTail({ target, key, value, tails });
    }
  }
}

function rememberFieldTail(params: {
  target: object;
  key: string;
  value: unknown;
  tails: FieldTails;
}): void {
  const { target, key, value, tails } = params;
  if (typeof value !== "string" || value.length === 0) {
    tails.get(target)?.delete(key);
    return;
  }
  let fields = tails.get(target);
  if (!fields) {
    fields = new Map();
    tails.set(target, fields);
  }
  // Cache the incoming suffix, never index into a growing concatenated prefix.
  fields.set(key, value.charCodeAt(value.length - 1));
}

function appendedBytes(last: number | undefined, delta: string): number {
  // Two escaped surrogate halves become one UTF-8 code point when joined.
  return jsonBytes(delta) - 2 - (joinsSurrogates(last, delta) ? 8 : 0);
}

function joinsSurrogates(last: number | undefined, next: string): boolean {
  const first = next.charCodeAt(0);
  return (
    last !== undefined &&
    last >= 0xd800 &&
    last <= 0xdbff &&
    first >= 0xdc00 &&
    first <= 0xdfff
  );
}

function setRetainedPart(params: {
  content: unknown[];
  index: number;
  part: JsonRecord;
  retain: Retain;
}): void {
  const { content, index, part, retain } = params;
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0xffffffff) {
    failClosed();
  }
  const bytes =
    index < content.length
      ? jsonBytes(part) - jsonBytes(content[index] ?? null)
      : jsonBytes(part) +
        (index - content.length) * 5 +
        (content.length === 0 ? 0 : 1);
  retain(bytes);
  content[index] = part;
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
