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
let mockAgents: Array<{
  id: string;
  name: string;
  icon?: string | null;
  agentType: "agent";
  scope: "personal" | "team" | "org";
  authorEmail?: string | null;
}> = [];
const mockAgentSelector = vi.fn(
  ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <div>{value || placeholder}</div>
  ),
);

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/llm-provider-api-key-form", () => ({
  PROVIDER_CONFIG: {
    vertex_ai: {
      icon: "/vertex.svg",
      name: "Vertex AI",
    },
    openai: {
      icon: "/openai.svg",
      name: "OpenAI",
    },
    openrouter: {
      icon: "/openrouter.svg",
      name: "OpenRouter",
    },
  },
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

vi.mock("@/components/agent-selector", () => ({
  AgentSelector: (props: Record<string, unknown>) =>
    mockAgentSelector(props as { value: string }),
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

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: [
      {
        id: "gemini-2.5-pro",
        dbId: "gemini-2.5-pro",
        provider: "vertex_ai",
        displayName: "Gemini 2.5 Pro",
      },
    ],
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({
    data: mockApiKeys,
  }),
}));

const mutateAsync = vi.fn();

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
  }),
  useAppearanceSettings: () => ({
    data: {
      appName: "Spark",
    },
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
    defaultModelId: "gemini-2.5-pro",
    defaultLlmApiKeyId: "key-1",
    defaultAgentId: null,
    globalToolPolicy: "permissive",
    allowChatFileUploads: true,
  };
  mockApiKeys = [
    {
      id: "key-1",
      name: "gemini - org",
      provider: "vertex_ai",
      scope: "org",
    },
  ];
  mockAgents = [];
});

describe("AgentSettingsPage", () => {
  it("lets users reset the org default model selection", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByText("Gemini 2.5 Pro")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByText("Select API key first...")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("hides the free-model filter for non-OpenRouter API keys", () => {
    renderPage();

    expect(screen.queryByText("Free models only")).not.toBeInTheDocument();
  });

  it("shows the free-model filter for OpenRouter API keys", () => {
    mockApiKeys = [
      {
        id: "key-1",
        name: "openrouter - org",
        provider: "openrouter",
        scope: "org",
      },
    ];

    renderPage();

    expect(screen.getByText("Free models only")).toBeInTheDocument();
  });

  it("uses the shared agent selector for the default agent dropdown", () => {
    mockAgents = [
      {
        id: "agent-1",
        name: "Agent Builder Agent",
        icon: "🧰",
        agentType: "agent",
        scope: "org",
      },
    ];

    renderPage();

    const agentSelectorCall = mockAgentSelector.mock.calls.find(
      ([props]) =>
        (props as { searchPlaceholder?: string }).searchPlaceholder ===
        "Search agents...",
    );
    expect(agentSelectorCall).toBeDefined();

    const props = agentSelectorCall?.[0] as unknown as {
      mode: string;
      agents: typeof mockAgents;
      personalDefaultOption: { value: string; label: string };
    };

    expect(props.mode).toBe("single");
    expect(props.agents).toEqual(mockAgents);
    expect(props.personalDefaultOption).toMatchObject({
      value: "__personal__",
      label: "User's personal agent",
    });
  });
});
