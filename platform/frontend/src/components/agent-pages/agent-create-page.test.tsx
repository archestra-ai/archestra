import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFormProps } from "@/components/agent-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { AgentCreatePage } from "./agent-create-page";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    enterpriseFeatures: {
      fullWhiteLabeling: false,
    },
  },
}));

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config", () => ({
  default: mockConfig,
}));

// The form itself is covered by agent-form.test.tsx; here it is a stub whose
// props are what the page is expected to hand it, plus a way to fire
// `onCreated` and report dirtiness.
const formProps = vi.fn<(props: AgentFormProps) => void>();
vi.mock("@/components/agent-form", () => ({
  AgentForm: (props: AgentFormProps) => {
    formProps(props);
    return (
      <div>
        <button type="button" onClick={() => props.onDirtyChange?.(true)}>
          make dirty
        </button>
        <button
          type="button"
          onClick={() => props.onCreated?.({ id: "new-1", name: "Fresh" })}
        >
          fire created
        </button>
        {props.footer?.({
          formId: "agent-form",
          isCreate: true,
          isSaving: false,
          isDirty: false,
          canSubmit: true,
          readOnly: false,
        })}
      </div>
    );
  },
}));

const push = vi.fn();

function mockPermissions({
  canRead,
  isPending = false,
}: {
  canRead: boolean | undefined;
  isPending?: boolean;
}) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canRead,
    isPending,
  } as unknown as ReturnType<typeof useHasPermissions>);
}

function renderAgentCreatePage({
  canAddExternalAgent = true,
  canCreateAgent = true,
}: {
  canAddExternalAgent?: boolean;
  canCreateAgent?: boolean;
} = {}) {
  return render(
    <AgentCreatePage
      kind="agent"
      canAddExternalAgent={canAddExternalAgent}
      canCreateAgent={canCreateAgent}
    />,
  );
}

describe("AgentCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;
    mockPermissions({ canRead: true });
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");
    vi.mocked(usePathname).mockReturnValue("/agents/new");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("hides Popular agents when the Agent runtime is off", () => {
    renderAgentCreatePage();

    expect(
      screen.getByRole("button", { name: /start from scratch/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /add an external agent/i }),
    ).toHaveTextContent(
      "Connect an A2A-compatible agent that your agents can use only as a subagent.",
    );
    expect(
      screen.queryByRole("heading", { level: 2, name: "Popular agents" }),
    ).toBeNull();
    for (const name of [
      "Archestra Agent",
      "Claude Code",
      "Codex",
      "OpenCode",
      "Hermes",
      "OpenClaw",
    ]) {
      expect(
        screen.queryByRole("button", {
          name: new RegExp(name, "i"),
        }),
      ).toBeNull();
    }
    expect(formProps).not.toHaveBeenCalled();
  });

  it("lets an external-agent manager open the A2A form without Agent create permission", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage({
      canAddExternalAgent: true,
      canCreateAgent: false,
    });

    expect(
      screen.getByRole("button", { name: /start from scratch/i }),
    ).toHaveAccessibleDescription("Requires permission to create agents.");

    await user.click(
      screen.getByRole("button", { name: /add an external agent/i }),
    );
    expect(push).toHaveBeenCalledWith("/a2a/agents/new");
    expect(formProps).not.toHaveBeenCalled();
  });

  it("disables runtime templates for an external-agent manager", () => {
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime" ? true : undefined,
    );
    renderAgentCreatePage({
      canAddExternalAgent: true,
      canCreateAgent: false,
    });

    const codexTemplate = screen.getByRole("button", { name: /codex/i });
    expect(codexTemplate).toBeDisabled();
    expect(codexTemplate).toHaveAccessibleDescription(
      "Requires permission to create agents.",
    );
  });

  it("keeps the external-agent choice disabled for a regular Agent creator", () => {
    renderAgentCreatePage({
      canAddExternalAgent: false,
      canCreateAgent: true,
    });

    expect(
      screen.getByRole("button", { name: /start from scratch/i }),
    ).toBeEnabled();
    const externalAgentChoice = screen.getByRole("button", {
      name: /add an external agent/i,
    });
    expect(externalAgentChoice).toBeDisabled();
    expect(externalAgentChoice).toHaveAccessibleDescription(
      "Requires permission to view agents and update agent settings.",
    );
  });

  it("offers maintained Agent templates and prefills the existing create wizard", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime"
        ? true
        : feature === "agentRuntimeBaseImage"
          ? "agent-archestra:dev"
          : undefined,
    );

    renderAgentCreatePage();

    expect(
      screen.getByRole("heading", { level: 2, name: "Popular agents" }),
    ).toBeInTheDocument();
    for (const name of [
      "Archestra Agent",
      "Claude Code",
      "Codex",
      "OpenCode",
      "Hermes",
      "OpenClaw",
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(name, "i") }),
      ).toBeInTheDocument();
    }
    expect(formProps).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /codex/i }));

    expect(screen.getByText(/codex is prefilled below/i)).toBeInTheDocument();
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "Codex",
          icon: "/model-logos/openai.svg",
          requiredSubscriptionKind: "chatgpt",
          runtime: expect.objectContaining({
            command: ["archestra-codex"],
            image: "agent-codex:dev",
            credentials: expect.arrayContaining([
              expect.objectContaining({
                key: "GITHUB_TOKEN",
                credentialId: "github",
                required: false,
              }),
            ]),
          }),
        }),
      }),
    );
    expect(screen.getByRole("button", { name: "Catalog" })).toBeInTheDocument();
  });

  it("prefills OpenCode with its maintained Responses runtime", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime"
        ? true
        : feature === "agentRuntimeBaseImage"
          ? "agent-archestra:dev"
          : undefined,
    );

    renderAgentCreatePage();
    await user.click(screen.getByRole("button", { name: /opencode/i }));

    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "OpenCode",
          icon: "/agent-logos/opencode.svg",
          runtime: expect.objectContaining({
            image: "agent-opencode:dev",
            command: ["archestra-opencode"],
            inferenceProtocol: "openai_responses",
            steerMode: "tmux_keys",
          }),
        }),
      }),
    );
  });

  it("prefills OpenClaw with its compatible Chat Completions transport", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime"
        ? true
        : feature === "agentRuntimeBaseImage"
          ? "agent-archestra:dev"
          : undefined,
    );

    renderAgentCreatePage();
    await user.click(screen.getByRole("button", { name: /openclaw/i }));

    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "OpenClaw",
          runtime: expect.objectContaining({
            command: ["archestra-openclaw"],
            inferenceProtocol: "openai_chat",
          }),
        }),
      }),
    );
  });

  it("uses the configured product name and sidebar icon for the built-in Agent", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime" ? true : undefined,
    );
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    vi.mocked(useAppIconLogo).mockReturnValue("/custom-app-icon.svg");

    const { container } = renderAgentCreatePage();

    expect(
      screen.getByRole("button", { name: /acme ai agent/i }),
    ).toHaveTextContent("Acme AI's lightweight agent loop");
    expect(
      container.querySelector('img[src="/custom-app-icon.svg"]'),
    ).not.toBeNull();
    expect(screen.queryByText(/archestra agent/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /acme ai agent/i }));
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "Acme AI Agent",
          icon: "/custom-app-icon.svg",
        }),
      }),
    );
  });

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  it("uses a neutral built-in Agent icon when full white-labeling has no custom icon", async () => {
    const user = userEvent.setup();
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime" ? true : undefined,
    );
    vi.mocked(useAppName).mockReturnValue("Example AI");
    vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");

    renderAgentCreatePage();

    const template = screen.getByRole("button", {
      name: /example ai agent/i,
    });
    expect(template.querySelector("img")).toBeNull();

    await user.click(template);
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "Example AI Agent",
          icon: null,
        }),
      }),
    );
  });
  // SPDX-SnippetEnd

  it("prefills Claude Code with its runtime-scoped personal subscription token", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentRuntime" ? true : undefined,
    );

    renderAgentCreatePage();
    await user.click(screen.getByRole("button", { name: /claude code/i }));

    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          runtime: expect.objectContaining({
            command: ["archestra-claude-code"],
            credentials: expect.arrayContaining([
              expect.objectContaining({
                key: "CLAUDE_CODE_OAUTH_TOKEN",
                credentialId: "claude-code",
                scope: "per_user",
                required: true,
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("mounts the whole form once, showing the first step, and only the last step may submit", async () => {
    const user = userEvent.setup();
    render(<AgentCreatePage kind="mcp_gateway" />);
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentType: "mcp_gateway",
        activeSection: "configuration",
        submitEnabled: false,
      }),
    );
    // Every group stays mounted: no `sections` narrows the form to one step.
    expect(formProps.mock.lastCall?.[0].sections).toBeUndefined();
    expect(
      screen.getByRole("heading", { level: 1, name: "Create MCP Gateway" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Name the gateway and choose who can use it, then pick the tools it exposes and connect a client.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "MCP Gateways" }),
    ).toBeInTheDocument();
    // The last step alone offers to create; earlier steps only move on.
    expect(screen.queryByTestId(E2eTestId.AgentSetupSubmitButton)).toBeNull();

    const next = () => screen.getByTestId(E2eTestId.AgentSetupNextButton);
    expect(next()).toHaveTextContent("Tools & Knowledge");
    await user.click(next());
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeSection: "tools", submitEnabled: false }),
    );
    expect(next()).toHaveTextContent("Advanced");
    await user.click(next());
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeSection: "advanced",
        submitEnabled: true,
      }),
    );
    expect(screen.queryByTestId(E2eTestId.AgentSetupNextButton)).toBeNull();
    const create = screen.getByTestId(E2eTestId.AgentSetupSubmitButton);
    expect(create).toHaveAttribute("type", "submit");
    expect(create).toHaveTextContent("Create MCP Gateway");
    // Back to an earlier step (through the stepper) keeps the same form mount.
    await user.click(screen.getByTestId(`${E2eTestId.AgentSetupStep}-tools`));
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeSection: "tools", submitEnabled: false }),
    );
  });

  it("lands the created record on its Connect section", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage();
    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "fire created" }));
    expect(push).toHaveBeenCalledWith("/agents/new-1?section=connect");
  });

  it("stays put with a success state when the creator may not read what it made", async () => {
    const user = userEvent.setup();
    mockPermissions({ canRead: false });
    renderAgentCreatePage({ canAddExternalAgent: false });
    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );

    await user.click(screen.getByRole("button", { name: "fire created" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Agent created")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Create Agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/you do not have permission to view it/i),
    ).toBeInTheDocument();
    // Nowhere to send them: the list needs the same read permission, so
    // neither the shell's back link nor a button to it is offered.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "fire created" })).toBeNull();
  });

  it("waits for the read permission before deciding where a created record goes", async () => {
    const user = userEvent.setup();
    // The create lands while the permission check is still in flight.
    mockPermissions({ canRead: undefined, isPending: true });
    const { rerender } = renderAgentCreatePage();
    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "fire created" }));

    // Neither answer yet: no blind navigation, and no "you cannot see it".
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/you do not have permission to view it/i),
    ).toBeNull();

    mockPermissions({ canRead: true });
    rerender(
      <AgentCreatePage kind="agent" canAddExternalAgent canCreateAgent />,
    );
    expect(push).toHaveBeenCalledWith("/agents/new-1?section=connect");
  });

  it("shows the success state when the pending permission settles to a no", async () => {
    const user = userEvent.setup();
    mockPermissions({ canRead: undefined, isPending: true });
    const { rerender } = renderAgentCreatePage();
    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "fire created" }));

    mockPermissions({ canRead: false });
    rerender(
      <AgentCreatePage kind="agent" canAddExternalAgent canCreateAgent />,
    );
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByText(/you do not have permission to view it/i),
    ).toBeInTheDocument();
  });

  it("returns to the source chooser from the scratch form", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage();

    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "Catalog" }));
    expect(
      screen.getByRole("button", { name: /add an external agent/i }),
    ).toBeInTheDocument();
    expect(formProps).toHaveBeenCalled();
  });

  it("returns to the source chooser from the top Agents back link", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage();

    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("link", { name: "Agents" }));

    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /add an external agent/i }),
    ).toBeInTheDocument();
  });

  it("asks before returning to the catalog discards a dirty draft", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage();

    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getByRole("button", { name: "Catalog" }));

    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add an external agent/i }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(
      screen.getByRole("button", { name: /add an external agent/i }),
    ).toBeInTheDocument();
  });

  it("asks before the top back link returns a dirty form to the catalog", async () => {
    const user = userEvent.setup();
    renderAgentCreatePage();

    await user.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getByRole("link", { name: "Agents" }));
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /add an external agent/i }),
    ).toBeInTheDocument();
  });
});
