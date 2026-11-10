/**
 * The LiteLLM lab's acceptance criteria (research panel C), run against
 * Archestra's model pools through the Model Router. Each deployment is a fake
 * OpenAI-compatible upstream whose behaviour a test sets; its hit count is
 * the ground truth, as in the lab. Criteria that need load, replicas or
 * latency routing (AC-Q1, AC-O1, AC-L1, AC-M1, AC-M2) are left out.
 */

import type { ModelPoolRetrySettings } from "@archestra/shared/model-pool-retries";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import LimitModel from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import ModelModel from "@/models/model";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import modelRouterRoutes from "./model-router";
import vllmProxyRoutes from "./vllm";

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
  | {
      kind: "status";
      status: number;
      retryAfter?: string;
      recoverAfter?: number;
      code?: string;
    }
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
      members: Array<{
        priority: number;
        weight?: number;
        retrySettings?: ModelPoolRetrySettings;
      }>,
      retrySettings?: ModelPoolRetrySettings,
    ) => Promise<Deployment[]>;
    ask: (options?: {
      stream?: boolean;
      maxTokens?: number;
      retryHeader?: string;
    }) => Promise<{
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
      members: Array<{
        priority: number;
        weight?: number;
        retrySettings?: ModelPoolRetrySettings;
      }>,
      retrySettings?: ModelPoolRetrySettings,
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
      const pool = await ModelPoolModel.create({
        organizationId: org.id,
        input: {
          name: "lab-model",
          retrySettings,
          members: members.map((member, index) => ({
            providerApiKeyId: deployments[index].keyId,
            modelId: "lab-model",
            priority: member.priority,
            weight: member.weight ?? 1,
            enabled: true,
            retrySettings: member.retrySettings,
          })),
        },
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: org.id,
        virtualApiKeyId: virtual.virtualKey.id,
        poolIds: [pool.id],
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
      retryHeader,
    }: {
      stream?: boolean;
      maxTokens?: number;
      retryHeader?: string;
    } = {}) => {
      const started = Date.now();
      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/chat/completions`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(retryHeader !== undefined
            ? { "x-archestra-num-retries": retryHeader }
            : {}),
        },
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

labTest.for([false, true])(
  "configured retries reselect the next healthy member before output (stream=%s)",
  async (stream, { lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 2, initialDelayMs: 100, maxDelayMs: 100 },
    );
    first.mode = { kind: "status", status: 503, recoverAfter: 2 };
    const answer = await lab.ask({ stream });
    expect(answer.status, answer.body).toBe(200);
    expect(answer.providerKey).toBe(second.keyId);
    expect(answer.attempts).toBe("2");
    expect([first.hits, second.hits]).toEqual([1, 1]);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .orderBy(schema.interactionsTable.createdAt);
    expect(rows.map((row) => row.attemptOutcome)).toEqual([
      "failed_over",
      "answered",
    ]);
  },
);

labTest(
  "configured connection errors reselect a healthy deployment",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      {
        numRetries: 0,
        retryPolicy: { connectionError: 1 },
        initialDelayMs: 100,
      },
    );
    first.mode = { kind: "refused" };
    const answer = await lab.ask();
    expect(answer.status, answer.body).toBe(200);
    expect([first.hits, second.hits]).toEqual([1, 1]);
  },
);

labTest(
  "group retry budget does not reset when the selected deployment or error changes",
  async ({ lab }) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const [first, second, third] = await lab.deploy(
        [
          {
            priority: 1,
            retrySettings: { retryPolicy: { rateLimitError: 1 } },
          },
          { priority: 1, retrySettings: { numRetries: 10 } },
          { priority: 1 },
        ],
        { numRetries: 4, initialDelayMs: 100, maxDelayMs: 100 },
      );
      first.mode = { kind: "status", status: 429 };
      second.mode = { kind: "status", status: 503 };
      const answer = await lab.ask();
      expect(answer.status).toBe(503);
      expect(answer.attempts).toBe("2");
      expect([first.hits, second.hits, third.hits]).toEqual([1, 1, 0]);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.createdAt);
      expect(rows.map((row) => row.attemptOutcome)).toEqual([
        "failed_over",
        "failed",
      ]);
    } finally {
      random.mockRestore();
    }
  },
);

labTest.for([undefined, "0"])(
  "zero retries does not sweep same-order siblings, but preserves later-order fallback (header=%s)",
  async (retryHeader, { lab }) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const [first, sibling, fallback] = await lab.deploy(
        [{ priority: 1 }, { priority: 1 }, { priority: 2 }],
        { numRetries: retryHeader ? 3 : 0, initialDelayMs: 100 },
      );
      first.mode = { kind: "status", status: 503 };
      const answer = await lab.ask({ retryHeader });
      expect(answer.status).toBe(200);
      expect([first.hits, sibling.hits, fallback.hits]).toEqual([1, 0, 1]);
    } finally {
      random.mockRestore();
    }
  },
);

labTest(
  "retry selection stays in the lowest healthy order and preserves weighted selection",
  async ({ lab }) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const [first, light, heavy, fallback] = await lab.deploy(
        [
          { priority: 1 },
          { priority: 1, weight: 1 },
          { priority: 1, weight: 9 },
          { priority: 2 },
        ],
        { numRetries: 1, initialDelayMs: 100 },
      );
      first.mode = { kind: "status", status: 503 };
      // Initial plan selects the first member. Its network response changes
      // the next random draw; a fixed precomputed member sweep would pick light.
      server.use(
        http.post(`${first.origin}/chat/completions`, ({ request }) => {
          random.mockReturnValue(0.5);
          return respond(first, request);
        }),
      );
      const answer = await lab.ask();
      expect(answer.status).toBe(200);
      expect([first.hits, light.hits, heavy.hits, fallback.hits]).toEqual([
        1, 0, 1, 0,
      ]);
    } finally {
      random.mockRestore();
    }
  },
);

labTest(
  "a later-order fallback starts its own budget and cannot return to a healthy earlier order",
  async ({ lab }) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const [first, skipped, fallback, sibling] = await lab.deploy(
        [
          { priority: 1 },
          { priority: 1 },
          { priority: 2, retrySettings: { numRetries: 1 } },
          { priority: 2 },
        ],
        { numRetries: 0, initialDelayMs: 100 },
      );
      first.mode = fallback.mode = { kind: "status", status: 503 };
      const answer = await lab.ask();
      expect(answer.status).toBe(200);
      expect([first.hits, skipped.hits, fallback.hits, sibling.hits]).toEqual([
        1, 0, 1, 1,
      ]);
    } finally {
      random.mockRestore();
    }
  },
);

labTest(
  "a retry-selected final plan member still times out while a healthy sibling can answer",
  async ({ lab }) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const [first, healthy, slow] = await lab.deploy(
        [{ priority: 1 }, { priority: 1 }, { priority: 1 }],
        { numRetries: 2, initialDelayMs: 100, maxDelayMs: 100 },
      );
      first.mode = { kind: "status", status: 503 };
      slow.mode = { kind: "black-hole" };
      server.use(
        http.post(`${first.origin}/chat/completions`, ({ request }) => {
          random.mockReturnValue(0.9);
          return respond(first, request);
        }),
      );
      const answer = await lab.ask({ stream: true });
      expect(answer.status).toBe(200);
      expect(answer.providerKey).toBe(healthy.keyId);
      expect([first.hits, healthy.hits, slow.hits]).toEqual([1, 1, 1]);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.createdAt);
      expect(rows.map((row) => row.failureReason)).toEqual([
        "server_error (503)",
        "timeout (408)",
        null,
      ]);
      expect(rows.map((row) => row.attemptOutcome)).toEqual([
        "failed_over",
        "failed_over",
        "answered",
      ]);
    } finally {
      random.mockRestore();
    }
  },
);

labTest(
  "configured retries do not resurrect cooling deployments to fill the budget",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 4, initialDelayMs: 100, maxDelayMs: 100 },
    );
    first.mode = second.mode = { kind: "status", status: 503 };
    expect((await lab.ask()).status).toBe(503);
    expect([first.hits, second.hits]).toEqual([1, 1]);
    expect((await lab.ask()).status).toBe(503);
    expect([first.hits, second.hits]).toEqual([1, 1]);
  },
);

labTest(
  "a bounded Retry-After is honored before retrying the same member",
  async ({ lab }) => {
    const [only] = await lab.deploy([{ priority: 1 }], {
      numRetries: 1,
      initialDelayMs: 100,
      maxDelayMs: 1500,
    });
    only.mode = {
      kind: "status",
      status: 429,
      retryAfter: "1",
      recoverAfter: 1,
    };
    const answer = await lab.ask();
    expect(answer.status, answer.body).toBe(200);
    expect(only.hits).toBe(2);
    expect(answer.ms).toBeGreaterThanOrEqual(1000);
  },
);

labTest(
  "a member default count still inherits pool error overrides",
  async ({ lab }) => {
    const [only] = await lab.deploy(
      [{ priority: 1, retrySettings: { numRetries: 0 } }],
      {
        numRetries: 0,
        retryPolicy: { rateLimitError: 1 },
        initialDelayMs: 100,
      },
    );
    only.mode = { kind: "status", status: 429, recoverAfter: 1 };
    const answer = await lab.ask();
    expect(answer.status, answer.body).toBe(200);
    expect(only.hits).toBe(2);
  },
);

labTest(
  "member and error-class settings override pool retry counts",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [
        { priority: 1, retrySettings: { retryPolicy: { rateLimitError: 0 } } },
        { priority: 2, retrySettings: { numRetries: 1 } },
      ],
      { numRetries: 3, initialDelayMs: 100, maxDelayMs: 100 },
    );
    first.mode = { kind: "status", status: 429 };
    second.mode = { kind: "status", status: 503 };
    const answer = await lab.ask();
    expect(answer.status).toBe(503);
    expect(answer.attempts).toBe("2");
    expect([first.hits, second.hits]).toEqual([1, 1]);
  },
);

labTest.for(["0", "2"])(
  "request retry header %s overrides an error-class budget",
  async (retryHeader, { lab }) => {
    const [only] = await lab.deploy([{ priority: 1 }], {
      numRetries: 1,
      retryPolicy: { rateLimitError: 4 },
      initialDelayMs: 100,
      maxDelayMs: 100,
    });
    only.mode = { kind: "status", status: 429 };
    const answer = await lab.ask({ retryHeader });
    expect(answer.status).toBe(429);
    expect(only.hits).toBe(Number(retryHeader) + 1);
  },
);

labTest.for(["-1", "11", "1.5", "two"])(
  "invalid retry header %s is rejected before dispatch",
  async (retryHeader, { lab }) => {
    const [only] = await lab.deploy([{ priority: 1 }]);
    const answer = await lab.ask({ retryHeader });
    expect(answer.status, answer.body).toBe(400);
    expect(only.hits).toBe(0);
  },
);

labTest.for([
  { status: 400, code: undefined, backup: 0 },
  { status: 401, code: undefined, backup: 1 },
  { status: 429, code: "insufficient_quota", backup: 1 },
])(
  "configured retries never replay permanent failures ($status, $code)",
  async ({ status, code, backup }, { lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 3 },
    );
    first.mode = { kind: "status", status, code };
    await lab.ask();
    expect([first.hits, second.hits]).toEqual([1, backup]);
  },
);

labTest(
  "Retry-After longer than the backoff cap fails over without waiting",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 2, initialDelayMs: 100, maxDelayMs: 100 },
    );
    first.mode = { kind: "status", status: 429, retryAfter: "3600" };
    const answer = await lab.ask();
    expect(answer.status, answer.body).toBe(200);
    expect([first.hits, second.hits]).toEqual([1, 1]);
  },
);

labTest(
  "configured timeout retries switch deployments and account for the cut-off",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 1, initialDelayMs: 100, maxDelayMs: 100 },
    );
    first.mode = { kind: "black-hole" };
    const answer = await lab.ask({ stream: true });
    expect(answer.status, answer.body).toBe(200);
    expect([first.hits, second.hits]).toEqual([1, 1]);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.attemptOutcome, "failed_over"));
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.failureReason).toBe("timeout (408)");
      expect(row.inputTokensEstimated).toBe(true);
      expect(row.inputTokens).toBeGreaterThan(0);
    }
  },
);

labTest(
  "configured retries never replay a stream after its first chunk",
  async ({ lab }) => {
    const [first, second] = await lab.deploy(
      [{ priority: 1 }, { priority: 2 }],
      { numRetries: 3 },
    );
    first.mode = { kind: "cut-after-first-chunk" };
    const answer = await lab.ask({ stream: true });
    expect(answer.body).toContain('"content":"Hal"');
    expect(answer.body).not.toContain("[DONE]");
    expect([first.hits, second.hits]).toEqual([1, 0]);
  },
);

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
    config.llmProxy.streamKeepAliveIntervalMs = 30;
    const [first, second] = await lab.deploy([
      { priority: 1 },
      { priority: 2 },
    ]);
    first.mode = { kind: "black-hole" };
    const slow = await lab.ask({ stream: true });
    expect(slow.status).toBe(200);
    expect(slow.body).toContain("[DONE]");
    expect(slow.attempts).toBe("2");
    expect(slow.providerKey).toBe(second.keyId);
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

test.for([
  { provider: "vllm" as const, restricted: false },
  { provider: "vllm" as const, restricted: true },
  { provider: "openai" as const, restricted: false },
  { provider: "openai" as const, restricted: true },
])("pool failover resolves and prices the selected Fireworks endpoint ($provider, restricted=$restricted)", async ({
  provider,
  restricted,
}, { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey }) => {
  const canonical = "accounts/fireworks/models/glm-5p3-flash";
  const short = "glm-5p3-flash";
  const selfHosted = "https://self-hosted.example.test/v1";
  const fireworks = "https://api.fireworks.ai/inference/v1";
  config.llm.vllm.enabled = true;
  config.llm[provider].baseUrl = selfHosted;
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "agent",
  });
  const keys = [];
  for (const [index, baseUrl] of [selfHosted, fireworks].entries()) {
    keys.push(
      await makeLlmProviderApiKey(
        org.id,
        (await makeSecret({ secret: { apiKey: `synthetic-pool-${index}` } }))
          .id,
        { provider, baseUrl },
      ),
    );
  }
  const virtual = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Fireworks pool client",
    ...accessGrants("org"),
    providerApiKeys: [{ provider, providerApiKeyId: keys[0].id }],
  });
  const pool = await ModelPoolModel.create({
    organizationId: org.id,
    input: {
      name: "pooled-model",
      members: keys.map((key, index) => ({
        providerApiKeyId: key.id,
        modelId: short,
        priority: index + 1,
        weight: 1,
        enabled: true,
      })),
    },
  });
  await ModelPoolModel.setPoolsForVirtualApiKey({
    organizationId: org.id,
    virtualApiKeyId: virtual.virtualKey.id,
    poolIds: [pool.id],
  });
  const model = await ModelModel.create({
    externalId: `${provider}/${canonical}`,
    provider,
    modelId: canonical,
    inputModalities: ["text"],
    outputModalities: ["text"],
    // A transport-wide catalog price must not replace the selected seller's.
    promptPricePerToken: "0.00009",
    completionPricePerToken: "0.00009",
    cacheReadPricePerToken: "0.00009",
  });
  if (restricted) {
    const policyKey = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const current = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: current?.revision ?? 0,
      grants: [],
    });
  }
  modelsDevClient.clearFetchCache();
  const calls: Array<{ endpoint: string; model: string }> = [];
  server.use(
    http.get("https://models.dev/api.json", () =>
      HttpResponse.json({
        "other-seller": {
          id: "other-seller",
          name: "Other seller",
          models: {
            [canonical]: {
              id: canonical,
              name: "GLM fixture",
              cost: { input: 90, output: 90, cache_read: 90 },
            },
          },
        },
        "fireworks-ai": {
          id: "fireworks-ai",
          name: "Fireworks",
          models: {
            [canonical]: {
              id: canonical,
              name: "GLM fixture",
              cost: { input: 2, output: 8, cache_read: 0.5 },
            },
          },
        },
      }),
    ),
    http.post(`${selfHosted}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as { model: string };
      calls.push({ endpoint: selfHosted, model: body.model });
      return HttpResponse.json(
        { error: { message: "Fixture capacity exhausted" } },
        { status: 429, headers: { "retry-after": "10" } },
      );
    }),
    http.post(`${fireworks}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as { model: string };
      calls.push({ endpoint: fireworks, model: body.model });
      return HttpResponse.json({
        id: "chatcmpl-fireworks-pool",
        object: "chat.completion",
        created: 1,
        model: canonical,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1400,
          completion_tokens: 500,
          total_tokens: 1900,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      });
    }),
  );
  const app = createFastifyInstance();
  await app.register(modelRouterRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: { authorization: `Bearer ${virtual.value}` },
      payload: {
        model: "pooled-model",
        messages: [{ role: "user", content: "Fixture request" }],
      },
    });
    expect(response.statusCode, response.body).toBe(restricted ? 403 : 200);
    expect(calls).toEqual([
      { endpoint: selfHosted, model: short },
      ...(restricted ? [] : [{ endpoint: fireworks, model: canonical }]),
    ]);
    const rows = await db.select().from(schema.interactionsTable);
    expect(
      rows.filter((row) => row.attemptOutcome === "answered"),
    ).toHaveLength(restricted ? 0 : 1);
    if (restricted) {
      expect(response.body).toContain(canonical);
    } else {
      expect(response.headers["x-archestra-provider-key"]).toBe(keys[1].id);
      expect(response.headers["x-archestra-attempts"]).toBe("2");
      expect(
        rows.find((row) => row.attemptOutcome === "answered"),
      ).toMatchObject({
        providerApiKeyId: keys[1].id,
        model: canonical,
        inputTokens: 1000,
        cacheReadTokens: 400,
        outputTokens: 500,
        cost: "0.0062000000",
      });
      expect(
        rows.find((row) => row.attemptOutcome === "failed_over"),
      ).toMatchObject({
        providerApiKeyId: keys[0].id,
        model: short,
        cost: "0.0000000000",
      });
    }
  } finally {
    await app.close();
    modelsDevClient.clearFetchCache();
  }
});

test("a Fireworks-first named pool applies the canonical member's spend cap", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const canonical = "accounts/fireworks/models/glm-5p3-flash";
  const fireworks = "https://api.fireworks.ai/inference/v1";
  config.llm.vllm.enabled = true;
  config.llm.vllm.baseUrl = fireworks;
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "llm_proxy",
  });
  const key = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "synthetic-fireworks-pool" } })).id,
    { provider: "vllm", baseUrl: fireworks },
  );
  const virtual = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Capped pool client",
    ...accessGrants("org"),
    providerApiKeys: [{ provider: "vllm", providerApiKeyId: key.id }],
  });
  const pool = await ModelPoolModel.create({
    organizationId: org.id,
    input: {
      name: "named-fireworks-pool",
      members: [
        {
          providerApiKeyId: key.id,
          modelId: "glm-5p3-flash",
          priority: 1,
          weight: 1,
          enabled: true,
        },
      ],
    },
  });
  await ModelPoolModel.setPoolsForVirtualApiKey({
    organizationId: org.id,
    virtualApiKeyId: virtual.virtualKey.id,
    poolIds: [pool.id],
  });
  const cap = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 1,
    model: [canonical],
  });
  modelsDevClient.clearFetchCache();
  const dispatched: string[] = [];
  server.use(
    http.get("https://models.dev/api.json", () =>
      HttpResponse.json({
        "fireworks-ai": {
          id: "fireworks-ai",
          name: "Fireworks",
          models: {
            [canonical]: {
              id: canonical,
              name: "GLM fixture",
              cost: { input: 2, output: 8, cache_read: 0.5 },
            },
          },
        },
      }),
    ),
    http.post(`${fireworks}/chat/completions`, async ({ request }) => {
      dispatched.push(((await request.json()) as { model: string }).model);
      return HttpResponse.json({
        id: "chatcmpl-capped-pool",
        object: "chat.completion",
        created: 1,
        model: canonical,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
        },
      });
    }),
  );
  const app = createFastifyInstance();
  await app.register(vllmProxyRoutes);
  const ask = () =>
    app.inject({
      method: "POST",
      url: `/v1/vllm/${agent.id}/chat/completions`,
      headers: { authorization: `Bearer ${virtual.value}` },
      payload: {
        model: "named-fireworks-pool",
        messages: [{ role: "user", content: "Fixture request" }],
      },
    });
  try {
    // The pool name is not a Fireworks model alias; planning must resolve its
    // member before endpoint alias validation sees the canonical spend cap.
    const response = await ask();
    expect(response.statusCode, response.body).toBe(200);
    expect(dispatched).toEqual([canonical]);
    expect(response.headers["x-archestra-provider-key"]).toBe(key.id);
    await drainBackgroundWork();
    const rows = await db.select().from(schema.interactionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: canonical,
      providerApiKeyId: key.id,
      cost: "0.0060000000",
    });
    const usage = await LimitModel.getModelUsageBreakdowns([cap.id]);
    expect(usage.get(cap.id)).toEqual([
      { model: canonical, tokensIn: 1000, tokensOut: 500, cost: 0.006 },
    ]);
    await LimitModel.patch(cap.id, { limitValue: 0 });
    const refused = await ask();
    expect(refused.statusCode, refused.body).toBe(402);
    expect(refused.json().error).toMatchObject({
      type: "usage_limit_exceeded",
      code: "token_cost_limit_exceeded",
    });
    expect(dispatched).toEqual([canonical]);
  } finally {
    await app.close();
    modelsDevClient.clearFetchCache();
  }
});

test.for([
  { memberModel: "unknown-deployment", status: 400, stream: false },
  { memberModel: "unknown-deployment", status: 400, stream: true },
  { memberModel: "glm-5p3-flash", status: 403, stream: false },
  { memberModel: "glm-5p3-flash", status: 403, stream: true },
])("a first Fireworks member rejected with $status releases its unsent request allowance (stream=$stream)", async ({
  memberModel,
  status,
  stream,
}, { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey }) => {
  const canonical = "accounts/fireworks/models/glm-5p3-flash";
  const fireworks = "https://api.fireworks.ai/inference/v1";
  config.llm.vllm.enabled = true;
  config.llm.vllm.baseUrl = fireworks;
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "llm_proxy",
  });
  const key = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "synthetic-unsent-pool" } })).id,
    { provider: "vllm", baseUrl: fireworks },
  );
  const virtual = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Unsent pool client",
    ...accessGrants("org"),
    providerApiKeys: [{ provider: "vllm", providerApiKeyId: key.id }],
  });
  const pool = await ModelPoolModel.create({
    organizationId: org.id,
    input: {
      name: "guarded-fireworks-pool",
      members: [
        {
          providerApiKeyId: key.id,
          modelId: memberModel,
          priority: 1,
          weight: 1,
          enabled: true,
        },
      ],
    },
  });
  await ModelPoolModel.setPoolsForVirtualApiKey({
    organizationId: org.id,
    virtualApiKeyId: virtual.virtualKey.id,
    poolIds: [pool.id],
  });
  const requestCap = await LimitModel.create({
    entityType: "virtual_key",
    entityId: virtual.virtualKey.id,
    limitType: "requests",
    cleanupInterval: "calendar_day",
    limitValue: 1,
  });
  await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 1,
    model: [canonical],
  });
  if (status === 403) {
    const model = await ModelModel.create({
      externalId: `vllm/${canonical}`,
      provider: "vllm",
      modelId: canonical,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const policyKey = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const current = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: current?.revision ?? 0,
      grants: [],
    });
  }
  modelsDevClient.clearFetchCache();
  let dispatched = 0;
  server.use(
    http.get("https://models.dev/api.json", () =>
      HttpResponse.json({
        "fireworks-ai": {
          id: "fireworks-ai",
          name: "Fireworks",
          models: {
            [canonical]: {
              id: canonical,
              name: "GLM fixture",
              cost: { input: 2, output: 8 },
            },
          },
        },
      }),
    ),
    http.post(`${fireworks}/chat/completions`, () => {
      dispatched++;
      return HttpResponse.json(
        { error: { message: "Unexpected dispatch" } },
        { status: 500 },
      );
    }),
  );
  const app = createFastifyInstance();
  await app.register(vllmProxyRoutes);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: { authorization: `Bearer ${virtual.value}` },
        payload: {
          model: "guarded-fireworks-pool",
          stream,
          messages: [{ role: "user", content: "Fixture request" }],
        },
      });
      // A leaked reservation would turn the second rejection into quota 429.
      expect(response.statusCode, response.body).toBe(status);
      const usage = await LlmThroughputModel.usage([requestCap]);
      expect(usage.get(requestCap.id)?.currentUsage ?? 0).toBe(0);
    }
    expect(dispatched).toBe(0);
  } finally {
    await app.close();
    modelsDevClient.clearFetchCache();
  }
});

async function respond(
  deployment: Deployment,
  request: Request,
): Promise<Response> {
  deployment.hits++;
  const { stream } = (await request.json()) as { stream?: boolean };
  const mode = deployment.mode;
  switch (mode.kind) {
    case "status":
      if (
        mode.recoverAfter !== undefined &&
        deployment.hits > mode.recoverAfter
      )
        return okResponse(stream);
      return HttpResponse.json(
        {
          error: {
            message: `fake ${mode.status}`,
            type: "fake",
            code: mode.code,
          },
        },
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
