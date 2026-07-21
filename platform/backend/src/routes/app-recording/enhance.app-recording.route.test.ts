import { randomUUID } from "node:crypto";
import {
  APPS_HACKATHON_CLOSES_AT_MS,
  APPS_HACKATHON_OPENS_AT_MS,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { ConversationModel, MessageModel, OrganizationModel } from "@/models";
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
    // Bypass the date window by default so these cases don't depend on the
    // wall clock sitting inside the hackathon — the date gate has its own
    // tests below, which turn this back off. This file uses vi.mock, so it
    // runs in the isolated project where config is NOT auto-restored between
    // tests; every case must set the baseline it needs, hence both flags here.
    config.hackathonRecorder.overrideActive = true;
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

  test("403s when the deployment does not offer the recorder (enterprise, no override)", async () => {
    config.hackathonRecorder.enabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "not available on this deployment",
    );
  });

  test("403s when the organization has switched the recorder off", async () => {
    // The admin toggle has to take the API with it, not just hide the button:
    // a control that vanishes while its endpoints keep answering is a feature
    // that was never really disabled.
    await OrganizationModel.patch(ctx.organizationId, {
      appsHackathonRecorderEnabled: false,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "switched off for this organization",
    );
  });

  test("403s before the hackathon has started", async () => {
    config.hackathonRecorder.overrideActive = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Comfortably before the window: shouldAdvanceTime lets the clock tick
    // through the request, so a boundary-hugging value would slip into the
    // window mid-flight and pass the gate.
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS - 60 * 60 * 1000);
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/app-recordings/enhance",
        payload: { conversationId: randomUUID(), appName: "Demo App" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        "The Apps Hackathon has not started yet",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("403s once the hackathon has closed, however it is configured", async () => {
    // Read per request rather than captured at boot, so a pod that has been up
    // since before the closing date stops serving the feature the moment it
    // passes — with the deployment flag and the organization toggle both still
    // on, as they are here.
    config.hackathonRecorder.overrideActive = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(APPS_HACKATHON_CLOSES_AT_MS);
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/app-recordings/enhance",
        payload: { conversationId: randomUUID(), appName: "Demo App" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        "The Apps Hackathon has ended",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("the staging override bypasses the date window entirely", async () => {
    // Staging runs the override to exercise the recorder outside the hackathon
    // window. Outside it here (before it opens), the date gate must NOT fire —
    // the request falls through to the ordinary ownership check instead, which
    // is a 404 for this random conversation, not a 403 about the dates.
    config.hackathonRecorder.overrideActive = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS - 60 * 60 * 1000);
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/app-recordings/enhance",
        payload: { conversationId: randomUUID(), appName: "Demo App" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toContain("Conversation not found");
    } finally {
      vi.useRealTimers();
    }
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
