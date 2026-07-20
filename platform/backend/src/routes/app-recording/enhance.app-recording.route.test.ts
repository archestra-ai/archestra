import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { ConversationModel, MessageModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import appRecordingRoutes from "./app-recording.routes";

/**
 * Boundary mock: the real drafting service and the real `ai` SDK run, and MSW
 * serves the provider's wire responses. The one seam kept is the model
 * factory, pointed at a base URL the MSW server intercepts — everything the
 * route does with the transcript, the tag contract and the sanitizers is the
 * shipped code.
 */
const LLM_BASE_URL = "https://llm.test/v1";

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  const { createOpenAI } = await import("@ai-sdk/openai");
  // Literal (not the module-level const) — this factory is hoisted above it.
  const model = createOpenAI({
    baseURL: "https://llm.test/v1",
    apiKey: "test-key",
  }).chat("gpt-4o-mini");
  return { ...actual, createLLMModel: vi.fn(() => model) };
});

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

/**
 * What the model "answers" for each tag, in the shapes that make the
 * sanitizers earn their keep: a quoted description, an ask the model drifted
 * into a spec, and a category with a full stop on it.
 */
const DRAFTS: Record<string, string> = {
  description:
    '"Every open PR across the org, sorted by how long it has been waiting."',
  build_prompt: [
    "Build me a review queue for our open PRs.",
    "",
    "Features:",
    "- Sort by wait time",
    "- Flag anything older than 3 days",
  ].join("\n"),
  closing_response: "Built it — here is your review queue.",
  category: "Development.",
};

/**
 * Answer each of the four generation calls with the draft for the tag it
 * asked for. The service asks for one tag per field in parallel, and the tag
 * it wants is named in the output contract appended to the system prompt.
 */
function serveDrafts(): void {
  server.use(
    http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages.find((m) => m.role === "system")?.content;
      const tag = /EXACTLY ONE <(\w+)>/.exec(system ?? "")?.[1] ?? "";
      return HttpResponse.json({
        id: "chatcmpl-test",
        created: 0,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `<${tag}>${DRAFTS[tag]}</${tag}>`,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
}

describe("POST /api/app-recordings/enhance", () => {
  const ctx = useRouteTestApp(appRecordingRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    config.hackathonRecorder.enabled = true;
  });

  /** A chat that built something, as the enhancement reads it. */
  async function makeRecordedSession(
    makeAgent: (overrides: {
      organizationId: string;
    }) => Promise<{ id: string }>,
    turns: { role: "user" | "assistant"; text: string }[] = [
      { role: "user", text: "Show me every open PR across our repos." },
      { role: "assistant", text: "Here is the review queue." },
    ],
  ): Promise<string> {
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const conversation = await ConversationModel.create({
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      agentId: agent.id,
      title: "PR Dashboard",
    });
    for (const turn of turns) {
      await MessageModel.create({
        conversationId: conversation.id,
        role: turn.role,
        content: {
          role: turn.role,
          parts: [{ type: "text", text: turn.text }],
        },
      });
    }
    return conversation.id;
  }

  test("drafts all four fields from the chat and sanitizes each one", async ({
    makeAgent,
  }) => {
    serveDrafts();
    const conversationId = await makeRecordedSession(makeAgent);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId, appName: "PR Dashboard" },
    });

    expect(response.statusCode).toBe(200);
    // Each field carries its own sanitizer, and swapping two of them would be
    // invisible without drafts that only one of them cleans up: the quotes go,
    // the spec the model drifted into is cut, and the category loses its stop.
    expect(response.json()).toEqual({
      description:
        "Every open PR across the org, sorted by how long it has been waiting.",
      prompt: "Build me a review queue for our open PRs.",
      response: "Built it — here is your review queue.",
      category: "Development",
    });
  });

  test("returns nulls, not an error, when the provider is down", async ({
    makeAgent,
  }) => {
    // 400 rather than a 5xx: the SDK retries 5xx, and the point here is the
    // failure, not the retry.
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: { message: "nope" } }, { status: 400 }),
      ),
    );
    const conversationId = await makeRecordedSession(makeAgent);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId, appName: "PR Dashboard" },
    });

    // The recorder applies the enhancement automatically when a session stops,
    // so a provider outage must leave the author with a recording and the
    // fallback copy — never a failed stop.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      description: null,
      prompt: null,
      response: null,
      category: null,
    });
  });

  test("does not reach for a model when the chat has nothing to read", async ({
    makeAgent,
  }) => {
    // No handler is registered, so MSW fails the test on any provider call —
    // which is the assertion: a chat with no transcript is answered from the
    // short-circuit, without spending a request on it.
    const conversationId = await makeRecordedSession(makeAgent, []);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId, appName: "PR Dashboard" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      description: null,
      prompt: null,
      response: null,
      category: null,
    });
  });

  test("403s when the hackathon recorder is disabled on the deployment", async () => {
    config.hackathonRecorder.enabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "The hackathon recorder is disabled",
    );
  });

  test("404s for a conversation the caller does not own", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });
});
