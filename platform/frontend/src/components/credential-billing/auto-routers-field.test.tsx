import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AutoRoutersField } from "./auto-routers-field";

const API_ORIGIN = "http://localhost:9000";
const tier = (modelId: string) => ({
  id: `tier-${modelId}`,
  provider: "openai",
  modelId,
  apiKey: { id: "key", name: "Shared" },
});
const router = (id: string, name: string, overrides: object) => ({
  id,
  name,
  enabled: true,
  virtualApiKeyIds: [],
  tiers: {
    fast: tier("gpt-5-mini"),
    normal: tier("gpt-5.4"),
    smart: tier("gpt-6"),
  },
  ...overrides,
});
const routers = [
  router("00000000-0000-4000-8000-0000000000a1", "auto", {}),
  router("00000000-0000-4000-8000-0000000000a2", "auto:draft", {
    tiers: { fast: null, normal: tier("gpt-5.4"), smart: null },
  }),
];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/routers/available`, () =>
    HttpResponse.json(
      routers.map(({ id, name }) => ({ id, name, virtualApiKeyIds: [] })),
    ),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
    HttpResponse.json(routers),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderField(value: string[]) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AutoRoutersField value={value} onChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("AutoRoutersField", () => {
  it("marks an added router that cannot route yet", async () => {
    renderField(routers.map((r) => r.id));

    expect(await screen.findByText("Tiers not set")).toBeVisible();
    expect(
      screen.getAllByText(/Tiers not set|Auto routing is off/),
    ).toHaveLength(1);
  });

  it("marks every added router while auto routing is off", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
        HttpResponse.json(routers.map((r) => ({ ...r, enabled: false }))),
      ),
    );
    renderField(routers.map((r) => r.id));

    expect(await screen.findAllByText("Auto routing is off")).toHaveLength(2);
  });
});
