import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Radix's Select (the "Opens in" control) measures and scrolls its popover.
global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const {
  updateMutateAsync,
  setEnabledMutateAsync,
  setLockedMutateAsync,
  assignMutateAsync,
  unassignMutateAsync,
  useAppToolsMock,
} = vi.hoisted(() => ({
  updateMutateAsync: vi.fn(),
  setEnabledMutateAsync: vi.fn(),
  setLockedMutateAsync: vi.fn(),
  assignMutateAsync: vi.fn(),
  unassignMutateAsync: vi.fn(),
  useAppToolsMock: vi.fn(),
}));

vi.mock("@/lib/app.query", () => ({
  useAppTools: useAppToolsMock,
  useUpdateApp: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useSetAppEnabled: () => ({
    mutateAsync: setEnabledMutateAsync,
    isPending: false,
  }),
  useSetAppLocked: () => ({
    mutateAsync: setLockedMutateAsync,
    isPending: false,
  }),
  useAssignToolToApp: () => ({
    mutateAsync: assignMutateAsync,
    isPending: false,
  }),
  useUnassignToolFromApp: () => ({
    mutateAsync: unassignMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/organization.query");

// Both children have their own behavior-focused suites (app-tools-editor.test
// covers the editor; the environment selector fetches environments). The stub
// editor exposes onSelectionChange so tests can stage tool changes.
vi.mock("@/app/apps/_parts/app-tools-editor", () => ({
  AppToolsEditor: ({
    selectedToolIds,
    onSelectionChange,
  }: {
    selectedToolIds: Set<string>;
    onSelectionChange: (ids: Set<string>) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="stage-tool-t2"
        onClick={() =>
          onSelectionChange(new Set([...selectedToolIds, "tool-2"]))
        }
      >
        stage tool-2
      </button>
      <button
        type="button"
        data-testid="unstage-tool-t1"
        onClick={() =>
          onSelectionChange(
            new Set([...selectedToolIds].filter((id) => id !== "tool-1")),
          )
        }
      >
        unstage tool-1
      </button>
    </>
  ),
}));
vi.mock("@/components/environment-selector", () => ({
  EnvironmentSelector: () => null,
}));

// The picker itself (emoji tab, logo tab, upload, clear) is a shared component;
// here it only has to report a chosen value so the save path can be asserted.
vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (icon: string | null) => void;
  }) => (
    <>
      <span data-testid="icon-value">{value ?? "none"}</span>
      <button
        type="button"
        data-testid="pick-icon"
        onClick={() => onChange("🚀")}
      >
        pick icon
      </button>
      <button
        type="button"
        data-testid="clear-icon"
        onClick={() => onChange(null)}
      >
        clear icon
      </button>
    </>
  ),
}));

import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { AppSettingsForm } from "./app-settings-form";

const APP = {
  id: "app-1",
  name: "Budget",
  description: "Team budget tracker",
  scope: "personal",
  enabled: true,
  locked: false,
  teams: [],
  users: [],
  labels: [],
  environmentId: null,
} as unknown as Parameters<typeof AppSettingsForm>[0]["app"];

function toolsQuery(over: Record<string, unknown> = {}) {
  return {
    data: [{ id: "tool-1", name: "hf__paper_search" }],
    isPending: false,
    isError: false,
    ...over,
  };
}

function renderForm(over: Partial<Parameters<typeof AppSettingsForm>[0]> = {}) {
  const onBack = vi.fn();
  const onStatusChange = vi.fn();
  const utils = render(
    <AppSettingsForm
      app={APP}
      onBack={onBack}
      formId="settings-form"
      onStatusChange={onStatusChange}
      {...over}
    />,
  );
  return { onBack, onStatusChange, ...utils };
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "author-id" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useOrganizationMembers>);
  vi.mocked(useAssignableTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useAssignableTeams>);
  useAppToolsMock.mockReturnValue(toolsQuery());
  updateMutateAsync.mockResolvedValue({ id: "app-1" });
  assignMutateAsync.mockResolvedValue({ ok: true });
  unassignMutateAsync.mockResolvedValue({ ok: true });
});

describe("AppSettingsForm save", () => {
  test("saves trimmed identity fields and closes; unchanged tools fire no mutations", async () => {
    const { container, onBack } = renderForm();

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "  Budget v2  " },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      body: {
        scope: "personal",
        teamIds: [],
        // Both share lists are always sent, so switching away from Teams or
        // Users revokes what it left behind instead of stranding it.
        userIds: [],
        name: "Budget v2",
        description: "Team budget tracker",
        environmentId: null,
        // Labels are replaced wholesale too, so the full current set rides
        // every save — here the fixture's empty one.
        labels: [],
        icon: null,
        openInFullscreen: false,
      },
    });
    expect(assignMutateAsync).not.toHaveBeenCalled();
    expect(unassignMutateAsync).not.toHaveBeenCalled();
  });

  test("switches the app to opening fullscreen", async () => {
    const user = userEvent.setup();
    const { container, onBack } = renderForm();

    await user.click(screen.getByRole("combobox", { name: "Opens in" }));
    await user.click(screen.getByRole("option", { name: /fullscreen/i }));
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ openInFullscreen: true }),
      }),
    );
  });

  test("seeds from the app's saved display default and re-sends it on an unrelated save", async () => {
    const { container, onBack } = renderForm({
      app: { ...APP, openInFullscreen: true } as typeof APP,
    });
    expect(
      screen.getByRole("combobox", { name: "Opens in" }),
    ).toHaveTextContent("Fullscreen");

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Budget v2" },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ openInFullscreen: true }),
      }),
    );
  });

  test("sends a picked icon", async () => {
    const { container, onBack } = renderForm();

    fireEvent.click(screen.getByTestId("pick-icon"));
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ icon: "🚀" }),
      }),
    );
  });

  test("seeds from the app's icon and re-sends it on an unrelated save", async () => {
    const { container, onBack, getByTestId } = renderForm({
      app: { ...APP, icon: "🚀" } as typeof APP,
    });
    expect(getByTestId("icon-value")).toHaveTextContent("🚀");

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Budget v2" },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ name: "Budget v2", icon: "🚀" }),
      }),
    );
  });

  test("clearing the icon sends null so it goes back to the generic glyph", async () => {
    const { container, onBack } = renderForm({
      app: { ...APP, icon: "🚀" } as typeof APP,
    });

    fireEvent.click(screen.getByTestId("clear-icon"));
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ icon: null }),
      }),
    );
  });

  test("assigns a staged tool with dynamic credential resolution on save", async () => {
    const { container, onBack } = renderForm();

    fireEvent.click(screen.getByTestId("stage-tool-t2"));
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(assignMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      toolId: "tool-2",
      body: { credentialResolutionMode: "dynamic" },
    });
    expect(unassignMutateAsync).not.toHaveBeenCalled();
  });

  test("a failed update leaves the form open", async () => {
    updateMutateAsync.mockResolvedValue(null);
    const { container, onBack } = renderForm();

    submitForm(container);

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(onBack).not.toHaveBeenCalled();
    expect(assignMutateAsync).not.toHaveBeenCalled();
  });

  test("a failed tool change keeps the form open with the selection staged", async () => {
    assignMutateAsync.mockResolvedValue(null);
    const { container, onBack } = renderForm();

    fireEvent.click(screen.getByTestId("stage-tool-t2"));
    submitForm(container);

    await waitFor(() => expect(assignMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  test("a failed tools query still allows saving identity, skipping tool changes", async () => {
    useAppToolsMock.mockReturnValue(
      toolsQuery({ data: undefined, isError: true }),
    );
    const { container, onBack, onStatusChange } = renderForm();

    const lastStatus = onStatusChange.mock.calls.at(-1)?.[0];
    expect(lastStatus).toEqual({ saving: false, disabled: false });
    // The editor is not rendered unseeded — it would show every assigned tool
    // unchecked and let the user stage edits the save would drop.
    expect(screen.queryByTestId("stage-tool-t2")).not.toBeInTheDocument();

    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalled();
    expect(assignMutateAsync).not.toHaveBeenCalled();
    expect(unassignMutateAsync).not.toHaveBeenCalled();
  });

  test("a background refetch does not overwrite the staged selection", async () => {
    const { container, onBack, rerender, onStatusChange } = renderForm();

    fireEvent.click(screen.getByTestId("stage-tool-t2"));
    // Refetch lands a changed server set while tool-2 is staged.
    useAppToolsMock.mockReturnValue(
      toolsQuery({
        data: [
          { id: "tool-1", name: "hf__paper_search" },
          { id: "tool-3", name: "hf__dataset_search" },
        ],
      }),
    );
    rerender(
      <AppSettingsForm
        app={APP}
        onBack={onBack}
        formId="settings-form"
        onStatusChange={onStatusChange}
      />,
    );
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    // The staged selection {tool-1, tool-2} survives the refetch: tool-2 is
    // assigned. tool-3 — assigned concurrently by someone else after this
    // dialog seeded — is untouched: the diff runs against the seeded
    // snapshot, so an unrelated save here must not unassign it.
    expect(assignMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      toolId: "tool-2",
      body: { credentialResolutionMode: "dynamic" },
    });
    expect(unassignMutateAsync).not.toHaveBeenCalled();
  });

  test("retrying after a partial failure re-sends only the failed change", async () => {
    // First save carries two changes: the unassign of tool-1 succeeds, the
    // assign of tool-2 fails.
    assignMutateAsync.mockResolvedValueOnce(null);
    const { container, onBack } = renderForm();

    fireEvent.click(screen.getByTestId("stage-tool-t2"));
    fireEvent.click(screen.getByTestId("unstage-tool-t1"));
    submitForm(container);
    await waitFor(() => expect(assignMutateAsync).toHaveBeenCalledTimes(1));
    expect(unassignMutateAsync).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();

    // Retry: only the failed assign is left in the diff — the applied
    // unassign was folded into the snapshot and must not be re-sent.
    submitForm(container);
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(assignMutateAsync).toHaveBeenCalledTimes(2);
    expect(assignMutateAsync).toHaveBeenLastCalledWith({
      appId: "app-1",
      toolId: "tool-2",
      body: { credentialResolutionMode: "dynamic" },
    });
    expect(unassignMutateAsync).toHaveBeenCalledTimes(1);
  });

  test("an empty name blocks submit and shows a validation message", async () => {
    const { container, onBack } = renderForm();

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "   " },
    });
    submitForm(container);

    await waitFor(() =>
      expect(screen.getByText("Name is required.")).toBeInTheDocument(),
    );
    expect(updateMutateAsync).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("AppSettingsForm URL field", () => {
  const SLUGGED = {
    ...(APP as object),
    slug: "budget",
  } as Parameters<typeof AppSettingsForm>[0]["app"];

  test("seeds the field from the app's current slug", () => {
    renderForm({ app: SLUGGED });

    expect(screen.getByLabelText("URL")).toHaveValue("budget");
  });

  test("sends a changed slug", async () => {
    const { container, onBack } = renderForm({ app: SLUGGED });

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "  team-budget  " },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ slug: "team-budget" }),
      }),
    );
  });

  test("omits an unchanged slug so a save cannot 409 against its own row", async () => {
    const { container, onBack } = renderForm({ app: SLUGGED });

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Budget v2" },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.objectContaining({ slug: expect.anything() }),
      }),
    );
  });

  test("treats a cleared field as leave-alone, not as an empty slug", async () => {
    // The API has no way to unset a URL, so an empty field must not be sent —
    // it would come back a 400 rather than clearing anything.
    const { container, onBack } = renderForm({ app: SLUGGED });

    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "" } });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.objectContaining({ slug: expect.anything() }),
      }),
    );
  });

  test.each([
    ["uppercase", "Team-Budget"],
    ["an underscore", "team_budget"],
    ["a space", "team budget"],
  ])("blocks the save on %s and never calls the API", async (_label, value) => {
    const { container, onBack } = renderForm({ app: SLUGGED });

    fireEvent.change(screen.getByLabelText("URL"), { target: { value } });
    submitForm(container);

    await waitFor(() =>
      expect(
        screen.getByText(/lowercase letters, numbers and single hyphens/i),
      ).toBeInTheDocument(),
    );
    expect(updateMutateAsync).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});
