import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { ProviderKeyList } from "./provider-key-list";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");

const origin = "http://localhost:9000";
const server = setupServer();
const KEYS = [
  { id: "pk-main", name: "Main OpenAI", provider: "openai", isPrimary: true },
  {
    id: "pk-spare",
    name: "Spare OpenAI",
    provider: "openai",
    isPrimary: false,
  },
] as LlmProviderApiKeyResponse[];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useOrganization).mockReturnValue({
    data: { modelProviderOverrides: null },
  } as unknown as ReturnType<typeof useOrganization>);
});

it("counts each key's models from the per-key read, not the model catalog", async () => {
  server.use(
    http.get(`${origin}/api/llm-models/key-model-ids`, () =>
      HttpResponse.json([
        { apiKeyId: "pk-main", modelIds: ["gpt-a", "gpt-b"] },
        { apiKeyId: "pk-spare", modelIds: ["gpt-a"] },
      ]),
    ),
  );

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProviderKeyList
        alwaysOpen
        value={[{ provider: "openai", providerApiKeyId: "pk-main" }]}
        onChange={vi.fn()}
        providerApiKeys={KEYS}
      />
    </QueryClientProvider>,
  );

  expect(await screen.findByText(/Main OpenAI · 2 models/)).toBeVisible();
});
