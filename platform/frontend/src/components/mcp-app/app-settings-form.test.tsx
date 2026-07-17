import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  updateMutateAsync,
  assignMutateAsync,
  unassignMutateAsync,
  useAppToolsMock,
} = vi.hoisted(() => ({
  updateMutateAsync: vi.fn(),
  assignMutateAsync: vi.fn(),
  unassignMutateAsync: vi.fn(),
  useAppToolsMock: vi.fn(),
}));

vi.mock("@/lib/app.query", () => ({
  useAppTools: useAppToolsMock,
  useUpdateApp: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
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
    <button
      type="button"
      data-testid="stage-tool-t2"
      onClick={() => onSelectionChange(new Set([...selectedToolIds, "tool-2"]))}
    >
      stage tool-2
    </button>
  ),
}));
vi.mock("@/components/environment-selector", () => ({
  EnvironmentSelector: () => null,
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { AppSettingsForm } from "./app-settings-form";

const APP = {
  id: "app-1",
  name: "Budget",
  description: "Team budget tracker",
  scope: "personal",
  teams: [],
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

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Budget v2  " },
    });
    submitForm(container);

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(updateMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      body: {
        scope: "personal",
        teamIds: [],
        name: "Budget v2",
        description: "Team budget tracker",
        environmentId: null,
      },
    });
    expect(assignMutateAsync).not.toHaveBeenCalled();
    expect(unassignMutateAsync).not.toHaveBeenCalled();
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
    // assigned and the diff runs against the fresh server set (tool-3 goes).
    expect(assignMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      toolId: "tool-2",
      body: { credentialResolutionMode: "dynamic" },
    });
    expect(unassignMutateAsync).toHaveBeenCalledWith({
      appId: "app-1",
      toolId: "tool-3",
    });
  });

  test("an empty name blocks submit and shows a validation message", async () => {
    const { container, onBack } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), {
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
