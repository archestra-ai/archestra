import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationDefaultModel } from "./use-organization-default-model";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({ label: () => "Anthropic" }),
}));

type Summary = archestraApiTypes.GetOrganizationDefaultModelResponses["200"];

const API_ORIGIN = "http://localhost:9000";
const tier = (index: number, displayName: string) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  provider: "anthropic" as const,
  displayName,
});
const TIERS = {
  fast: tier(1, "Haiku"),
  normal: tier(2, "Sonnet"),
  smart: tier(3, "Opus"),
};

let summary: Summary;

const server = setupServer(
  http.get(`${API_ORIGIN}/api/organization/default-model`, () =>
    HttpResponse.json(summary),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "member-1" } },
  } as ReturnType<typeof useSession>);
  // A member who may not read models or the auto-routing settings.
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderDefaultModel(followsRouting?: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOrganizationDefaultModel({ followsRouting }), {
    wrapper,
  });
}

describe("useOrganizationDefaultModel", () => {
  it("names the three tiers while auto routing is active", async () => {
    summary = {
      model: TIERS.normal,
      autoRouting: { active: true, tiers: TIERS },
    };
    const { result } = renderDefaultModel();
    await waitFor(() => expect(result.current.label).not.toBeNull());
    expect(result.current.label).toMatch(/Haiku.*Sonnet.*Opus/);
  });

  it("names the default model while auto routing is off", async () => {
    summary = { model: TIERS.normal, autoRouting: { active: false } };
    const { result } = renderDefaultModel();
    await waitFor(() =>
      expect(result.current.label).toBe("Anthropic · Sonnet"),
    );
  });

  it("names only the default model for an agent auto routing skips", async () => {
    summary = {
      model: TIERS.normal,
      autoRouting: { active: true, tiers: TIERS },
    };
    const { result } = renderDefaultModel(false);
    await waitFor(() =>
      expect(result.current.label).toBe("Anthropic · Sonnet"),
    );
  });
});
