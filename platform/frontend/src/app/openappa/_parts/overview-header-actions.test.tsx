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
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import type { GuardrailsMode } from "@/lib/guardrails-deployment.query";
import { OverviewHeaderActions } from "./overview-header-actions";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
const api = "http://localhost:9000/api";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "openappaEnabled",
  );
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function showIn(mode: GuardrailsMode) {
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({
        mode,
        enabled: mode !== "off",
        active: mode !== "off",
        featureEnabled: true,
      }),
    ),
    http.get(`${api}/guardrails-policy`, () =>
      HttpResponse.json({
        organizationId: "org",
        revision: 1,
        content: "",
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OverviewHeaderActions />
    </QueryClientProvider>,
  );
}

test.each([
  ["off", "Enforcement off"],
  ["observe", "Observe only"],
  ["enforce", "Enforcement on"],
] as const)("the header names the %s mode", async (mode, label) => {
  showIn(mode);
  expect(await screen.findByText(label)).toBeInTheDocument();
});

test("under Observe the header never reads as enforcing", async () => {
  showIn("observe");
  await screen.findByText("Observe only");
  expect(screen.queryByText("Enforcement on")).not.toBeInTheDocument();
});
