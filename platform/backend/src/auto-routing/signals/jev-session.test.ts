import { delay, HttpResponse, http } from "msw";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { JevSessionSource } from "./jev-session";
import { JEV_SESSION_SPEC } from "./spec";
import { SignalSourceError } from "./types";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const ANSWERS = {
  model: "jev-1.13.0",
  answers: {
    tier_needed: {
      type: "score",
      score: 1.1,
      confidence: 0.6,
      probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
    },
    long_context: { type: "noul", noul: 0.35 },
  },
  usage: { input_tokens: 420, output_tokens: 6 },
};

const INPUT = {
  firstUserText: "Refactor the billing module and fix the flaky tests",
  client: "opencode",
};

async function expectSourceError(
  promise: Promise<unknown>,
  reason: SignalSourceError["reason"],
) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignalSourceError);
  expect((error as SignalSourceError).reason).toBe(reason);
}

describe("JevSessionSource", () => {
  const server = useMswServer();
  const source = new JevSessionSource();
  let organizationId: string;
  const ctx = () => ({ organizationId });

  beforeEach(
    async ({ makeOrganization, makeSecret, makeLlmProviderApiKey }) => {
      organizationId = (await makeOrganization()).id;
      const secret = await makeSecret({ secret: { apiKey: "sk-typesafe" } });
      await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "jev",
      });
    },
  );

  test("asks the session questions and parses the answers", async () => {
    const requests: { authorization: string | null; body: unknown }[] = [];
    server.use(
      http.post(TYPESAFE_ENDPOINT, async ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json(ANSWERS);
      }),
    );

    const result = await source.read(INPUT, ctx());

    expect(result.tierNeeded[0]).toBeCloseTo(0.2, 12);
    expect(result.tierNeeded[1]).toBeCloseTo(0.5, 12);
    expect(result.tierNeeded[2]).toBeCloseTo(0.3, 12);
    expect(result).toMatchObject({ pLong: 0.35, costUsd: null });
    expect(requests).toEqual([
      {
        authorization: "Bearer sk-typesafe",
        body: {
          model: JEV_SESSION_SPEC.model,
          state: { prompt: INPUT.firstUserText },
          questions: JEV_SESSION_SPEC.questions,
        },
      },
    ]);
  });

  test("renormalizes rounded probabilities and reports upstream cost", async () => {
    server.use(
      http.post(TYPESAFE_ENDPOINT, () =>
        HttpResponse.json({
          ...ANSWERS,
          answers: {
            ...ANSWERS.answers,
            tier_needed: {
              type: "score",
              probabilities: { "0": 0.33, "1": 0.33, "2": 0.335 },
            },
          },
          usage: { ...ANSWERS.usage, cost: 0.0004 },
        }),
      ),
    );

    const result = await source.read(INPUT, ctx());

    expect(result.tierNeeded.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(result.costUsd).toBe(0.0004);
  });

  test("posts to the endpoint the organization's key points at", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const openRouter = "https://openrouter.ai/api/alpha/decisions";
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-or-v1" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "jev",
      baseUrl: openRouter,
    });
    server.use(http.post(openRouter, () => HttpResponse.json(ANSWERS)));

    const result = await source.read(INPUT, { organizationId: org.id });

    expect(result.pLong).toBe(0.35);
  });

  test("times out after the configured budget", async () => {
    config.autoRouting.scorerTimeoutMs = 50;
    server.use(
      http.post(TYPESAFE_ENDPOINT, async () => {
        await delay("infinite");
        return HttpResponse.json(ANSWERS);
      }),
    );

    await expectSourceError(source.read(INPUT, ctx()), "timeout");
  });

  test("reports an HTTP error with its status", async () => {
    server.use(
      http.post(TYPESAFE_ENDPOINT, () =>
        HttpResponse.json({ detail: "rate limited" }, { status: 429 }),
      ),
    );

    const error = await source.read(INPUT, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SignalSourceError);
    expect(error).toMatchObject({ reason: "http", status: 429 });
  });

  test.each([
    ["a non-JSON body", () => new HttpResponse("<html>", { status: 200 })],
    [
      "a missing answer",
      () =>
        HttpResponse.json({
          ...ANSWERS,
          answers: { tier_needed: ANSWERS.answers.tier_needed },
        }),
    ],
    [
      "probabilities that are not a distribution",
      () =>
        HttpResponse.json({
          ...ANSWERS,
          answers: {
            ...ANSWERS.answers,
            tier_needed: {
              type: "score",
              probabilities: { "0": 0.9, "1": 0.9 },
            },
          },
        }),
    ],
  ])("rejects %s as an invalid response", async (_, respond) => {
    server.use(http.post(TYPESAFE_ENDPOINT, respond));

    await expectSourceError(source.read(INPUT, ctx()), "invalid_response");
  });

  test("fails without a Jev key before calling upstream", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expectSourceError(
      source.read(INPUT, { organizationId: org.id }),
      "no_credentials",
    );
  });

  test("redacts secrets in the clipped prompt", async () => {
    let state: unknown;
    server.use(
      http.post(TYPESAFE_ENDPOINT, async ({ request }) => {
        state = ((await request.json()) as { state: unknown }).state;
        return HttpResponse.json(ANSWERS);
      }),
    );
    const tail = "step ".repeat(1000);
    const text = `use sk-${"a".repeat(30)} then ${tail}`;
    const redacted = `use <redacted> then ${tail}`;

    await source.read({ firstUserText: text, client: null }, ctx());

    expect(state).toEqual({
      prompt: `${redacted.slice(0, 3000)}\n…[${redacted.length - 4000} chars omitted]…\n${redacted.slice(-1000)}`,
    });
  });
});
