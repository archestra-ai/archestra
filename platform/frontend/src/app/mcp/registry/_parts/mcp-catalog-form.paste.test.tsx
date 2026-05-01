import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpCatalogForm } from "./mcp-catalog-form";

const { useIdentityProvidersMock } = vi.hoisted(() => ({
  useIdentityProvidersMock: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn((feature: string) => {
    if (feature === "mcpServerBaseImage") return "";
    if (feature === "orchestratorK8sRuntime") return true;
    if (feature === "byosEnabled") return false;
    return undefined;
  }),
  useEnterpriseFeature: vi.fn(() => false),
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: true,
    },
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: vi.fn(() => ({ data: true })),
}));

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviders: useIdentityProvidersMock,
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useK8sImagePullSecrets: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/secrets.query", () => ({
  useGetSecret: vi.fn(() => ({ data: null })),
}));

vi.mock("@/lib/docs/docs", () => ({
  getVisibleDocsUrl: vi.fn(() => "https://docs.example.com"),
  getFrontendDocsUrl: vi.fn(() => "https://docs.example.com/mcp-auth"),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: vi.fn(() => "Archestra"),
}));

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <div data-testid="agent-icon-picker" />,
}));

vi.mock("@/components/agent-labels", () => ({
  ProfileLabels: () => <div data-testid="profile-labels" />,
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: ({ children }: any) => <div data-testid="visibility-selector">{children}</div>,
}));

describe("McpCatalogForm paste handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIdentityProvidersMock.mockReturnValue({ data: [] });
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  const renderForm = () => {
    return render(
      <McpCatalogForm 
        mode="create" 
        onSubmit={vi.fn()} 
        formValues={{
          name: "",
          description: "",
          icon: null,
          serverType: "local",
          serverUrl: "",
          authMethod: "none",
          includeBearerPrefix: true,
          authHeaderName: "",
          additionalHeaders: [],
          enterpriseManagedConfig: null,
          oauthConfig: undefined,
          localConfig: {
            command: "",
            arguments: "",
            environment: [],
            envFrom: [],
            dockerImage: "",
            transportType: "stdio",
            httpPort: "",
            httpPath: "/mcp",
            serviceAccount: "",
            imagePullSecrets: [],
          },
          scope: "personal",
          teams: [],
        } as any}
      />
    );
  };

  it("converts pasted array in arguments field to newline separated strings", () => {
    renderForm();
    const argsInput = screen.getByLabelText("Arguments (one per line)");
    
    // Create paste event
    fireEvent.paste(argsInput, {
      clipboardData: {
        getData: () => '["--arg1", "--arg2", "val"]'
      }
    });

    expect(argsInput).toHaveValue("--arg1\n--arg2\nval");
  });

  it("handles full JSON config paste in command field", () => {
    renderForm();
    const commandInput = screen.getByLabelText("Command");
    
    const fullConfig = {
      name: "My Server",
      description: "A great server",
      command: "npx",
      args: ["-y", "sqlite"],
      transportType: "http",
      env: {
        FOO: "bar"
      }
    };

    fireEvent.paste(commandInput, {
      clipboardData: {
        getData: () => JSON.stringify(fullConfig)
      }
    });

    expect(screen.getByLabelText(/Name/i)).toHaveValue("My Server");
    expect(screen.getByLabelText(/Description/i)).toHaveValue("A great server");
    expect(commandInput).toHaveValue("npx");
    expect(screen.getByLabelText(/Arguments \(one per line\)/i)).toHaveValue("-y\nsqlite");
  });

  it("handles full JSON config paste in the Name field", () => {
    renderForm();
    const nameInput = screen.getByLabelText(/Name/i);
    
    const fullConfig = {
      name: "Pasted Name",
      command: "node",
      args: ["script.js"]
    };

    fireEvent.paste(nameInput, {
      clipboardData: {
        getData: () => JSON.stringify(fullConfig)
      }
    });

    expect(nameInput).toHaveValue("Pasted Name");
    expect(screen.getByLabelText(/Command/i)).toHaveValue("node");
    expect(screen.getByLabelText(/Arguments \(one per line\)/i)).toHaveValue("script.js");
  });

  it("replaces environment variables and handles transportType", () => {
    // Initial render would have some values, we'll check if paste overrides them
    renderForm();
    const commandInput = screen.getByLabelText(/Command/i);
    
    const config = {
      transport: "http",
      env: {
        NEW_VAR: "new_value"
      }
    };

    fireEvent.paste(commandInput, {
      clipboardData: {
        getData: () => JSON.stringify(config)
      }
    });
  });

  it("handles deeply nested configuration objects", () => {
    renderForm();
    const nameInput = screen.getByLabelText(/Name/i);
    
    const deepConfig = {
      wrap: {
        inner: {
          command: "deep-cmd",
          args: ["deep-arg"]
        }
      }
    };

    fireEvent.paste(nameInput, {
      clipboardData: {
        getData: () => JSON.stringify(deepConfig)
      }
    });

    expect(screen.getByLabelText(/Command/i)).toHaveValue("deep-cmd");
    expect(screen.getByLabelText(/Arguments \(one per line\)/i)).toHaveValue("deep-arg");
  });

  it("ignores non-JSON paste", () => {
    renderForm();
    const commandInput = screen.getByLabelText("Command");
    
    fireEvent.paste(commandInput, {
      clipboardData: {
        getData: () => "just plain text"
      }
    });

    // value should not be modified by the paste handler
    expect(commandInput).toHaveValue("");
  });

  it("handles Smithery/Claude-style config with mcpServers wrapper", () => {
    renderForm();
    const commandInput = screen.getByLabelText("Command");
    
    const smitheryConfig = {
      mcpServers: {
        "sqlite": {
          command: "npx",
          args: ["-y", "sqlite-server"]
        }
      }
    };

    fireEvent.paste(commandInput, {
      clipboardData: {
        getData: () => JSON.stringify(smitheryConfig)
      }
    });

    expect(commandInput).toHaveValue("npx");
    expect(screen.getByLabelText("Arguments (one per line)")).toHaveValue("-y\nsqlite-server");
  });

  it("handles agent_mcp wrapper identified in issue #3859", () => {
    renderForm();
    const commandInput = screen.getByLabelText("Command");
    
    const issueConfig = {
      agent_mcp: {
        command: "docker",
        args: ["run", "mcp-server"]
      }
    };

    fireEvent.paste(commandInput, {
      clipboardData: {
        getData: () => JSON.stringify(issueConfig)
      }
    });

    expect(commandInput).toHaveValue("docker");
    expect(screen.getByLabelText("Arguments (one per line)")).toHaveValue("run\nmcp-server");
  });
});
