import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useScopedCapabilities, useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import {
  OAuthClientAccessFields,
  type OAuthClientFormValues,
  oauthClientFormBody,
  oauthClientFormReady,
} from "./configuration-fields";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: vi.fn(),
  // The key pickers' per-key model counts.
  useLlmModelIdsByKey: () => ({ data: [], isPending: false }),
}));

const PROVIDER_KEYS = [
  {
    id: "pk-main",
    name: "Main OpenAI",
    provider: "openai",
    scope: "org",
    isPrimary: true,
  },
] as LlmProviderApiKeyResponse[];
const MAPPING = { provider: "openai" as const, providerApiKeyId: "pk-main" };
const StableProviderFields = memo(OAuthClientAccessFields);

function ProviderForm({
  initial,
  surface = "create",
  onSave,
}: {
  initial?: Partial<OAuthClientFormValues>;
  surface?: "create" | "edit";
  onSave: (body: ReturnType<typeof oauthClientFormBody>) => void;
}) {
  const form = useForm<OAuthClientFormValues>({
    defaultValues: {
      name: "Automation client",
      grantType: "client_credentials",
      scopes: ["llm:proxy"],
      providerApiKeys: [MAPPING],
      allowedGatewayIds: [],
      redirectUrisText: "",
      ...initial,
    },
  });
  const values = form.watch();

  return (
    <form
      onSubmit={form.handleSubmit((submitted) =>
        onSave(oauthClientFormBody(submitted, [])),
      )}
    >
      <Label htmlFor="client-name">Name</Label>
      <Input id="client-name" {...form.register("name")} />
      <StableProviderFields
        form={form}
        gateways={[]}
        showServiceAccount={false}
        providerApiKeys={PROVIDER_KEYS}
        providerAccessSurface={surface}
      />
      <Button type="submit" disabled={!oauthClientFormReady(values)}>
        <span>Save client</span>
      </Button>
    </form>
  );
}

function renderProviders(
  props: Omit<Parameters<typeof ProviderForm>[0], "onSave"> = {},
) {
  const onSave = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderForm {...props} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { onSave };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useScopedCapabilities>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
});

describe("OAuth provider access", () => {
  it("shows model guidance beside the provider on hover", async () => {
    const user = userEvent.setup();
    renderProviders();
    expect(
      screen.queryByText(/no models on the chosen key/),
    ).not.toBeInTheDocument();
    await user.hover(
      screen.getByRole("button", { name: "OpenAI: no models discovered" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "This key has no discovered models.",
    );
  });

  it.each([
    { resource: "llmProviderApiKey", action: "use", scope: "pk-main" },
    { resource: "llmProviderApiKey", action: "read", scope: "*" },
    { resource: "llmVirtualKey", action: "use", scope: "*" },
  ])("does not grant future access from $resource/$action/$scope", async (grant) => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [grant],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    const user = userEvent.setup();
    const { onSave } = renderProviders();

    const automatic = screen.getByRole("radio", {
      name: /Current and future providers/,
    });
    expect(automatic).toBeDisabled();
    await user.click(automatic);
    await user.click(screen.getByRole("button", { name: "Save client" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          includeFutureProviders: false,
          providerApiKeys: [MAPPING],
        }),
      ),
    );
  });

  it("uses automatic access without freezing previously selected keys", async () => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [{ resource: "llmProviderApiKey", action: "use", scope: "*" }],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    const user = userEvent.setup();
    const { onSave } = renderProviders();

    expect(
      screen.getByRole("radiogroup", { name: "LLM provider access" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("radio", { name: /Current and future providers/ }),
    );
    expect(screen.getByRole("button", { name: "Save client" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save client" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          includeFutureProviders: true,
          providerApiKeys: [],
        }),
      ),
    );

    await user.click(screen.getByRole("radio", { name: /Selected providers/ }));
    expect(screen.getByRole("button", { name: "Save client" })).toBeDisabled();
  });

  it("submits explicit key overrides alongside automatic access", async () => {
    const user = userEvent.setup();
    const { onSave } = renderProviders({
      surface: "edit",
      initial: { includeFutureProviders: true, providerApiKeys: [] },
    });

    await user.click(screen.getByRole("button", { name: /API keys/ }));
    await user.click(screen.getByRole("button", { name: "Add OpenAI" }));
    await user.click(screen.getByRole("button", { name: "Save client" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          includeFutureProviders: true,
          providerApiKeys: [MAPPING],
        }),
      ),
    );
  });

  it("preserves an existing automatic mode when renaming without a wildcard grant", async () => {
    const user = userEvent.setup();
    const { onSave } = renderProviders({
      surface: "edit",
      initial: { includeFutureProviders: true, providerApiKeys: [] },
    });

    const automatic = screen.getByRole("radio", {
      name: /Current and future providers/,
    });
    expect(automatic).toBeChecked();
    expect(automatic).toBeEnabled();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed client");
    await user.click(screen.getByRole("button", { name: "Save client" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Renamed client",
          includeFutureProviders: true,
          providerApiKeys: [],
        }),
      ),
    );
  });

  it("uses each user's own access and clears stale automatic mode on user sign-in", async () => {
    const user = userEvent.setup();
    const { onSave } = renderProviders({
      initial: {
        grantType: "authorization_code",
        redirectUrisText: "https://app.example.com/callback",
        includeFutureProviders: true,
      },
    });

    expect(
      screen.getByRole("region", { name: "LLM provider access" }),
    ).toBeVisible();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save client" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      includeFutureProviders: false,
      redirectUris: ["https://app.example.com/callback"],
    });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("providerApiKeys");
  });

  it("does not let automatic LLM access bypass the gateway requirement", () => {
    const values: OAuthClientFormValues = {
      name: "Combined client",
      grantType: "client_credentials",
      scopes: ["mcp", "llm:proxy"],
      includeFutureProviders: true,
      providerApiKeys: [],
      allowedGatewayIds: [],
      redirectUrisText: "",
    };

    expect(oauthClientFormReady(values)).toBe(false);
    values.allowedGatewayIds = ["gateway-1"];
    expect(oauthClientFormReady(values)).toBe(true);
    values.scopes = ["mcp"];
    expect(oauthClientFormBody(values, [])).toMatchObject({
      includeFutureProviders: false,
      allowedGatewayIds: ["gateway-1"],
    });
  });
});
