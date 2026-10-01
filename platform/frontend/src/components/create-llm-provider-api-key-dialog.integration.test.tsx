import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { CreateLlmProviderApiKeyDialog } from "./create-llm-provider-api-key-dialog";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([]),
  ),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("CreateLlmProviderApiKeyDialog integration", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockReturnValue(
      false as ReturnType<typeof useFeature>,
    );
    vi.mocked(useProviderBaseUrls).mockReturnValue({
      data: {},
    } as ReturnType<typeof useProviderBaseUrls>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  it("keeps the generic title for a multi-provider form after an equivalent refresh", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderDialog = (allowedProviders: ["anthropic", "openai"]) => (
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={allowedProviders}
        />
      </QueryClientProvider>
    );

    const view = render(renderDialog(["anthropic", "openai"]));
    view.rerender(renderDialog(["anthropic", "openai"]));

    expect(screen.getByRole("dialog", { name: "Add API Key" })).toBeVisible();
    expect(screen.getByLabelText("Provider")).toBeVisible();
  });

  it("names a generic single-provider form after its visible provider", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={["openai"]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "Add OpenAI API Key" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  });

  it("omits providers outside the runtime allowlist from the picker", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={["anthropic", "bedrock", "openai"]}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByLabelText("Provider"));

    expect(
      screen.getByRole("option", { name: /Anthropic/ }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("option", { name: /AWS Bedrock/ }),
    ).not.toBeDisabled();
    expect(screen.getByRole("option", { name: /OpenAI/ })).not.toBeDisabled();
    expect(
      screen.queryByRole("option", { name: /Gemini/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps creation simple when choosing a shared key", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Create a provider key"
          allowedProviders={["anthropic"]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Permissions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Shared" }));
    expect(screen.getByRole("tab", { name: "Shared" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Permissions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test & Create" })).toBeVisible();
  });

  it("submits endpoint settings from Advanced without leaving the creation form", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    const requests: unknown[] = [];
    server.use(
      http.post(
        `${API_ORIGIN}/api/llm-provider-api-keys`,
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json({ id: "created-key" });
        },
      ),
    );
    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={onOpenChange}
          onSuccess={onSuccess}
          title="Add API Key"
          description="Create a provider key"
          allowedProviders={["anthropic"]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Connectivity" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^API Key/), "test-provider-key");
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.getByLabelText(/Base URL/)).toBeVisible();
    expect(screen.getByText("Extra HTTP headers")).toBeVisible();
    await user.type(
      screen.getByLabelText(/Base URL/),
      "https://gateway.example.com",
    );
    await user.click(screen.getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header name"), "X-Gateway");
    await user.type(screen.getByLabelText("Header value"), "test-value");
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test & Create" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("created-key"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(requests).toEqual([
      expect.objectContaining({
        apiKey: "test-provider-key",
        baseUrl: "https://gateway.example.com",
        extraHeaders: { "X-Gateway": "test-value" },
      }),
    ]);
  });
});
