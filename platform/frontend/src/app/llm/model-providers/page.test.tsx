"use client";

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseLlmProviderApiKeys = vi.fn();

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useDeleteLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useLlmProviderApiKeys: (...args: unknown[]) =>
    mockUseLlmProviderApiKeys(...args),
  useUpdateLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-oauth-clients.query", () => ({
  useLlmOauthClients: () => ({
    data: [],
    isPending: false,
  }),
}));

vi.mock("@/lib/organization.query");

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: () => ({
    data: {
      data: [],
      pagination: { total: 0 },
    },
    isPending: false,
  }),
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
  CreateLlmProviderApiKeyDialog: () => null,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
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
  LlmProviderApiKeyForm: () => null,
  PROVIDER_CONFIG: {
    anthropic: { icon: "/anthropic.svg", name: "Anthropic" },
    gemini: { icon: "/gemini.svg", name: "Gemini" },
    openai: { icon: "/openai.svg", name: "OpenAI" },
  },
}));

vi.mock("@/components/llm-provider-select-items", () => ({
  LlmProviderSelectItems: () => null,
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => null,
}));

vi.mock("@/components/table-row-actions", () => ({
  TableRowActions: () => null,
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({ isLoading }: { isLoading: boolean }) => (
    <div data-loading={isLoading} />
  ),
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
  PermissionButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
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

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import ApiKeysPage from "./page";

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
