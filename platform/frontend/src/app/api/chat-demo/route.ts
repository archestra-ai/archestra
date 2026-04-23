import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const body: {
    messages: UIMessage[];
    model: string;
    webSearch: boolean;
    __mockScenario?: {
      id?: string;
      mode?: string;
      stream?: {
        events: MockChatScenarioEvent[];
      };
    };
  } = await req.json();

  if (body.__mockScenario?.stream?.events) {
    logMockScenarioRequest(body);
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        originalMessages: body.messages,
        execute: async ({ writer }) => {
          for (const event of body.__mockScenario?.stream?.events ?? []) {
            logMockScenarioEvent(body.__mockScenario?.id, event);
            await writeMockEvent(writer, event);
          }
        },
      }),
    });
  }

  const { messages, model, webSearch } = body;

  const modelMessages = await convertToModelMessages(messages);
  const result = streamText({
    model: webSearch ? "perplexity/sonar" : model,
    messages: modelMessages,
    system:
      "You are a helpful assistant that can answer questions and help with tasks",
  });

  // send sources and reasoning back to the client
  return result.toUIMessageStreamResponse({
    sendSources: true,
    sendReasoning: true,
  });
}

type MockChatScenarioEvent =
  | {
      type: "assistant-text";
      text: string;
      id?: string;
      delayMs?: number;
    }
  | {
      type: "assistant-reasoning";
      text: string;
      id?: string;
      delayMs?: number;
    }
  | {
      type: "user-text";
      text: string;
      delayMs?: number;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      dynamic?: boolean;
      title?: string;
      providerExecuted?: boolean;
      delayMs?: number;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      result:
        | {
            state: "output-available";
            output: unknown;
            dynamic?: boolean;
            preliminary?: boolean;
          }
        | {
            state: "output-error";
            errorText: string;
            dynamic?: boolean;
          }
        | {
            state: "output-denied";
          };
      delayMs?: number;
    }
  | {
      type: "data-tool-ui-start";
      toolCallId: string;
      toolName: string;
      uiResourceUri: string;
      html?: string;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
      permissions?: {
        camera?: boolean;
        microphone?: boolean;
        geolocation?: boolean;
        clipboardWrite?: boolean;
      };
      delayMs?: number;
    }
  | {
      type: "delay";
      ms: number;
    }
  | {
      type: "finish";
      finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
      delayMs?: number;
    }
  | {
      type: "error";
      errorText: string;
      delayMs?: number;
    };

async function writeMockEvent(
  writer: {
    write: (part: UIMessageChunk) => void;
  },
  event: MockChatScenarioEvent,
) {
  if (event.type === "delay") {
    await wait(event.ms);
    return;
  }

  if (event.delayMs) {
    await wait(event.delayMs);
  }

  switch (event.type) {
    case "assistant-text": {
      const id = event.id ?? crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: event.text });
      writer.write({ type: "text-end", id });
      return;
    }
    case "assistant-reasoning": {
      const id = event.id ?? crypto.randomUUID();
      writer.write({ type: "reasoning-start", id });
      writer.write({ type: "reasoning-delta", id, delta: event.text });
      writer.write({ type: "reasoning-end", id });
      return;
    }
    case "user-text": {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: event.text });
      writer.write({ type: "text-end", id });
      return;
    }
    case "tool-call": {
      writer.write({
        type: "tool-input-start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        dynamic: event.dynamic,
        title: event.title,
        providerExecuted: event.providerExecuted,
      });
      writer.write({
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        dynamic: event.dynamic,
        title: event.title,
        providerExecuted: event.providerExecuted,
      });
      return;
    }
    case "tool-result": {
      if (event.result.state === "output-available") {
        writer.write({
          type: "tool-output-available",
          toolCallId: event.toolCallId,
          output: event.result.output,
          dynamic: event.result.dynamic,
          preliminary: event.result.preliminary,
        });
        return;
      }

      if (event.result.state === "output-error") {
        writer.write({
          type: "tool-output-error",
          toolCallId: event.toolCallId,
          errorText: event.result.errorText,
          dynamic: event.result.dynamic,
        });
        return;
      }

      writer.write({
        type: "tool-output-denied",
        toolCallId: event.toolCallId,
      });
      return;
    }
    case "data-tool-ui-start": {
      writer.write({
        type: "data-tool-ui-start",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          uiResourceUri: event.uiResourceUri,
          html: event.html,
          csp: event.csp,
          permissions: event.permissions,
        },
      });
      return;
    }
    case "error": {
      writer.write({
        type: "error",
        errorText: event.errorText,
      });
      return;
    }
    case "finish": {
      writer.write({
        type: "finish",
        finishReason: event.finishReason ?? "stop",
      });
      return;
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logMockScenarioRequest(body: {
  messages: UIMessage[];
  model: string;
  webSearch: boolean;
  __mockScenario?: {
    id?: string;
    mode?: string;
    stream?: {
      events: MockChatScenarioEvent[];
    };
  };
}) {
  const lastMessage = body.messages.at(-1);
  const lastText = lastMessage?.parts
    ?.filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");

  console.log(
    `[chat-demo] start scenario=${body.__mockScenario?.id ?? "unknown"} mode=${body.__mockScenario?.mode ?? "unknown"} events=${body.__mockScenario?.stream?.events.length ?? 0} model=${body.model} webSearch=${body.webSearch} lastUserText=${JSON.stringify(lastText ?? "")}`,
  );
}

function logMockScenarioEvent(
  scenarioId: string | undefined,
  event: MockChatScenarioEvent,
) {
  console.log(
    `[chat-demo] event scenario=${scenarioId ?? "unknown"} ${formatMockScenarioEvent(
      event,
    )}`,
  );
}

function formatMockScenarioEvent(event: MockChatScenarioEvent): string {
  switch (event.type) {
    case "assistant-text":
      return `type=assistant-text text=${JSON.stringify(event.text)}`;
    case "assistant-reasoning":
      return `type=assistant-reasoning text=${JSON.stringify(event.text)}`;
    case "user-text":
      return `type=user-text text=${JSON.stringify(event.text)}`;
    case "tool-call":
      return `type=tool-call toolCallId=${event.toolCallId} toolName=${event.toolName} input=${JSON.stringify(event.input)}`;
    case "tool-result":
      if (event.result.state === "output-available") {
        return `type=tool-result state=output-available toolCallId=${event.toolCallId} output=${JSON.stringify(event.result.output)}`;
      }

      if (event.result.state === "output-error") {
        return `type=tool-result state=output-error toolCallId=${event.toolCallId} errorText=${JSON.stringify(event.result.errorText)}`;
      }

      return `type=tool-result state=output-denied toolCallId=${event.toolCallId}`;
    case "data-tool-ui-start":
      return `type=data-tool-ui-start toolCallId=${event.toolCallId} toolName=${event.toolName} uiResourceUri=${event.uiResourceUri}`;
    case "delay":
      return `type=delay ms=${event.ms}`;
    case "finish":
      return `type=finish finishReason=${event.finishReason ?? "stop"}`;
    case "error":
      return `type=error errorText=${JSON.stringify(event.errorText)}`;
  }
}
