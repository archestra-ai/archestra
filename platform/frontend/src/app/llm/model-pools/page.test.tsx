import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
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
  http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json([])),
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
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "owner" } },
    } as ReturnType<typeof useSession>);
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
      { id: "key-0", name: "Cohere", provider: "cohere", userId: null },
    ];
    renderPage();
    expect(
      await screen.findByText("Connect your first model provider"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create pool" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    "Gemini API key",
    "Vertex AI (Gemini)",
  ])("allows pool creation with the existing shared %s credential", async (name) => {
    providerKeys = [
      {
        id: "gemini-key",
        name,
        provider: "gemini",
        userId: null,
        secretId: name.startsWith("Vertex") ? null : "secret",
        isSystem: name.startsWith("Vertex"),
      },
    ];
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Create pool" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Connect your first model provider"),
    ).not.toBeInTheDocument();
  });

  it.each([
    "github-copilot",
    "openai",
    "xai",
  ])("allows pool creation with an owned %s subscription", async (provider) => {
    providerKeys = [
      {
        id: "subscription-key",
        name: "Subscription",
        provider,
        userId: "owner",
      },
    ];
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Create pool" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Connect your first model provider"),
    ).not.toBeInTheDocument();
  });

  it("does not offer another user's subscription as the first pool connection", async () => {
    providerKeys = [
      {
        id: "other-subscription",
        name: "Subscription",
        provider: "github-copilot",
        userId: "other",
      },
    ];
    renderPage();
    expect(
      await screen.findByText("Connect your first model provider"),
    ).toBeInTheDocument();
  });

  it("offers the owned Copilot connection in the member editor and explains its scope", async () => {
    providerKeys = [
      {
        id: "copilot-owned",
        name: "My Copilot",
        provider: "github-copilot",
        userId: "owner",
      },
      {
        id: "copilot-other",
        name: "Other Copilot",
        provider: "github-copilot",
        userId: "other",
      },
    ];
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Create pool" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Add member" }),
    );
    expect(await within(dialog).findByText("My Copilot")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Personal connections stay private"),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Provider key" }),
    );
    expect(screen.queryByText("Other Copilot")).not.toBeInTheDocument();
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
