import { archestraApiClient } from "@archestra/shared";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type AutoRoutingSettings,
  useAutoRoutingAvailable,
} from "./auto-routing.query";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

const API_ORIGIN = "http://localhost:9000";

const tier = (index: number) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  provider: "anthropic" as const,
  modelId: `model-${index}`,
});

function makeSettings(
  overrides: Partial<AutoRoutingSettings> = {},
): AutoRoutingSettings {
  return {
    enabled: true,
    budgetUsdPerDay: 20,
    tiers: { fast: tier(1), normal: tier(2), smart: tier(3) },
    generation: 1,
    plannedGeneration: 1,
    status: {
      activePlan: null,
      coldStart: {
        scorerVersionId: "00000000-0000-4000-8000-000000000009",
        sessions: 0,
        required: 100,
      },
      lastFitError: null,
      scorer: "ready",
    },
    ...overrides,
  };
}

let settings: AutoRoutingSettings;
let settingsReads = 0;

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/settings`, () => {
    settingsReads += 1;
    return HttpResponse.json(settings);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  settings = makeSettings();
  settingsReads = 0;
  vi.mocked(useFeature).mockImplementation(
    ((feature: string) =>
      feature === "autoRoutingEnabled") as typeof useFeature,
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderAvailability() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAutoRoutingAvailable(), { wrapper });
}

describe("useAutoRoutingAvailable", () => {
  it("is available once routing is on and every tier is set", async () => {
    const { result } = renderAvailability();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is unavailable while routing is off", async () => {
    settings = makeSettings({ enabled: false });
    const { result } = renderAvailability();
    await waitFor(() => expect(settingsReads).toBe(1));
    expect(result.current).toBe(false);
  });

  it("is unavailable while a tier of the organization trio is unset", async () => {
    settings = makeSettings({
      tiers: { fast: tier(1), normal: tier(2), smart: null },
    });
    const { result } = renderAvailability();
    await waitFor(() => expect(settingsReads).toBe(1));
    expect(result.current).toBe(false);
  });

  it("reads nothing when the deployment has no auto routing", () => {
    vi.mocked(useFeature).mockReturnValue(false as never);
    const { result } = renderAvailability();
    expect(result.current).toBe(false);
    expect(settingsReads).toBe(0);
  });

  it("reads nothing without permission to see the settings", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    const { result } = renderAvailability();
    expect(result.current).toBe(false);
    expect(settingsReads).toBe(0);
  });
});
