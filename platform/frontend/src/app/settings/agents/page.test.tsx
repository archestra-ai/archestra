"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
let mockApiKeys: Array<{
  id: string;
  name: string;
  provider: string;
  scope: string;
}> = [];
let mockAgents: Array<{ id: string; name: string; icon?: string | null }> = [];

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/chat-api-key-form", () => ({
  PROVIDER_CONFIG: {
    vertex_ai: {
      icon: "/vertex.svg",
      name: "Vertex AI",
    },
    openai: {
      icon: "/openai.svg",
      name: "OpenAI",
    },
  },
}));

vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: ({
    value,
    placeholder,
  }: {
    value: string;
    placeholder: string;
  }) => <div>{value || placeholder}</div>,
}));

vi.mock("@/components/llm-provider-options", () => ({
  LlmProviderApiKeyOptionLabel: ({
    providerName,
    keyName,
  }: {
    providerName: string;
    keyName: string;
  }) => (
    <span>
      {providerName} {keyName}
    </span>
  ),
  LlmProviderApiKeySelectItems: () => null,
}));

vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (args: { hasPermission: boolean }) => React.ReactNode;
  }) => children({ hasPermission: true }),
}));

vi.mock("@/components/settings/settings-block", () => ({
  SettingsBlock: ({
    title,
    description,
    control,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      <div>{control}</div>
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSaveBar: ({ hasChanges }: { hasChanges: boolean }) =>
    hasChanges ? <div>Unsaved changes</div> : null,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ value }: { value: string }) => <div>{value}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({
    children,
    placeholder,
  }: {
    children?: React.ReactNode;
    placeholder?: string;
  }) => <span>{children ?? placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/agent.query", () => ({
  useOrgScopedAgents: () => ({
    data: mockAgents,
  }),
}));

vi.mock("@/lib/chat-models.query", () => ({
  useChatModels: () => ({
    data: [
      {
        id: "gemini-2.5-pro",
        provider: "vertex_ai",
        displayName: "Gemini 2.5 Pro",
      },
    ],
    isPending: false,
  }),
}));

vi.mock("@/lib/chat-settings.query", () => ({
  useAvailableChatApiKeys: () => ({
    data: mockApiKeys,
  }),
}));

const mutateAsync = vi.fn();

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
  }),
  useUpdateAgentSettings: () => ({
    mutateAsync,
    isPending: false,
  }),
  useUpdateSecuritySettings: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

import AgentSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrganization = {
    defaultLlmModel: "gemini-2.5-pro",
    defaultLlmProvider: "vertex_ai",
    defaultLlmApiKeyId: "key-1",
    defaultAgentId: null,
    globalToolPolicy: "permissive",
    allowChatFileUploads: true,
  };
  mockApiKeys = [
    {
      id: "key-1",
      name: "gemini - org_wide",
      provider: "vertex_ai",
      scope: "org_wide",
    },
  ];
  mockAgents = [];
});

describe("AgentSettingsPage", () => {
  it("lets users reset the org default model selection", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByText("Select API key first...")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
