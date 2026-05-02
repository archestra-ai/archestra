import type { AgentTemplate } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTemplateCreateFlow } from "./agent-template-create-flow";

const { toastWarningMock, toastErrorMock } = vi.hoisted(() => ({
  toastWarningMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

const executeMock = vi.fn();
const triggerInstallByCatalogIdAndWaitMock = vi.fn();
const triggerInstallByCatalogIdMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    warning: toastWarningMock,
    error: toastErrorMock,
    success: vi.fn(),
  },
}));

vi.mock("@/lib/agent-templates.query", () => ({
  useAgentTemplateRequirements: vi.fn(),
}));

vi.mock("@/lib/use-template-execution", () => ({
  useTemplateExecution: () => ({
    execute: executeMock,
    orchestrator: {
      triggerInstallByCatalogId: triggerInstallByCatalogIdMock,
      triggerInstallByCatalogIdAndWait: triggerInstallByCatalogIdAndWaitMock,
    },
  }),
}));

vi.mock("@/components/chat/mcp-install-dialogs", () => ({
  McpInstallDialogs: () => null,
}));

const { useAgentTemplateRequirements } = await import(
  "@/lib/agent-templates.query"
);

const template: AgentTemplate = {
  id: "code-reviewer",
  name: "Code Reviewer",
  description: "Reviews repositories and issues.",
  type: "agent",
  categories: ["engineering"],
  systemPrompt: "Review carefully.",
  llmModel: null,
  tools: ["github__search_repositories", "slack__send_message"],
  labels: [{ key: "template", value: "code-reviewer" }],
  icon: "🔎",
};

const baseRequirements = {
  templateId: "code-reviewer",
  agentConfig: {
    name: "Code Reviewer",
    description: "Reviews repositories and issues.",
    systemPrompt: "Review carefully.",
    llmModel: null,
    labels: [{ key: "template", value: "code-reviewer" }],
    agentType: "agent" as const,
    scope: "personal" as const,
    teams: [],
  },
  toolAssignments: [
    {
      toolId: "tool-github",
      catalogId: "github-catalog",
      credentialResolutionMode: "static" as const,
      requiresUserConfig: true,
    },
    {
      toolId: "tool-slack",
      catalogId: "slack-catalog",
      credentialResolutionMode: "dynamic" as const,
      requiresUserConfig: false,
    },
  ],
  missingCatalogs: [
    {
      catalogId: "github-catalog",
      catalogName: "github",
      serverType: "remote" as const,
      requiresOauth: false,
      userConfigFields: [
        {
          key: "token",
          type: "string" as const,
          title: "Token",
          description: "API token",
          required: true,
          sensitive: true,
        },
      ],
      environmentFields: [
        {
          key: "GITHUB_HOST",
          type: "plain_text" as const,
          promptOnInstallation: true,
          description: "Host override",
        },
      ],
      canAutoInstall: false,
    },
    {
      catalogId: "slack-catalog",
      catalogName: "slack",
      serverType: "remote" as const,
      requiresOauth: false,
      userConfigFields: [],
      environmentFields: [],
      canAutoInstall: true,
    },
  ],
  unavailableTools: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("AgentTemplateCreateFlow", () => {
  const onOpenChangeMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(undefined);
    vi.mocked(useAgentTemplateRequirements).mockReturnValue({
      data: baseRequirements,
      isPending: false,
    } as unknown as ReturnType<typeof useAgentTemplateRequirements>);
  });

  it("renders config form fields for manual catalogs and calls execute with form values", async () => {
    const user = userEvent.setup();

    render(
      <AgentTemplateCreateFlow
        open
        template={template}
        onOpenChange={onOpenChangeMock}
      />,
      { wrapper: createWrapper() },
    );

    const tokenLabel = screen.getByText("Token");
    expect(tokenLabel).toBeInTheDocument();
    const hostLabel = screen.getByText("GITHUB_HOST");
    expect(hostLabel).toBeInTheDocument();

    const tokenInput = screen
      .getByRole("textbox", {
        name: /GITHUB_HOST/i,
      })
      .parentElement?.parentElement?.querySelector(
        'input[name="github-catalog::userConfig::token"]',
      ) as HTMLElement | null;
    if (tokenInput) {
      await user.type(tokenInput, "secret-token");
    }
    await user.type(
      screen.getByRole("textbox", { name: /GITHUB_HOST/i }),
      "github.example.com",
    );
    await user.click(screen.getByRole("button", { name: /Create Agent/i }));

    await waitFor(() => {
      expect(executeMock).toHaveBeenCalledWith({
        requirements: baseRequirements,
        formValues: expect.objectContaining({
          "github-catalog::userConfig::token": "secret-token",
          "github-catalog::environment::GITHUB_HOST": "github.example.com",
        }),
        onOpenChange: onOpenChangeMock,
      });
    });
  });

  it("auto-executes when no prompted fields exist", async () => {
    vi.mocked(useAgentTemplateRequirements).mockReturnValue({
      data: {
        templateId: "general-purpose",
        agentConfig: {
          name: "General Purpose",
          description: "Starts empty.",
          systemPrompt: "Assist generally.",
          llmModel: null,
          labels: [],
          agentType: "agent" as const,
          scope: "personal" as const,
          teams: [],
        },
        toolAssignments: [],
        missingCatalogs: [],
        unavailableTools: [],
      },
      isPending: false,
    } as unknown as ReturnType<typeof useAgentTemplateRequirements>);

    render(
      <AgentTemplateCreateFlow
        open
        template={{
          ...template,
          id: "general-purpose",
          name: "General Purpose",
          tools: [],
        }}
        onOpenChange={onOpenChangeMock}
      />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(executeMock).toHaveBeenCalledWith({
        requirements: expect.objectContaining({
          templateId: "general-purpose",
        }),
        formValues: {},
        onOpenChange: onOpenChangeMock,
      });
    });

    expect(
      screen.queryByRole("button", { name: /Create Agent/i }),
    ).not.toBeInTheDocument();
  });

  it("shows spinner while requirements are loading", () => {
    vi.mocked(useAgentTemplateRequirements).mockReturnValue({
      data: null,
      isPending: true,
    } as unknown as ReturnType<typeof useAgentTemplateRequirements>);

    render(
      <AgentTemplateCreateFlow
        open
        template={template}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText("Preparing agent...")).toBeInTheDocument();
  });

  it("auto-executes with unavailable tools when no user input is needed", async () => {
    vi.mocked(useAgentTemplateRequirements).mockReturnValue({
      data: {
        ...baseRequirements,
        toolAssignments: [],
        missingCatalogs: [],
        unavailableTools: [
          {
            toolName: "github__search_repositories",
            serverName: "github",
            reason: "catalog_not_found",
          },
        ],
      },
      isPending: false,
    } as unknown as ReturnType<typeof useAgentTemplateRequirements>);

    render(
      <AgentTemplateCreateFlow
        open
        template={template}
        onOpenChange={onOpenChangeMock}
      />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(executeMock).toHaveBeenCalled();
    });
  });

  it("renders nothing when template is null", () => {
    const { container } = render(
      <AgentTemplateCreateFlow
        open={false}
        template={null}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() },
    );

    expect(container.innerHTML).toBe("");
  });
});
