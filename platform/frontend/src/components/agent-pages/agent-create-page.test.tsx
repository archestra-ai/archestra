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
          isCreate: true,
          isSaving: false,
          isDirty: false,
          canSubmit: true,
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

  it("offers maintained Agent templates and prefills the existing create wizard", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentBackgroundExecution"
        ? true
        : feature === "agentBackgroundExecutionBaseImage"
          ? "agent-archestra:dev"
          : undefined,
    );

    render(<AgentCreatePage kind="agent" />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Popular agents" }),
    ).toBeInTheDocument();
    for (const name of [
      "Archestra Agent",
      "Claude Code",
      "Codex",
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
          backgroundExecution: expect.objectContaining({
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

  it("prefills OpenClaw with its compatible Chat Completions transport", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "agentBackgroundExecution"
        ? true
        : feature === "agentBackgroundExecutionBaseImage"
          ? "agent-archestra:dev"
          : undefined,
    );

    render(<AgentCreatePage kind="agent" />);
    await user.click(screen.getByRole("button", { name: /openclaw/i }));

    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          name: "OpenClaw",
          backgroundExecution: expect.objectContaining({
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
      feature === "agentBackgroundExecution" ? true : undefined,
    );
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    vi.mocked(useAppIconLogo).mockReturnValue("/custom-app-icon.svg");

    const { container } = render(<AgentCreatePage kind="agent" />);

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
      feature === "agentBackgroundExecution" ? true : undefined,
    );
    vi.mocked(useAppName).mockReturnValue("Example AI");
    vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");

    render(<AgentCreatePage kind="agent" />);

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
      feature === "agentBackgroundExecution" ? true : undefined,
    );

    render(<AgentCreatePage kind="agent" />);
    await user.click(screen.getByRole("button", { name: /claude code/i }));

    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValues: expect.objectContaining({
          backgroundExecution: expect.objectContaining({
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
    render(<AgentCreatePage kind="agent" />);
    await user.click(screen.getByRole("button", { name: "fire created" }));
    expect(push).toHaveBeenCalledWith("/agents/new-1#connect");
  });

  it("stays put with a success state when the creator may not read what it made", async () => {
    const user = userEvent.setup();
    mockPermissions({ canRead: false });
    render(<AgentCreatePage kind="agent" />);

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
    const { rerender } = render(<AgentCreatePage kind="agent" />);
    await user.click(screen.getByRole("button", { name: "fire created" }));

    // Neither answer yet: no blind navigation, and no "you cannot see it".
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/you do not have permission to view it/i),
    ).toBeNull();

    mockPermissions({ canRead: true });
    rerender(<AgentCreatePage kind="agent" />);
    expect(push).toHaveBeenCalledWith("/agents/new-1#connect");
  });

  it("shows the success state when the pending permission settles to a no", async () => {
    const user = userEvent.setup();
    mockPermissions({ canRead: undefined, isPending: true });
    const { rerender } = render(<AgentCreatePage kind="agent" />);
    await user.click(screen.getByRole("button", { name: "fire created" }));

    mockPermissions({ canRead: false });
    rerender(<AgentCreatePage kind="agent" />);
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByText(/you do not have permission to view it/i),
    ).toBeInTheDocument();
  });

  it("returns to the list on Cancel, asking first when the form is dirty", async () => {
    const user = userEvent.setup();
    render(<AgentCreatePage kind="agent" />);

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /discard changes/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(push).toHaveBeenCalledWith("/agents");
  });

  it("asks before the back link discards a dirty form", async () => {
    const user = userEvent.setup();
    render(<AgentCreatePage kind="agent" />);

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getByRole("link", { name: "Agents" }));
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(push).toHaveBeenCalledWith("/agents");
  });
});
