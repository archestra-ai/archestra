import client from "prom-client";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  getObservableFetch,
  initializeMetrics,
  reportLLMCost,
  reportLLMTokens,
} from "./llm";
import { type LlmMetricsCaller, llmMetricsCallerScope } from "./llm-caller";

const caller: LlmMetricsCaller = {
  user: { id: "user-1", email: "ada@example.com" },
  virtualKey: { id: "key-1", name: "ci-runner" },
};

describe("LLM metric caller labels", () => {
  beforeEach(() => {
    // Exemplar-enabled metrics register only on an OpenMetrics registry, as
    // the server configures it.
    setRegistryContentType(client.Registry.OPENMETRICS_CONTENT_TYPE);
  });

  afterEach(() => {
    // Metrics state is module-level; leave the default registration behind.
    initializeMetrics([]);
    setRegistryContentType(client.Registry.PROMETHEUS_CONTENT_TYPE);
  });

  test("labels the counters with the request's user and virtual key", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    initializeMetrics([], {
      callerLabels: { user: true, virtualKey: true },
    });

    llmMetricsCallerScope.run(caller, () => {
      reportLLMTokens(
        "openai",
        agent,
        { input: 10, output: 5 },
        "gpt-4o",
        "api",
      );
      reportLLMCost({
        provider: "openai",
        profile: agent,
        model: "gpt-4o",
        cost: 0.25,
        source: "api",
        billingMode: "metered",
      });
    });

    const callerLabels = {
      user_id: "user-1",
      user_email: "ada@example.com",
      virtual_key_id: "key-1",
      virtual_key_name: "ci-runner",
    };
    expect(await metricValues("llm_tokens_total")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({ ...callerLabels, type: "input" }),
          value: 10,
        }),
      ]),
    );
    expect(await metricValues("llm_cost_total")).toEqual([
      expect.objectContaining({
        labels: expect.objectContaining({
          ...callerLabels,
          billing_mode: "metered",
        }),
        value: 0.25,
      }),
    ]);
    // The token-size histogram is not split by caller.
    for (const { labels } of await metricValues("llm_token_usage")) {
      expect(labels).not.toHaveProperty("user_id");
    }
  });

  test("counts upstream requests per caller, but not their durations", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    initializeMetrics([], { callerLabels: { user: false, virtualKey: true } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );

    await llmMetricsCallerScope.run(caller, () =>
      getObservableFetch(
        "openai",
        agent,
        "api",
      )("https://api.openai.com/v1", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o" }),
      }),
    );

    const [request] = await metricValues("llm_requests_total");
    expect(request.labels).toMatchObject({
      status_code: "200",
      virtual_key_id: "key-1",
      virtual_key_name: "ci-runner",
    });
    // Only the enabled group is added.
    expect(request.labels).not.toHaveProperty("user_id");
    for (const { labels } of await metricValues(
      "llm_request_duration_seconds",
    )) {
      expect(labels).not.toHaveProperty("virtual_key_id");
    }
  });

  test("leaves the labels empty for a call without a caller", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    initializeMetrics([], { callerLabels: { user: true, virtualKey: true } });

    reportLLMTokens("openai", agent, { input: 3 }, "gpt-4o", "api");

    const [tokens] = await metricValues("llm_tokens_total");
    expect(tokens.labels).toMatchObject({
      user_id: "",
      user_email: "",
      virtual_key_id: "",
      virtual_key_name: "",
    });
  });

  test("adds no caller labels unless enabled", async ({ makeAgent }) => {
    const agent = await makeAgent();
    initializeMetrics([]);

    llmMetricsCallerScope.run(caller, () =>
      reportLLMTokens("openai", agent, { input: 3 }, "gpt-4o", "api"),
    );

    const [tokens] = await metricValues("llm_tokens_total");
    expect(Object.keys(tokens.labels).sort()).toEqual([
      "agent_id",
      "agent_name",
      "agent_type",
      "model",
      "organization_id",
      "provider",
      "source",
      "type",
    ]);
  });
});

async function metricValues(name: string) {
  const metric = client.register.getSingleMetric(name);
  if (!metric) throw new Error(`${name} is not registered`);
  return (await metric.get()).values;
}

function setRegistryContentType(type: string) {
  // The default registry is typed for one content type but accepts both.
  (client.register.setContentType as (type: string) => void)(type);
}
