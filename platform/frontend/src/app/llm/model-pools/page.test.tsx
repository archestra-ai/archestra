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
  describe,
  expect,
  it,
  vi,
} from "vitest";

const API_ORIGIN = "http://localhost:9000";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

import { notFound, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import ModelPoolsPage from "./page";

let providerKeys: Record<string, unknown>[] = [];
let pools: Record<string, unknown>[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json(providerKeys),
  ),
  http.get(`${API_ORIGIN}/api/model-pools`, () => HttpResponse.json(pools)),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function pool(name: string, members: { enabled: boolean }[]) {
  const now = new Date().toISOString();
  return {
    id: `pool-${name}`,
    organizationId: "org",
    name,
    createdAt: now,
    updatedAt: now,
    virtualApiKeyIds: [],
    members: members.map((member, index) => ({
      id: `${name}-member-${index}`,
      poolId: `pool-${name}`,
      providerApiKeyId: `key-${index}`,
      providerApiKeyName: `Z.ai ${index}`,
      provider: "zhipuai",
      modelId: name,
      priority: 1,
      weight: 1,
      enabled: member.enabled,
      createdAt: now,
      benchedUntil: null,
      benchReason: null,
    })),
  };
}

function renderPage(query = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelPoolsPage />
    </QueryClientProvider>,
  );
}

describe("ModelPoolsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerKeys = [
      { id: "key-0", name: "Z.ai", provider: "zhipuai", userId: null },
    ];
    pools = [];
    vi.mocked(useFeature).mockImplementation(
      ((name: string) => name === "llmModelPoolsEnabled") as typeof useFeature,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
  });

  it("is not there while model pools are off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    renderPage();
    expect(notFound).toHaveBeenCalled();
    expect(screen.queryByText("Model Pools")).not.toBeInTheDocument();
  });

  it("asks for a provider a pool can serve when the only shared key is on another", async () => {
    providerKeys = [
      { id: "key-0", name: "Gemini", provider: "gemini", userId: null },
    ];
    renderPage();
    expect(
      await screen.findByText("Connect your first model provider"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create pool" }),
    ).not.toBeInTheDocument();
  });

  it("counts a pool with every member off as not healthy", async () => {
    pools = [
      pool("glm-5", [{ enabled: true }]),
      pool("glm-4.6", [{ enabled: false }]),
    ];
    renderPage("status=healthy");
    expect(await screen.findByText("glm-5")).toBeInTheDocument();
    expect(screen.queryByText("glm-4.6")).not.toBeInTheDocument();
  });
});
