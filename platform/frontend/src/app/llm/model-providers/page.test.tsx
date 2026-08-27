"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseLlmProviderApiKeys = vi.fn();
const mockUseLlmProviderApiKey = vi.fn();
const mockLlmProviderApiKeyForm = vi.fn();
const mockUseAllVirtualApiKeys = vi.fn();
const mockUseLlmOauthClients = vi.fn();

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    actionButton,
    children,
  }: {
    actionButton?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {actionButton}
      {children}
    </div>
  ),
}));

vi.mock("next/navigation");

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useBulkDeleteLlmProviderApiKeys: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDeleteLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useLlmProviderApiKey: (...args: unknown[]) =>
    mockUseLlmProviderApiKey(...args),
  useLlmProviderApiKeys: (...args: unknown[]) =>
    mockUseLlmProviderApiKeys(...args),
  useUpdateLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-oauth-clients.query", () => ({
  useLlmOauthClients: (...args: unknown[]) => mockUseLlmOauthClients(...args),
}));

vi.mock("@/lib/organization.query");

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: (...args: unknown[]) =>
    mockUseAllVirtualApiKeys(...args),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/docs/docs", () => ({
  getFrontendDocsUrl: () => "https://example.com/docs",
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams(),
    updateQueryParams: vi.fn(),
  }),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: (props: {
    open: boolean;
    title: string;
    description?: string;
    defaultValues?: unknown;
    allowedProviders?: unknown;
  }) =>
    props.open ? (
      <div data-testid="create-dialog">
        {props.title}
        {props.description}
        {JSON.stringify(props.defaultValues)}
        {JSON.stringify(props.allowedProviders)}
      </div>
    ) : null,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({
    open,
    description,
  }: {
    open: boolean;
    description?: React.ReactNode;
  }) => (open ? <div data-testid="delete-dialog">{description}</div> : null),
}));

vi.mock("@/components/external-docs-link", () => ({
  ExternalDocsLink: ({ children }: { children: React.ReactNode }) => (
    <a href="https://example.com/docs">{children}</a>
  ),
}));

vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/llm-provider-api-key-form", () => ({
  LLM_PROVIDER_API_KEY_PLACEHOLDER: "__placeholder__",
  LlmProviderApiKeyForm: (props: unknown) => {
    mockLlmProviderApiKeyForm(props);
    return null;
  },
  deserializeExtraHeaders: () => [],
  PROVIDER_CONFIG: {
    anthropic: { icon: "/anthropic.svg", name: "Anthropic" },
    gemini: { icon: "/gemini.svg", name: "Gemini" },
    "github-copilot": {
      icon: "/github-copilot.png",
      name: "GitHub Copilot",
    },
    "microsoft-365-copilot": {
      icon: "/microsoft-365-copilot.png",
      name: "Microsoft 365 Copilot",
    },
    openai: { icon: "/openai.svg", name: "OpenAI" },
    xai: { icon: "/icons/xai.png", name: "xAI" },
  },
}));

vi.mock("@/components/llm-provider-select-items", () => ({
  LlmProviderSelectItems: () => null,
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => null,
}));

vi.mock("@/components/table-row-actions", () => ({
  TableRowActions: ({
    actions,
    itemName,
  }: {
    actions: Array<{ label: string; onClick?: () => void }>;
    itemName?: string;
  }) => (
    <>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          aria-label={`${action.label} ${itemName ?? ""}`.trim()}
        />
      ))}
    </>
  ),
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    isLoading,
    data,
    columns,
  }: {
    isLoading: boolean;
    data: Array<{ id: string; name: string }>;
    columns: Array<{
      id?: string;
      accessorKey?: string;
      cell?: (context: { row: { original: unknown } }) => React.ReactNode;
    }>;
  }) => {
    const select = columns.find((column) => column.id === "select");
    const actions = columns.find((column) => column.id === "actions");
    // The Access cell is rendered too: it is the only column besides actions
    // whose contents are asserted, and dropping it would let a blank
    // ownership cell pass unnoticed.
    const access = columns.find((column) => column.accessorKey === "scope");
    return (
      <div data-loading={isLoading}>
        {data.map((row) => (
          <div key={row.id}>
            <span>{row.name}</span>
            {select?.cell?.({
              row: {
                id: row.id,
                original: row,
                getIsSelected: () => false,
                toggleSelected: vi.fn(),
              },
              table: {},
            } as never)}
            {access?.cell?.({ row: { original: row } })}
            {actions?.cell?.({ row: { original: row } })}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogForm: ({ children }: { children: React.ReactNode }) => (
    <form>{children}</form>
  ),
  DialogStickyFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/permission-button", () => ({
  // `permissions`/`tooltip` are the component's own; everything else (notably
  // aria-label, which names an icon-only button) belongs on the button.
  PermissionButton: ({
    children,
    permissions: _permissions,
    tooltip: _tooltip,
    noPermissionHandle: _noPermissionHandle,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    permissions?: unknown;
    tooltip?: string;
    noPermissionHandle?: string;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import ApiKeysPage from "./page";

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/llm/model-providers");
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [],
      isPending: false,
    });
    mockUseLlmProviderApiKey.mockReturnValue({
      data: null,
    });
    mockUseAllVirtualApiKeys.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isPending: false,
    });
    mockUseLlmOauthClients.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isPending: false,
    });
  });

  it("does not query API keys while read permission is still loading", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: true,
    } as unknown as ReturnType<typeof useHasPermissions>);

    render(<ApiKeysPage />);

    expect(mockUseLlmProviderApiKeys).toHaveBeenCalledWith({
      enabled: false,
    });
    expect(mockUseLlmProviderApiKeys).toHaveBeenCalledWith({
      enabled: false,
      provider: undefined,
      search: undefined,
    });
  });

  it("queries API keys after read permission resolves", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    render(<ApiKeysPage />);

    expect(mockUseLlmProviderApiKeys).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(mockUseLlmProviderApiKeys).toHaveBeenCalledWith({
      enabled: true,
      provider: undefined,
      search: undefined,
    });
  });

  it("still offers subscriptions to a member who cannot read keys", () => {
    // Their key query never runs, so the cards must state the offer rather than
    // sit in a skeleton waiting on a query that will never resolve.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLlmProviderApiKeys.mockReturnValue({ data: [], isPending: true });

    render(<ApiKeysPage />);

    expect(screen.getAllByText("Connect")).toHaveLength(4);
  });

  it("lets a default member open personal API-key creation", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    render(<ApiKeysPage />);
    fireEvent.click(screen.getByTestId("add-chat-api-key-button"));

    expect(screen.getByTestId("create-dialog")).toHaveTextContent(
      "Add API Key",
    );
  });

  it("offers every registry subscription as a card above the table", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    render(<ApiKeysPage />);

    const cards = screen.getByTestId("subscription-provider-cards");
    expect(cards).toHaveTextContent("ChatGPT");
    expect(cards).toHaveTextContent("GitHub Copilot");
    expect(cards).toHaveTextContent("Microsoft 365 Copilot");
    expect(cards).toHaveTextContent("X Premium (SuperGrok)");
    expect(screen.getAllByText("Connect")).toHaveLength(4);
    expect(screen.getAllByText("Not connected")).toHaveLength(4);
  });

  it("hides a subscription whose provider the organization turned off", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { modelProviderOverrides: { xai: { hidden: true } } },
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ApiKeysPage />);

    expect(
      screen.getByTestId("subscription-provider-cards"),
    ).not.toHaveTextContent("X Premium (SuperGrok)");
    expect(screen.getAllByText("Connect")).toHaveLength(3);
  });

  it("keeps a turned-off provider's connected subscription key in the table", () => {
    // The card is withdrawn with the provider, so the key it stood for has to
    // fall back to a table row — otherwise an admin can no longer see or
    // delete a credential that still exists.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { modelProviderOverrides: { xai: { hidden: true } } },
    } as unknown as ReturnType<typeof useOrganization>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "x-premium-key",
          name: "My SuperGrok",
          provider: "xai",
          scope: "personal",
          subscriptionKind: "x-premium",
        },
      ],
      isPending: false,
    });

    render(<ApiKeysPage />);

    expect(screen.getByText("My SuperGrok")).toBeInTheDocument();
  });

  it("keeps system keys out of bulk selection", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "system-gemini",
          name: "System Gemini",
          provider: "gemini",
          scope: "org",
          isSystem: true,
          isPrimary: false,
        },
      ],
      isPending: false,
    });

    render(<ApiKeysPage />);

    expect(
      screen.getByRole("checkbox", { name: "Select System Gemini" }),
    ).toBeDisabled();
    // Subscriptions are cards now, so they never reach the table's selection.
    expect(
      screen.queryByRole("checkbox", { name: "Select ChatGPT" }),
    ).not.toBeInTheDocument();
  });

  it("represents a connected subscription once and removes its connect action", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    const chatGptCredential = {
      id: "chatgpt-key",
      name: "Existing ChatGPT credential",
      provider: "openai",
      scope: "personal",
      subscriptionKind: "chatgpt",
    };
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [chatGptCredential],
      isPending: false,
    });

    render(<ApiKeysPage />);

    expect(screen.getAllByText("ChatGPT")).toHaveLength(1);
    expect(
      screen.queryByText("Existing ChatGPT credential"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByText("Connect")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Disconnect" }),
    ).toBeInTheDocument();
  });

  it("disconnects a connected subscription through a subscription-worded dialog", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "copilot-key",
          name: "GitHub Copilot",
          provider: "github-copilot",
          scope: "personal",
        },
      ],
      isPending: false,
    });

    render(<ApiKeysPage />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    // "Delete API Key" would describe a credential the user never configured.
    await waitFor(() => {
      expect(screen.getByTestId("delete-dialog")).toHaveTextContent(
        'Disconnect "GitHub Copilot"?',
      );
    });
  });

  it("does not classify an ordinary key from the mutable X Premium display name", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "x-premium-key",
          name: "X Premium (SuperGrok)",
          provider: "xai",
          scope: "personal",
        },
      ],
      isPending: false,
    });

    render(<ApiKeysPage />);

    // The subscription card remains unconnected and the same-named ordinary key
    // remains its own credential row.
    expect(screen.getAllByText("X Premium (SuperGrok)")).toHaveLength(2);
    expect(screen.getAllByText("Connect")).toHaveLength(4);
  });

  it("reopens an X Premium key from the edit URL param in subscription mode", async () => {
    // The reviewer-reported F5 case: ?edit=<id> resolves the key through the
    // single-key endpoint, which must carry subscriptionKind so the dialog
    // reopens on the subscription auth mode, not the API-key tab.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("edit=x-premium-key") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockUseLlmProviderApiKey.mockReturnValue({
      data: {
        id: "x-premium-key",
        name: "X Premium (SuperGrok)",
        provider: "xai",
        scope: "personal",
        secretId: "secret-1",
        subscriptionKind: "x-premium",
        baseUrl: null,
        inferenceBaseUrl: null,
        extraHeaders: null,
        teamId: null,
        isPrimary: false,
      },
    });

    render(<ApiKeysPage />);

    await waitFor(() => {
      expect(mockLlmProviderApiKeyForm).toHaveBeenCalled();
    });
    const formProps = mockLlmProviderApiKeyForm.mock.lastCall?.[0] as {
      existingKey: { subscriptionKind?: string | null };
      form: { getValues: (name: string) => unknown };
    };
    expect(formProps.existingKey.subscriptionKind).toBe("x-premium");
    await waitFor(() => {
      expect(formProps.form.getValues("authMethod")).toBe("subscription");
    });
  });

  it("names who each scoped credential is accessible to", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-me" } },
    } as ReturnType<typeof useSession>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "k1",
          name: "My key",
          provider: "anthropic",
          scope: "personal",
          userId: "user-me",
          userName: "My Name",
        },
        {
          id: "k2",
          name: "Colleague key",
          provider: "anthropic",
          scope: "personal",
          userId: "user-other",
          userName: "Dana",
        },
        {
          id: "k3",
          name: "Shared key",
          provider: "anthropic",
          scope: "org",
          userId: null,
        },
      ],
      isPending: false,
    });

    render(<ApiKeysPage />);

    // The owner is the point: the backend already joins userName, and before
    // this column showed only a generic scope word for every personal key.
    expect(screen.getAllByText("Me")).toHaveLength(1);
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });

  it("points both 'View all' links at the credentials of the key being deleted", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLlmProviderApiKeys.mockReturnValue({
      data: [
        {
          id: "provider-key-1",
          name: "Shared Anthropic credential",
          provider: "anthropic",
          scope: "org",
        },
      ],
      isPending: false,
    });
    mockUseAllVirtualApiKeys.mockReturnValue({
      data: {
        data: [
          { id: "vk-1", name: "Payments service", tokenStart: "arch_abc" },
        ],
        pagination: { total: 1 },
      },
      isPending: false,
    });
    mockUseLlmOauthClients.mockReturnValue({
      data: {
        data: [{ id: "oc-1", name: "Nimbus Portal", clientId: "llm_oauth_1" }],
        pagination: { total: 1 },
      },
      isPending: false,
    });

    render(<ApiKeysPage />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete Shared Anthropic credential",
      }),
    );

    // The whole point of these links: land on a table already narrowed to the
    // credentials that are blocking this delete, not on the full list.
    await waitFor(() => {
      expect(screen.getByTestId("delete-dialog")).toBeInTheDocument();
    });
    const links = screen.getAllByRole("link", { name: "View all" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/llm/proxy/virtual-keys?providerApiKeyId=provider-key-1",
      "/llm/proxy/oauth-clients?providerApiKeyId=provider-key-1",
    ]);
  });

  it("opens Connect with provider-specific subscription defaults", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    render(<ApiKeysPage />);

    fireEvent.click(screen.getAllByText("Connect")[0]);

    expect(screen.getByTestId("create-dialog")).toHaveTextContent(
      "Sign in with ChatGPT",
    );
    expect(screen.getByTestId("create-dialog")).toHaveTextContent(
      '"authMethod":"subscription"',
    );
    expect(screen.getByTestId("create-dialog")).toHaveTextContent('["openai"]');
  });

  it("uses the registry's X-specific connect copy", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    render(<ApiKeysPage />);

    fireEvent.click(screen.getAllByText("Connect")[3]);

    expect(screen.getByTestId("create-dialog")).toHaveTextContent(
      "Sign in with X",
    );
    expect(screen.getByTestId("create-dialog")).toHaveTextContent(
      "Connect the X account that holds your X Premium (SuperGrok) subscription",
    );
  });
});
