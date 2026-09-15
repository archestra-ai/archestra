import { createHash } from "node:crypto";

export type AppaHistoryProtocol =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

class AppaHistoryCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppaHistoryCodecError";
  }
}

export type AppaCanonicalRequestHistory = {
  protocol: AppaHistoryProtocol;
  history: unknown[];
  bootstrap: unknown[];
  bootstrapDigest: string | null;
  rawRequest: Record<string, unknown>;
  compactionRequested: boolean;
};

type AppaCanonicalResponseHistory = {
  protocol: AppaHistoryProtocol;
  items: unknown[];
  issuedItemsDigest: string;
  rawResponse: Record<string, unknown>;
  terminalOmission: boolean;
  compactionProduced: boolean;
};

type AppaCanonicalExchange = AppaCanonicalRequestHistory & {
  response: AppaCanonicalResponseHistory;
  inheritedHistory: unknown[];
};

/**
 * Canonicalizes only the provider containers needed for checkpoint matching.
 * Every canonical item retains an exact `wire` copy, so the encrypted response
 * frame remains the authoritative raw provider history.
 */
export class AppaHistoryCodec {
  static request(params: {
    protocol: AppaHistoryProtocol;
    request: unknown;
  }): AppaCanonicalRequestHistory {
    const request = cloneObject(params.request, "request");
    switch (params.protocol) {
      case "anthropic-messages":
        return anthropicRequest(request);
      case "openai-chat-completions":
        return chatRequest(request);
      case "openai-responses":
        return responsesRequest(request);
    }
  }

  static response(params: {
    protocol: AppaHistoryProtocol;
    response: unknown;
  }): AppaCanonicalResponseHistory {
    const response = cloneObject(params.response, "response");
    switch (params.protocol) {
      case "anthropic-messages":
        return anthropicResponse(response);
      case "openai-chat-completions":
        return chatResponse(response);
      case "openai-responses":
        return responsesResponse(response);
    }
  }

  static exchange(params: {
    protocol: AppaHistoryProtocol;
    request: unknown;
    response: unknown;
  }): AppaCanonicalExchange {
    const request = AppaHistoryCodec.request(params);
    const response = AppaHistoryCodec.response(params);
    return {
      ...request,
      response,
      inheritedHistory: [...request.history, ...response.items],
    };
  }
}

function anthropicRequest(
  request: Record<string, unknown>,
): AppaCanonicalRequestHistory {
  const messages = arrayOfObjects(request.messages, "Anthropic messages");
  const history = messages.map((message) => anthroMessage(message, "request"));
  const bootstrap =
    request.system === undefined
      ? []
      : [
          {
            type: "bootstrap",
            role: "system",
            content: messageContent(request.system, "Anthropic system"),
            wire: structuredClone(request.system),
          },
        ];
  return requestHistory({
    protocol: "anthropic-messages",
    request,
    history,
    bootstrap,
    compactionRequested: hasCompactionSignal(request),
  });
}

function chatRequest(
  request: Record<string, unknown>,
): AppaCanonicalRequestHistory {
  const messages = arrayOfObjects(request.messages, "chat messages");
  const history: unknown[] = [];
  const bootstrap: unknown[] = [];
  for (const message of messages) {
    const canonical = chatMessage(message, "request");
    if (canonical.role === "system" || canonical.role === "developer") {
      bootstrap.push(canonical);
    } else {
      history.push(canonical);
    }
  }
  return requestHistory({
    protocol: "openai-chat-completions",
    request,
    history,
    bootstrap,
    compactionRequested: hasCompactionSignal(request),
  });
}

function responsesRequest(
  request: Record<string, unknown>,
): AppaCanonicalRequestHistory {
  const source =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : arrayOfObjects(request.input, "Responses input");
  const history: unknown[] = [];
  const bootstrap: unknown[] = [];
  for (const item of source) {
    const canonical = responsesItem(item, "request");
    if (
      canonical.type === "message" &&
      (canonical.role === "system" || canonical.role === "developer")
    ) {
      bootstrap.push(canonical);
    } else {
      history.push(canonical);
    }
  }
  if (request.instructions !== undefined) {
    bootstrap.push({
      type: "instructions",
      wire: structuredClone(request.instructions),
    });
  }
  return requestHistory({
    protocol: "openai-responses",
    request,
    history,
    bootstrap,
    compactionRequested:
      source.some((item) => item.type === "compaction_trigger") ||
      hasCompactionSignal(request),
  });
}

function anthropicResponse(
  response: Record<string, unknown>,
): AppaCanonicalResponseHistory {
  const content = arrayOfObjects(
    response.content,
    "Anthropic response content",
  );
  const item = {
    type: "message",
    role: "assistant",
    content: content.map((part) => anthroContentPart(part, "response")),
    extras: {},
  };
  return responseHistory({
    protocol: "anthropic-messages",
    response,
    items: [item],
    terminalOmission: content.every((part) =>
      ["text", "thinking", "redacted_thinking"].includes(
        stringField(part, "type", "Anthropic response content"),
      ),
    ),
  });
}

function chatResponse(
  response: Record<string, unknown>,
): AppaCanonicalResponseHistory {
  const choices = arrayOfObjects(response.choices, "chat response choices");
  if (choices.length !== 1) {
    throw new AppaHistoryCodecError(
      "chat response must contain exactly one choice for native history",
    );
  }
  const message = objectField(choices[0], "message", "chat response choice");
  return responseHistory({
    protocol: "openai-chat-completions",
    response,
    items: [chatMessage(message, "response")],
    terminalOmission: false,
  });
}

function responsesResponse(
  response: Record<string, unknown>,
): AppaCanonicalResponseHistory {
  const output = arrayOfObjects(response.output, "Responses response output");
  return responseHistory({
    protocol: "openai-responses",
    response,
    items: output.map((item) => responsesItem(item, "response")),
    terminalOmission: false,
  });
}

function requestHistory(params: {
  protocol: AppaHistoryProtocol;
  request: Record<string, unknown>;
  history: unknown[];
  bootstrap: unknown[];
  compactionRequested: boolean;
}): AppaCanonicalRequestHistory {
  return {
    protocol: params.protocol,
    history: params.history,
    bootstrap: params.bootstrap,
    bootstrapDigest:
      params.bootstrap.length === 0 ? null : digest(params.bootstrap),
    rawRequest: params.request,
    compactionRequested: params.compactionRequested,
  };
}

function responseHistory(params: {
  protocol: AppaHistoryProtocol;
  response: Record<string, unknown>;
  items: unknown[];
  terminalOmission: boolean;
}): AppaCanonicalResponseHistory {
  return {
    protocol: params.protocol,
    items: params.items,
    issuedItemsDigest: digest(params.items),
    rawResponse: params.response,
    terminalOmission: params.terminalOmission,
    compactionProduced: params.items.some(
      (item) => isObject(item) && item.type === "compaction",
    ),
  };
}

function anthroMessage(
  message: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const role = stringField(message, "role", `Anthropic ${where} message`);
  if (role !== "user" && role !== "assistant") {
    throw new AppaHistoryCodecError("Anthropic message role is unsupported");
  }
  return {
    type: "message",
    role,
    content: anthroContent(message.content, `Anthropic ${where} content`),
    extras: withoutFields(message, ["role", "content"]),
  };
}

function chatMessage(
  message: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const role = stringField(message, "role", `chat ${where} message`);
  if (
    !new Set(["system", "developer", "user", "assistant", "tool"]).has(role)
  ) {
    throw new AppaHistoryCodecError("chat message role is unsupported");
  }
  return {
    type: "message",
    role,
    content: messageContent(message.content ?? "", `chat ${where} content`),
    ...(typeof message.name === "string" ? { name: message.name } : {}),
    ...(role === "tool"
      ? {
          tool_call_id: stringField(
            message,
            "tool_call_id",
            `chat ${where} tool`,
          ),
        }
      : {}),
    ...(message.tool_calls === undefined
      ? {}
      : {
          tool_calls: arrayOfObjects(
            message.tool_calls,
            `chat ${where} calls`,
          ).map((call) => chatToolCall(call, where)),
        }),
    extras: withoutFields(message, [
      "role",
      "content",
      "name",
      "tool_call_id",
      "tool_calls",
    ]),
  };
}

function responsesItem(
  item: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const type = typeof item.type === "string" ? item.type : "message";
  if (type === "message") {
    const role = stringField(item, "role", `Responses ${where} message`);
    if (!new Set(["system", "developer", "user", "assistant"]).has(role)) {
      throw new AppaHistoryCodecError("Responses message role is unsupported");
    }
    return {
      type: "message",
      role,
      content: messageContent(item.content ?? "", `Responses ${where} content`),
      extras: withoutFields(item, ["type", "role", "content"]),
    };
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return {
      type,
      call_id: stringField(item, "call_id", `Responses ${where} call`),
      name: stringField(item, "name", `Responses ${where} call`),
      ...("arguments" in item
        ? { arguments: canonicalPayload(item.arguments) }
        : {}),
      ...("input" in item ? { input: canonicalPayload(item.input) } : {}),
      extras: withoutFields(item, [
        "type",
        "call_id",
        "name",
        "arguments",
        "input",
      ]),
    };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return {
      type,
      call_id: stringField(item, "call_id", `Responses ${where} output`),
      output: canonicalPayload(item.output),
      extras: withoutFields(item, ["type", "call_id", "output"]),
    };
  }
  return { type, wire: structuredClone(item) };
}

function anthroContent(value: unknown, where: string): unknown[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value, extras: {} }];
  }
  return arrayOfObjects(value, where).map((part) =>
    anthroContentPart(part, where),
  );
}

function anthroContentPart(
  part: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const type = stringField(part, "type", where);
  if (type === "text") {
    return {
      type: "text",
      text: stringField(part, "text", where),
      extras: withoutFields(part, ["type", "text"]),
    };
  }
  if (type === "thinking") {
    return {
      type,
      thinking: stringField(part, "thinking", where),
      extras: withoutFields(part, ["type", "thinking"]),
    };
  }
  if (type === "redacted_thinking") {
    return {
      type,
      data: stringField(part, "data", where),
      extras: withoutFields(part, ["type", "data"]),
    };
  }
  if (type === "tool_use") {
    return {
      type,
      call_id: stringField(part, "id", where),
      name: stringField(part, "name", where),
      input: canonicalPayload(part.input),
      extras: withoutFields(part, ["type", "id", "name", "input"]),
    };
  }
  if (type === "tool_result") {
    return {
      type,
      call_id: stringField(part, "tool_use_id", where),
      content: messageContent(part.content ?? "", where),
      ...(typeof part.is_error === "boolean"
        ? { is_error: part.is_error }
        : {}),
      extras: withoutFields(part, [
        "type",
        "tool_use_id",
        "content",
        "is_error",
      ]),
    };
  }
  throw new AppaHistoryCodecError("Anthropic content item is unsupported");
}

function messageContent(
  value: unknown,
  where: string,
): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return [{ type: "text", text: value, extras: {} }];
  }
  return arrayOfObjects(value, where).map((part) => {
    const type = stringField(part, "type", where);
    if (["text", "input_text", "output_text"].includes(type)) {
      const text =
        typeof part.text === "string"
          ? part.text
          : stringField(part, "content", where);
      return {
        type: "text",
        text,
        extras: withoutFields(part, ["type", "text", "content"]),
      };
    }
    return { type: "opaque", wire: structuredClone(part) };
  });
}

function chatToolCall(
  call: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const functionCall = objectField(call, "function", `chat ${where} call`);
  return {
    id: stringField(call, "id", `chat ${where} call`),
    type: typeof call.type === "string" ? call.type : "function",
    function: {
      name: stringField(functionCall, "name", `chat ${where} function`),
      arguments: canonicalArguments(
        stringField(functionCall, "arguments", `chat ${where} function`),
      ),
      extras: withoutFields(functionCall, ["name", "arguments"]),
    },
    extras: withoutFields(call, ["id", "type", "function"]),
  };
}

function canonicalArguments(value: string): unknown {
  try {
    return { json: JSON.parse(value) as unknown };
  } catch {
    return { raw: value };
  }
}

function canonicalPayload(value: unknown): unknown {
  if (typeof value !== "string") return structuredClone(value);
  return canonicalArguments(value);
}

function withoutFields(
  value: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !fields.includes(key))
      .map(([key, entry]) => [key, structuredClone(entry)]),
  );
}

function hasCompactionSignal(value: Record<string, unknown>): boolean {
  return (
    value.compaction !== undefined ||
    value.context_management !== undefined ||
    value.compaction_trigger === true
  );
}

function arrayOfObjects(
  value: unknown,
  where: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new AppaHistoryCodecError(`${where} must be an array of objects`);
  }
  return value;
}

function objectField(
  value: Record<string, unknown>,
  field: string,
  where: string,
): Record<string, unknown> {
  if (!isObject(value[field])) {
    throw new AppaHistoryCodecError(`${where} has no object ${field}`);
  }
  return value[field];
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  where: string,
): string {
  if (typeof value[field] !== "string") {
    throw new AppaHistoryCodecError(`${where} has no string ${field}`);
  }
  return value[field];
}

function cloneObject(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new AppaHistoryCodecError(`${where} must be an object`);
  }
  return structuredClone(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (isObject(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
  if (serialized === undefined) {
    throw new AppaHistoryCodecError("provider history is not serializable");
  }
  return serialized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
