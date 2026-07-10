import { describe, expect, test } from "@/test";
import { ApiError, type OpenAi } from "@/types";
import {
  assertNoTools,
  buildGraphChatBody,
  completionTextToChunks,
  estimateUsage,
  extractGraphResponseText,
  graphChatResponseToOpenAi,
} from "./microsoft-365-copilot-graph-translator";

type Request = OpenAi.Types.ChatCompletionsRequest;

const MODEL = "microsoft-365-copilot";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  } as Request;
}

describe("assertNoTools", () => {
  test("accepts a plain request", () => {
    expect(() => assertNoTools(makeRequest())).not.toThrow();
  });

  test("rejects declared tools with an actionable 400", () => {
    const request = makeRequest({
      tools: [
        {
          type: "function",
          function: { name: "read_file", parameters: {} },
        },
      ],
    } as Partial<Request>);

    let caught: unknown;
    try {
      assertNoTools(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("does not support tool calling"),
    });
  });

  test("rejects a tool_choice forcing a tool", () => {
    const request = makeRequest({
      tool_choice: "required",
    } as Partial<Request>);
    expect(() => assertNoTools(request)).toThrow(ApiError);
  });

  test('accepts tool_choice "none"', () => {
    const request = makeRequest({ tool_choice: "none" } as Partial<Request>);
    expect(() => assertNoTools(request)).not.toThrow();
  });

  test("rejects legacy functions", () => {
    const request = makeRequest({
      functions: [{ name: "read_file" }],
    } as unknown as Partial<Request>);
    expect(() => assertNoTools(request)).toThrow(ApiError);
  });
});

describe("buildGraphChatBody", () => {
  test("uses the latest user message as the prompt", () => {
    const body = buildGraphChatBody(
      makeRequest({
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" },
        ],
      }),
    );

    expect(body.message.text).toBe("second question");
    expect(body.additionalContext).toHaveLength(1);
    expect(body.additionalContext?.[0].text).toContain("user: first question");
    expect(body.additionalContext?.[0].text).toContain(
      "assistant: first answer",
    );
    // The Chat API rejects requests without a locationHint.
    expect(body.locationHint).toEqual({ timeZone: "UTC" });
  });

  test("serializes system messages into an Instructions section", () => {
    const body = buildGraphChatBody(
      makeRequest({
        messages: [
          { role: "system", content: "Answer in French." },
          { role: "user", content: "Hello" },
        ],
      }),
    );

    expect(body.message.text).toBe("Hello");
    expect(body.additionalContext?.[0].text).toContain("Instructions:");
    expect(body.additionalContext?.[0].text).toContain("Answer in French.");
  });

  test("omits additionalContext for a single user message", () => {
    const body = buildGraphChatBody(makeRequest());
    expect(body.message.text).toBe("Hello");
    expect(body.additionalContext).toBeUndefined();
  });

  test("joins text parts of a structured user message", () => {
    const body = buildGraphChatBody(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: "part two" },
            ],
          },
        ],
      }),
    );
    expect(body.message.text).toBe("part one\npart two");
  });

  test("rejects a request without any user message", () => {
    expect(() =>
      buildGraphChatBody(
        makeRequest({
          messages: [{ role: "system", content: "only instructions" }],
        }),
      ),
    ).toThrow(ApiError);
  });

  test("rejects a request whose last user message has no text", () => {
    expect(() =>
      buildGraphChatBody(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/x.png" },
                },
              ],
            },
          ],
        } as unknown as Partial<Request>),
      ),
    ).toThrow(ApiError);
  });
});

describe("extractGraphResponseText", () => {
  test("picks the last response message from the documented shape", () => {
    const text = extractGraphResponseText({
      id: "conv-1",
      messages: [
        {
          "@odata.type": "#microsoft.graph.copilotConversationRequestMessage",
          text: "the user's own prompt",
        },
        {
          "@odata.type": "#microsoft.graph.copilotConversationResponseMessage",
          text: "Copilot's answer",
          adaptiveCards: [],
          attributions: [],
        },
      ],
    });
    expect(text).toBe("Copilot's answer");
  });

  test("ignores request-message echoes", () => {
    const text = extractGraphResponseText({
      messages: [
        {
          "@odata.type": "#microsoft.graph.copilotConversationRequestMessage",
          text: "prompt echo",
        },
      ],
    });
    expect(text).toBeUndefined();
  });

  test("handles single-message payloads defensively", () => {
    expect(extractGraphResponseText({ text: "direct" })).toBe("direct");
    expect(extractGraphResponseText({ message: { text: "nested" } })).toBe(
      "nested",
    );
  });

  test("returns undefined for unrecognized payloads", () => {
    expect(extractGraphResponseText(null)).toBeUndefined();
    expect(extractGraphResponseText("plain string")).toBeUndefined();
    expect(extractGraphResponseText({ messages: [] })).toBeUndefined();
  });
});

describe("graphChatResponseToOpenAi", () => {
  test("produces an OpenAI chat.completion", () => {
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    };
    const response = graphChatResponseToOpenAi({
      responseText: "the answer",
      model: MODEL,
      completionId: "chatcmpl-test",
      createdUnixSeconds: 1_700_000_000,
      usage,
    });

    expect(response).toMatchObject({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: MODEL,
      usage,
    });
    expect(response.choices[0].message).toMatchObject({
      role: "assistant",
      content: "the answer",
    });
    expect(response.choices[0].finish_reason).toBe("stop");
  });
});

describe("completionTextToChunks", () => {
  test("fabricates role, content, and finish+usage chunks", () => {
    const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const chunks = completionTextToChunks({
      responseText: "streamed answer",
      model: MODEL,
      completionId: "chatcmpl-test",
      createdUnixSeconds: 1_700_000_000,
      usage,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });
    expect(chunks[1].choices[0].delta).toMatchObject({
      content: "streamed answer",
    });
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
    expect(chunks[2].usage).toEqual(usage);
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.id).toBe("chatcmpl-test");
    }
  });
});

describe("estimateUsage", () => {
  test("estimates non-zero token counts from request and response text", () => {
    const usage = estimateUsage({
      request: makeRequest({
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is the meeting about tomorrow?" },
        ],
      }),
      responseText: "Your 9 AM meeting is the quarterly planning review.",
    });

    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(
      usage.prompt_tokens + usage.completion_tokens,
    );
  });
});
