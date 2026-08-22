import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFormProps } from "@/components/agent-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AgentCreatePage } from "./agent-create-page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");

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
    mockPermissions({ canRead: true });
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
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

  it("walks an LLM proxy through configuration and advanced, and lands on its Connect section", async () => {
    const user = userEvent.setup();
    render(<AgentCreatePage kind="llm_proxy" />);
    expect(
      screen.getByTestId(E2eTestId.AgentSetupNextButton),
    ).toHaveTextContent("Advanced");
    expect(
      screen.queryByTestId(`${E2eTestId.AgentSetupStep}-tools`),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "fire created" }));
    expect(push).toHaveBeenCalledWith("/llm/proxies/new-1#connect");
  });

  it("stays put with a success state when the creator may not read what it made", async () => {
    const user = userEvent.setup();
    mockPermissions({ canRead: false });
    render(<AgentCreatePage kind="agent" />);

    await user.click(screen.getByRole("button", { name: "fire created" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Agent created")).toBeInTheDocument();
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
