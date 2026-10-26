/**
 * The LiteLLM lab's acceptance criteria (research panel C), run against
 * Archestra's model pools through the Model Router. Each deployment is a fake
 * OpenAI-compatible upstream whose behaviour a test sets; its hit count is
 * the ground truth, as in the lab. Criteria that need load, replicas or
 * latency routing (AC-Q1, AC-O1, AC-L1, AC-M1, AC-M2) are left out.
 */

import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

vi.mock("../model-pool-failover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-pool-failover")>()),
  // The lab's black-hole deployment timeout, shortened to keep the test fast.
  MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS: 300,
  MODEL_POOL_RESPONSE_TIMEOUT_MS: 300,
  MODEL_POOL_MS_PER_OUTPUT_TOKEN: 10,
  MODEL_POOL_MAX_RESPONSE_TIMEOUT_MS: 600,
}));

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
setupTestCacheManager();

type Mode =
  | { kind: "ok" }
  | { kind: "status"; status: number; retryAfter?: string }
  | { kind: "refused" }
  | { kind: "black-hole" }
  | { kind: "slow"; ms: number }
  | { kind: "cut-before-first-chunk" }
  | { kind: "cut-after-first-chunk" };

interface Deployment {
  origin: string;
  keyId: string;
  mode: Mode;
  hits: number;
}

const labTest = test.extend<{
  lab: {
    deploy: (
      members: Array<{ priority: number; weight?: number }>,
    ) => Promise<Deployment[]>;
    ask: (options?: { stream?: boolean; maxTokens?: number }) => Promise<{
      status: number;
      body: string;
      attempts?: string;
      providerKey?: string;
      ms: number;
    }>;
  };
}>({
  lab: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    let token = "";

    const deploy = async (
      members: Array<{ priority: number; weight?: number }>,
    ) => {
      const deployments: Deployment[] = [];
      for (const [index] of members.entries()) {
        const origin = `https://d${index + 1}.example.test/v1`;
        const key = await makeLlmProviderApiKey(
          org.id,
          (await makeSecret({ secret: { apiKey: `sk-d${index + 1}` } })).id,
          { provider: "openai", baseUrl: origin },
        );
        deployments.push({
          origin,
          keyId: key.id,
          mode: { kind: "ok" },
          hits: 0,
        });
      }
      const virtual = await VirtualApiKeyModel.create({
        organizationId: org.id,
        name: "Lab client",
        ...accessGrants("org"),
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: deployments[0].keyId },
        ],
      });
      await ModelPoolModel.create({
        organizationId: org.id,
        input: {
          name: "lab-model",
          members: members.map((member, index) => ({
            providerApiKeyId: deployments[index].keyId,
            modelId: "lab-model",
            priority: member.priority,
            weight: member.weight ?? 1,
            enabled: true,
          })),
          virtualApiKeyIds: [virtual.virtualKey.id],
        },
      });
      token = virtual.value;
      server.use(
        ...deployments.map((deployment) =>
          http.post(`${deployment.origin}/chat/completions`, ({ request }) =>
            respond(deployment, request),
          ),
        ),
      );
      return deployments;
    };

    const ask = async ({
      stream = false,
      maxTokens,
    }: {
      stream?: boolean;
      maxTokens?: number;
    } = {}) => {
      const started = Date.now();
      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/chat/completions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          model: "lab-model",
          stream,
          messages: [{ role: "user", content: "hello" }],
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        },
      });
      return {
        status: response.statusCode,
        body: response.body,
        attempts: response.headers["x-archestra-attempts"] as string,
        providerKey: response.headers["x-archestra-provider-key"] as string,
        ms: Date.now() - started,
      };
    };

    try {
      await use({ deploy, ask });
    } finally {
      await app.close();
    }
  },
});

labTest("AC-P1 priority hold: priority 2 gets no traffic", async ({ lab }) => {
  const [first, second] = await lab.deploy([{ priority: 1 }, { priority: 2 }]);
  for (let i = 0; i < 10; i++) {
    expect((await lab.ask()).providerKey).toBe(first.keyId);
  }
  expect([first.hits, second.hits]).toEqual([10, 0]);
});

labTest(
  "AC-P2 / AC-R1 / AC-R4 a 429 hops at once and benches the member for its Retry-After",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "status", status: 429, retryAfter: "10" };
    const answers = [];
    for (let i = 0; i < 10; i++) answers.push(await lab.ask());
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    expect(answers.map((answer) => answer.attempts)).toEqual([
      "2",
      ...Array(9).fill("1"),
    ]);
    // One hit per Retry-After window; every other request skips it.
    expect([first.hits, second.hits]).toEqual([1, 10]);
    // A refused attempt read nothing, so it carries no input and no cost.
    const [refused] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.attemptOutcome, "failed_over"));
    expect(refused).toMatchObject({
      inputTokens: 0,
      inputTokensEstimated: false,
      cost: "0.0000000000",
    });
  },
);

labTest(
  "AC-P3 / AC-F1 a refused connection moves on without retrying the dead member",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "refused" };
    for (let i = 0; i < 10; i++) {
      const answer = await lab.ask();
      expect(answer.status, answer.body).toBe(200);
    }
    expect([first.hits, second.hits]).toEqual([1, 10]);
  },
);

labTest(
  "AC-O2 / AC-F3 a black-holed member costs one timeout, then is benched",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "black-hole" };
    const slow = await lab.ask({ stream: true });
    expect(slow.status).toBe(200);
    expect(slow.body).toContain("[DONE]");
    expect(slow.ms).toBeGreaterThanOrEqual(300);
    const fast = await lab.ask({ stream: true });
    expect(fast.providerKey).toBe(second.keyId);
    expect(fast.ms).toBeLessThan(300);
    expect(first.hits).toBe(1);
    const [failed] = await db
      .select()
      .from(schema.interactionsTable)
      .orderBy(schema.interactionsTable.createdAt);
    expect(failed).toMatchObject({
      providerApiKeyId: first.keyId,
      attemptOutcome: "failed_over",
      failureReason: "timeout (408)",
    });
  },
);

labTest(
  "AC-O2 a black-holed member also times out a non-streaming call",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "black-hole" };
    const answer = await lab.ask();
    expect(answer.status, answer.body).toBe(200);
    expect(answer.providerKey).toBe(second.keyId);
    expect(answer.attempts).toBe("2");
    expect(answer.ms).toBeGreaterThanOrEqual(300);
  },
);

labTest(
  "a slow non-streaming answer is waited on for the output the request allows",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    // Past the 300 ms floor, inside 300 ms + 20 tokens at 10 ms each.
    first.mode = { kind: "slow", ms: 400 };
    const answer = await lab.ask({ maxTokens: 20 });
    expect(answer.status, answer.body).toBe(200);
    expect(answer.providerKey).toBe(first.keyId);
    expect(answer.attempts).toBe("1");
    expect(second.hits).toBe(0);
    const rows = await db.select().from(schema.interactionsTable);
    expect(rows.map((row) => row.attemptOutcome)).toEqual(["answered"]);
  },
);

labTest(
  "a non-streaming answer slower than its output budget moves on",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    // 300 ms + 1 token at 10 ms is over before the answer comes.
    first.mode = { kind: "slow", ms: 400 };
    const answer = await lab.ask({ maxTokens: 1 });
    expect(answer.status, answer.body).toBe(200);
    expect(answer.providerKey).toBe(second.keyId);
    expect(answer.attempts).toBe("2");
    // The member read the prompt before we stopped waiting, so its row keeps
    // an estimate of that input, priced as that member.
    const [cutOff] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.attemptOutcome, "failed_over"));
    expect(cutOff).toMatchObject({
      providerApiKeyId: first.keyId,
      failureReason: "timeout (408)",
      inputTokensEstimated: true,
      outputTokens: 0,
    });
    expect(cutOff.inputTokens).toBeGreaterThan(0);
    expect(Number(cutOff.cost)).toBeGreaterThan(0);
  },
);

labTest(
  "AC-C3 every member failing returns the upstream's error, not a 429",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "status", status: 500 };
    second.mode = { kind: "status", status: 503 };
    for (let i = 0; i < 3; i++) {
      expect((await lab.ask()).status).toBeGreaterThanOrEqual(500);
    }
  },
);

labTest(
  "AC-C3 / AC-N2 a lone member's 401 stays a 401, one attempt each",
  async ({ lab }) => {
    const [only] = await lab.deploy([{ priority: 1 }]);
    only.mode = { kind: "status", status: 401 };
    for (let i = 0; i < 3; i++) expect((await lab.ask()).status).toBe(401);
    expect(only.hits).toBe(3);
  },
);

labTest("AC-N2 a refused key fails over and is benched", async ({ lab }) => {
  const [first, second] = await lab.deploy([{ priority: 1 }, { priority: 2 }]);
  first.mode = { kind: "status", status: 401 };
  for (let i = 0; i < 5; i++) expect((await lab.ask()).status).toBe(200);
  expect([first.hits, second.hits]).toEqual([1, 5]);
});

labTest(
  "AC-N1 a bad request is returned as is, with no retry and no hop",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "status", status: 400 };
    for (let i = 0; i < 3; i++) expect((await lab.ask()).status).toBe(400);
    expect([first.hits, second.hits]).toEqual([3, 0]);
  },
);

labTest(
  "AC-S1 a stream cut before its first chunk is served whole by the next member",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "cut-before-first-chunk" };
    const answer = await lab.ask({ stream: true });
    expect(answer.status).toBe(200);
    expect(answer.providerKey).toBe(second.keyId);
    expect(answer.body).toContain('"content":"hi"');
    expect(answer.body).toContain("[DONE]");
    expect(answer.body).not.toContain('"error"');
  },
);

labTest(
  "AC-S2 a stream cut after its first chunk is never reported as finished",
  async ({ lab }) => {
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "cut-after-first-chunk" };
    const answer = await lab.ask({ stream: true });
    expect(answer.body).toContain('"content":"Hal"');
    expect(answer.body).not.toContain("[DONE]");
    expect(answer.body).not.toContain('"finish_reason":"stop"');
    // Output already reached the client, so there is no second answer.
    expect(second.hits).toBe(0);
  },
);

async function respond(
  deployment: Deployment,
  request: Request,
): Promise<Response> {
  deployment.hits++;
  const { stream } = (await request.json()) as { stream?: boolean };
  const mode = deployment.mode;
  switch (mode.kind) {
    case "status":
      return HttpResponse.json(
        { error: { message: `fake ${mode.status}`, type: "fake" } },
        {
          status: mode.status,
          headers: mode.retryAfter ? { "retry-after": mode.retryAfter } : {},
        },
      );
    case "refused":
      return HttpResponse.error();
    case "black-hole":
      await new Promise((resolve) =>
        request.signal.addEventListener("abort", resolve),
      );
      return HttpResponse.error();
    case "slow":
      await new Promise((resolve) => setTimeout(resolve, mode.ms));
      return okResponse(stream);
    case "cut-before-first-chunk":
      return sse([], { cut: true });
    case "cut-after-first-chunk":
      return sse([{ content: "Hal" }], { cut: true });
    case "ok":
      return okResponse(stream);
  }
}

function okResponse(stream: boolean | undefined): Response {
  if (!stream) {
    return HttpResponse.json({
      id: "chatcmpl-lab",
      object: "chat.completion",
      created: 1,
      model: "lab-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  }
  return sse([{ role: "assistant", content: "" }, { content: "hi" }], {
    cut: false,
  });
}

/** An SSE chunk stream; `cut` errors the body instead of finishing it. */
function sse(
  deltas: Array<Record<string, unknown>>,
  { cut }: { cut: boolean },
): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: unknown, finish: string | null = null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-lab",
        object: "chat.completion.chunk",
        created: 1,
        model: "lab-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  // Pulled one part at a time, and the cut waits a moment, so the client has
  // read what came before it (erroring a stream drops whatever is queued).
  const parts = [
    ...deltas.map((delta) => chunk(delta)),
    ...(cut ? [] : [chunk({}, "stop"), encoder.encode("data: [DONE]\n\n")]),
  ];
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts.shift();
      if (part) return controller.enqueue(part);
      if (!cut) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.error(new TypeError("terminated"));
    },
  });
  return new HttpResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
