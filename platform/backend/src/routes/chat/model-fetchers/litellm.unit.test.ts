import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { fetchLiteLlmPricing } from "./litellm";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer();
const params = {
  baseUrl: "https://gateway.example.test/proxy/v1/",
  apiKey: "fixture-key",
};

test("preserves USD per-token precision, explicit zero, and unknown directions", async () => {
  server.use(
    http.get("https://gateway.example.test/proxy/v1/model/info", () =>
      HttpResponse.json({
        data: [
          {
            model_name: "alias",
            model_info: {
              input_cost_per_token: "1.4e-8",
              output_cost_per_token: 0,
              cache_read_input_token_cost: "0.0000000035",
            },
          },
          {
            model_name: "unknown",
            model_info: {
              input_cost_per_token: -1,
              output_cost_per_token: "NaN",
              cache_read_input_token_cost: "",
              cache_creation_input_token_cost: true,
            },
          },
        ],
      }),
    ),
  );
  const prices = await fetchLiteLlmPricing(params);
  expect(prices.get("alias")).toEqual({
    promptPricePerToken: "1.4e-8",
    completionPricePerToken: "0",
    cacheReadPricePerToken: "3.5e-9",
    cacheWritePricePerToken: null,
  });
  expect(prices.get("unknown")).toEqual({
    promptPricePerToken: null,
    completionPricePerToken: null,
    cacheReadPricePerToken: null,
    cacheWritePricePerToken: null,
  });
});

test("does not choose a deployment rate arbitrarily for a load-balanced alias", async () => {
  server.use(
    http.get("https://gateway.example.test/proxy/v1/model/info", () =>
      HttpResponse.json({
        data: [
          {
            model_name: "mixed",
            model_info: { input_cost_per_token: 0.000001 },
          },
          {
            model_name: "mixed",
            model_info: { input_cost_per_token: 0.000002 },
          },
          {
            model_name: "same",
            model_info: { input_cost_per_token: 0.000001 },
          },
          {
            model_name: "same",
            model_info: { input_cost_per_token: 0.000001 },
          },
        ],
      }),
    ),
  );
  const prices = await fetchLiteLlmPricing(params);
  expect(prices.get("mixed")?.promptPricePerToken).toBeNull();
  expect(prices.get("same")?.promptPricePerToken).toBe("0.000001");
});

test.each([
  401, 403, 404, 500,
])("metadata HTTP %i leaves ordinary discovery available", async (status) => {
  server.use(
    http.get(
      "https://gateway.example.test/proxy/v1/model/info",
      () => new HttpResponse(null, { status }),
    ),
  );
  expect(await fetchLiteLlmPricing(params)).toEqual(new Map());
});

test("invalid JSON and incompatible payloads do not break discovery", async () => {
  for (const body of [
    "invalid-json",
    JSON.stringify({ data: "not-an-array" }),
  ]) {
    server.use(
      http.get(
        "https://gateway.example.test/proxy/v1/model/info",
        () => new HttpResponse(body),
      ),
    );
    expect(await fetchLiteLlmPricing(params)).toEqual(new Map());
  }
});

test("does not forward credentials to a metadata redirect", async () => {
  server.use(
    http.get(
      "https://gateway.example.test/proxy/v1/model/info",
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.test/secret" },
        }),
    ),
  );
  expect(await fetchLiteLlmPricing(params)).toEqual(new Map());
});

test("does not probe the public OpenAI API for LiteLLM metadata", async () => {
  expect(
    await fetchLiteLlmPricing({
      ...params,
      baseUrl: "https://api.openai.com/v1",
    }),
  ).toEqual(new Map());
});
