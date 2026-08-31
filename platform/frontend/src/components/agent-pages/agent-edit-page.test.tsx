import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentFormFooterState,
  AgentFormProps,
} from "@/components/agent-form";
import { useProfile } from "@/lib/agent.query";
import { AgentEditPage } from "./agent-edit-page";

vi.mock("next/navigation");
vi.mock("@/lib/agent.query", () => ({ useProfile: vi.fn() }));
vi.mock("@/lib/hooks/use-app-name");

let access = {
  canModify: true,
  canEdit: true,
  canCreate: true,
  canDelete: true,
  isBuiltIn: false,
  currentUserId: "me",
  isPending: false,
};
vi.mock("./use-agent-access", () => ({ useAgentAccess: () => access }));

// The form itself is covered by agent-form.test.tsx; this stub exposes what
// the page hands it and lets a test fire its callbacks.
let footerState: AgentFormFooterState;
const formProps = vi.fn<(props: AgentFormProps) => void>();
vi.mock("@/components/agent-form", () => ({
  AgentForm: (props: AgentFormProps) => {
    formProps(props);
    return (
      <div>
        <span>form sections: {props.sections?.join(",")}</span>
        <button
          type="button"
          onClick={() => props.onSaved?.({ id: "a1", name: "Agent" })}
        >
          fire saved
        </button>
        <button type="button" onClick={() => props.onDirtyChange?.(true)}>
          make dirty
        </button>
        {props.footer?.(footerState)}
      </div>
    );
  },
}));

const push = vi.fn();
const replace = vi.fn();
const baseAgent = {
  id: "a1",
  name: "Support Agent",
  agentType: "agent",
  builtIn: false,
  scope: "personal",
  icon: null,
  description: null,
  accessAllTools: true,
  tools: [],
  knowledgeBaseIds: [],
  connectorIds: [],
  environmentId: null,
  teams: [],
  authorId: "me",
};

function mount(kind: "agent" | "mcp_gateway", search = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(search) as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
  return render(<AgentEditPage kind={kind} id="a1" />);
}

describe("AgentEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    footerState = {
      isCreate: false,
      isSaving: false,
      isDirty: false,
      canSubmit: true,
    };
    access = { ...access, isBuiltIn: false, canEdit: true };
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/agents/a1/edit");
    vi.mocked(useProfile).mockReturnValue({
      data: baseAgent,
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it("opens on the configuration step and mounts only that section group", () => {
    mount("agent");
    expect(
      screen.getByRole("heading", { level: 1, name: /Edit Support Agent/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("form sections: configuration"),
    ).toBeInTheDocument();
    expect(formProps).toHaveBeenCalledWith(
      expect.objectContaining({ agent: baseAgent, agentType: "agent" }),
    );
  });

  it("follows ?step= to the tools and advanced steps, each mounting its own section group", () => {
    const tools = mount("agent", "step=tools");
    expect(screen.getByText("form sections: tools")).toBeInTheDocument();
    tools.unmount();

    mount("agent", "step=advanced");
    expect(screen.getByText("form sections: advanced")).toBeInTheDocument();
  });

  it("returns to the detail page's Overview after saving the last step", async () => {
    const user = userEvent.setup();
    footerState = { ...footerState, isDirty: true };
    mount("agent", "step=advanced");
    // The last step saves without continuing anywhere.
    expect(
      screen.getByTestId(E2eTestId.AgentSetupSubmitButton),
    ).toHaveTextContent(/^Save$/);
    expect(screen.queryByTestId(E2eTestId.AgentSetupNextButton)).toBeNull();
    await user.click(screen.getByRole("button", { name: "fire saved" }));
    expect(push).toHaveBeenCalledWith("/agents/a1");
  });

  it("offers Save on every step, which writes the step and returns to the Overview", async () => {
    const user = userEvent.setup();
    footerState = { ...footerState, isDirty: true };
    mount("agent");
    // The first step, dirty: Save beside Save & Continue.
    const save = screen.getByTestId(E2eTestId.AgentSetupSubmitButton);
    expect(save).toHaveTextContent(/^Save$/);
    expect(save).toHaveAttribute("type", "submit");
    expect(
      screen.getByTestId(E2eTestId.AgentSetupNextButton),
    ).toHaveTextContent("Save & Continue");

    await user.click(save);
    await user.click(screen.getByRole("button", { name: "fire saved" }));
    expect(push).toHaveBeenCalledWith("/agents/a1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("labels the last step's way out Save even when there is nothing to save, and it returns to the Overview", async () => {
    const user = userEvent.setup();
    mount("agent", "step=advanced");
    const save = screen.getByTestId(E2eTestId.AgentSetupFinishButton);
    expect(save).toHaveTextContent(/^Save$/);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    await user.click(save);
    expect(push).toHaveBeenCalledWith("/agents/a1");
  });

  it("returns to the Overview from a clean earlier step through Save too", async () => {
    const user = userEvent.setup();
    mount("agent", "step=tools");
    await user.click(screen.getByTestId(E2eTestId.AgentSetupFinishButton));
    expect(push).toHaveBeenCalledWith("/agents/a1");
  });

  it("sends a stale ?step=connect to the first step because connecting is on the detail page", () => {
    mount("agent", "step=connect");
    expect(
      screen.getByText("form sections: configuration"),
    ).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(
      "/agents/a1/edit?step=configuration",
      expect.anything(),
    );
  });

  it("offers Save & Continue while dirty and the next step once clean", async () => {
    const user = userEvent.setup();
    footerState = { ...footerState, isDirty: true };
    const dirty = mount("agent");
    const saveAndContinue = screen.getByTestId(E2eTestId.AgentSetupNextButton);
    expect(saveAndContinue).toHaveTextContent("Save & Continue");
    expect(saveAndContinue).toHaveAttribute("type", "submit");
    dirty.unmount();

    footerState = { ...footerState, isDirty: false };
    mount("agent");
    const next = screen.getByTestId(E2eTestId.AgentSetupNextButton);
    expect(next).toHaveTextContent("Tools & Knowledge");
    await user.click(next);
    expect(replace).toHaveBeenCalledWith(
      "/agents/a1/edit?step=tools",
      expect.anything(),
    );
  });

  it("moves to the next step after Save & Continue", async () => {
    const user = userEvent.setup();
    footerState = { ...footerState, isDirty: true };
    mount("agent");
    await user.click(screen.getByTestId(E2eTestId.AgentSetupNextButton));
    await user.click(screen.getByRole("button", { name: "fire saved" }));
    expect(replace).toHaveBeenCalledWith(
      "/agents/a1/edit?step=tools",
      expect.anything(),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("shows which save is in flight", () => {
    footerState = { ...footerState, isDirty: true, isSaving: true };
    mount("agent");
    // Neither button asked yet (a save the form started itself): both are
    // held, and the step's own continue shows the progress.
    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
    expect(
      screen.getAllByRole("button").filter((b) => b.textContent === "Save"),
    ).toHaveLength(1);
  });

  it("returns to the detail page after saving a built-in agent, whose only step is configuration", async () => {
    const user = userEvent.setup();
    access = { ...access, isBuiltIn: true };
    vi.mocked(useProfile).mockReturnValue({
      data: { ...baseAgent, builtIn: true },
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    mount("agent");
    // No stepper for a single-step edit.
    expect(
      screen.queryByTestId(`${E2eTestId.AgentSetupStep}-configuration`),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "fire saved" }));
    expect(push).toHaveBeenCalledWith("/agents/a1");
  });

  it("guards a step change while the form is dirty", async () => {
    const user = userEvent.setup();
    mount("agent");
    await user.click(screen.getByRole("button", { name: "make dirty" }));

    await user.click(screen.getByTestId(`${E2eTestId.AgentSetupStep}-tools`));
    expect(replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Discard changes/ }));
    expect(replace).toHaveBeenCalledWith(
      "/agents/a1/edit?step=tools",
      expect.anything(),
    );
  });

  it("asks before the back link discards a dirty form", async () => {
    const user = userEvent.setup();
    mount("agent");
    await user.click(screen.getByRole("button", { name: "make dirty" }));

    await user.click(screen.getByRole("link", { name: "Back to agent" }));
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Discard changes/ }));
    expect(push).toHaveBeenCalledWith("/agents/a1");
  });

  it("hands an id of another family to that family's edit page", () => {
    vi.mocked(useProfile).mockReturnValue({
      data: { ...baseAgent, agentType: "agent" },
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    mount("mcp_gateway");
    expect(replace).toHaveBeenCalledWith("/agents/a1/edit");
  });

  it("renders the form read-only for a reader who may not change the record", () => {
    access = { ...access, canEdit: false };
    mount("agent");
    expect(formProps).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(screen.getByText(/but not change it/)).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown id", () => {
    vi.mocked(useProfile).mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    mount("agent");
    expect(
      screen.getByRole("heading", { level: 1, name: "Edit Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByText("Agent not found")).toBeInTheDocument();
  });

  it("offers a retry when the record could not be loaded, rather than claiming it is gone", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    vi.mocked(useProfile).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useProfile>);
    mount("agent");

    expect(
      screen.getByRole("heading", { level: 1, name: "Edit Agent" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent not found")).toBeNull();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps the edit header while the record is loading", () => {
    vi.mocked(useProfile).mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useProfile>);
    mount("mcp_gateway");

    expect(
      screen.getByRole("heading", { level: 1, name: "Edit MCP Gateway" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Configure the gateway, choose the tools it exposes, and set its advanced options.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "MCP Gateways" }),
    ).toBeInTheDocument();
  });

  it("keeps the wizard and its unsaved edits when the record is deleted mid-edit", async () => {
    const user = userEvent.setup();
    const { rerender } = mount("agent");
    await user.click(screen.getByRole("button", { name: "make dirty" }));

    // The delete lands in another tab; the refetch answers 404, so the query
    // flips to a successful null.
    vi.mocked(useProfile).mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    rerender(<AgentEditPage kind="agent" id="a1" />);

    expect(
      screen.getByText("form sections: configuration"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent not found")).toBeNull();
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
  });

  it("disables the save button once the record is gone", async () => {
    const user = userEvent.setup();
    footerState = { ...footerState, isDirty: true };
    const { rerender } = mount("agent");
    expect(screen.getByTestId(E2eTestId.AgentSetupSubmitButton)).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "make dirty" }));

    vi.mocked(useProfile).mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    rerender(<AgentEditPage kind="agent" id="a1" />);

    expect(screen.getByTestId(E2eTestId.AgentSetupSubmitButton)).toBeDisabled();
  });

  it("leaves a ?step= the record does have alone", () => {
    mount("agent", "step=tools");
    expect(replace).not.toHaveBeenCalled();
  });
});
