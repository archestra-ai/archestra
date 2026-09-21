import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses browser pointer-capture and scrolling APIs that jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("next/navigation");

vi.mock("@/lib/schedule-trigger.query", () => ({
  useScheduleTriggers: vi.fn(),
  useScheduleTrigger: vi.fn(),
  useScheduleTriggerRuns: vi.fn(),
  useCreateScheduleTrigger: vi.fn(),
  useUpdateScheduleTrigger: vi.fn(),
  useDeleteScheduleTrigger: vi.fn(),
  useEnableScheduleTrigger: vi.fn(),
  useDisableScheduleTrigger: vi.fn(),
  useRunScheduleTriggerNow: vi.fn(),
}));

vi.mock("@/lib/agent.query", () => ({
  useProfiles: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/hooks/use-dialog-url-param", () => ({
  useDialogUrlParam: vi.fn(() => ({
    entity: null,
    open: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@/components/scheduled-tasks/use-resolve-run-chat", () => ({
  useResolveRunChat: vi.fn(() => ({ resolve: vi.fn(), isResolving: false })),
}));

import { useRouter, useSearchParams } from "next/navigation";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useRunScheduleTriggerNow,
  useScheduleTrigger,
  useScheduleTriggerRuns,
  useScheduleTriggers,
  useUpdateScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { ProjectSchedulesSection } from "./project-schedules-section";

const SCHEDULE: ScheduleTrigger = {
  id: "trigger-1",
  organizationId: "org-1",
  name: "Weekly summary",
  agentId: "agent-1",
  projectId: "project-1",
  messageTemplate: "Summarize the week",
  cronExpression: "0 9 * * 1",
  timezone: "UTC",
  enabled: true,
  actorUserId: "user-1",
  lastExecutedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  agent: { id: "agent-1", name: "Reporter", agentType: "agent" },
};

/** Maps a permission check to its mocked result, e.g. `{ read: true, create: false }`. */
function mockSchedulePermissions(granted: {
  read?: boolean;
  create?: boolean;
  update?: boolean;
  delete?: boolean;
}) {
  vi.mocked(useHasPermissions).mockImplementation((permissions) => {
    const actions = permissions.scheduledTask ?? [];
    const allGranted = actions.every(
      (action) => granted[action as keyof typeof granted] === true,
    );
    return {
      data: allGranted,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does not drop mockReturnValue, so restore the "no dialog
  // open" default here rather than leaking one test's override into the next.
  vi.mocked(useDialogUrlParam).mockReturnValue({
    entity: null,
    open: vi.fn(),
    close: vi.fn(),
  } as unknown as ReturnType<typeof useDialogUrlParam>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useFeature).mockImplementation((flag) =>
    flag === "agentRuntime" ? true : undefined,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useScheduleTriggers).mockReturnValue({
    data: { data: [] },
  } as unknown as ReturnType<typeof useScheduleTriggers>);
  vi.mocked(useScheduleTrigger).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useScheduleTrigger>);
  vi.mocked(useScheduleTriggerRuns).mockReturnValue({
    data: { data: [] },
  } as unknown as ReturnType<typeof useScheduleTriggerRuns>);
  vi.mocked(useDeleteScheduleTrigger).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteScheduleTrigger>);
  vi.mocked(useDisableScheduleTrigger).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDisableScheduleTrigger>);
  vi.mocked(useEnableScheduleTrigger).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useEnableScheduleTrigger>);
  vi.mocked(useRunScheduleTriggerNow).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useRunScheduleTriggerNow>);
});

describe("ProjectSchedulesSection without scheduledTask:read", () => {
  beforeEach(() => {
    mockSchedulePermissions({ read: false });
  });

  it("renders nothing", () => {
    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(screen.queryByText("Schedules")).not.toBeInTheDocument();
  });

  it("never mounts the schedule-triggers query", () => {
    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(useScheduleTriggers).not.toHaveBeenCalled();
  });

  it("never fetches a deep-linked ?schedule= trigger", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("schedule=trigger-1") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(useScheduleTrigger).not.toHaveBeenCalled();
  });
});

describe("ProjectSchedulesSection with scheduledTask:read only", () => {
  beforeEach(() => {
    mockSchedulePermissions({ read: true, create: false });
  });

  it("renders the section", () => {
    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(screen.getByText("Schedules")).toBeInTheDocument();
  });

  it("hides the New schedule button without scheduledTask:create", () => {
    render(<ProjectSchedulesSection projectId="project-1" canCreate />);

    expect(
      screen.queryByRole("button", { name: /new schedule/i }),
    ).not.toBeInTheDocument();
  });
});

describe("ProjectSchedulesSection with scheduledTask read+create", () => {
  beforeEach(() => {
    mockSchedulePermissions({
      read: true,
      create: true,
      update: true,
      delete: true,
    });
  });

  it("shows the New schedule button when the caller allows creating", () => {
    render(<ProjectSchedulesSection projectId="project-1" canCreate />);

    expect(
      screen.getByRole("button", { name: /new schedule/i }),
    ).toBeInTheDocument();
  });

  it("hides the New schedule button when the caller disallows creating", () => {
    render(<ProjectSchedulesSection projectId="project-1" canCreate={false} />);

    expect(
      screen.queryByRole("button", { name: /new schedule/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no schedules", () => {
    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
  });

  it("lists multiple schedules with their agents, cadence, and state", () => {
    vi.mocked(useScheduleTriggers).mockReturnValue({
      data: {
        data: [
          SCHEDULE,
          {
            ...SCHEDULE,
            id: "trigger-2",
            name: "Daily report",
            enabled: false,
          },
        ],
      },
    } as unknown as ReturnType<typeof useScheduleTriggers>);

    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(screen.getByText("Weekly summary")).toBeInTheDocument();
    expect(screen.getByText("Daily report")).toBeInTheDocument();
    expect(screen.getAllByText("Reporter")).toHaveLength(2);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("opens the latest run chat and provides direct edit and pause controls", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.mocked(useDialogUrlParam).mockReturnValue({
      entity: null,
      open,
      close: vi.fn(),
    } as unknown as ReturnType<typeof useDialogUrlParam>);
    vi.mocked(useScheduleTriggers).mockReturnValue({
      data: { data: [SCHEDULE] },
    } as unknown as ReturnType<typeof useScheduleTriggers>);
    vi.mocked(useScheduleTriggerRuns).mockReturnValue({
      data: {
        data: [
          {
            id: "latest-run",
            status: "success",
            chatConversationId: "latest-chat",
            runtimeTaskId: null,
          },
        ],
      },
    } as unknown as ReturnType<typeof useScheduleTriggerRuns>);
    render(<ProjectSchedulesSection projectId="project-1" />);
    await user.click(
      screen.getByRole("button", { name: "View runs for Weekly summary" }),
    );
    expect(useRouter().push).toHaveBeenCalledWith(
      "/chat/latest-chat?scheduleTriggerId=trigger-1&scheduleRunId=latest-run",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit Weekly summary" }),
    );
    expect(open).toHaveBeenCalledWith(SCHEDULE);
    await user.click(
      screen.getByRole("button", { name: "Pause Weekly summary" }),
    );
    expect(useDisableScheduleTrigger().mutate).toHaveBeenCalledWith(
      SCHEDULE.id,
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for Weekly summary" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Run now" }));
    expect(useRunScheduleTriggerNow().mutate).toHaveBeenCalledWith(
      SCHEDULE.id,
      expect.any(Object),
    );
  });

  it("resumes a paused schedule and confirms deletion before removing it", async () => {
    const user = userEvent.setup();
    vi.mocked(useScheduleTriggers).mockReturnValue({
      data: { data: [{ ...SCHEDULE, enabled: false }] },
    } as unknown as ReturnType<typeof useScheduleTriggers>);
    render(<ProjectSchedulesSection projectId="project-1" />);

    await user.click(
      screen.getByRole("button", { name: "Resume Weekly summary" }),
    );
    expect(useEnableScheduleTrigger().mutate).toHaveBeenCalledWith(SCHEDULE.id);
    await user.click(
      screen.getByRole("button", { name: "Actions for Weekly summary" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete schedule" }));
    expect(screen.getByText("Delete Weekly summary?")).toBeInTheDocument();
    expect(useDeleteScheduleTrigger().mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(useDeleteScheduleTrigger().mutate).toHaveBeenCalledWith(
      SCHEDULE.id,
      expect.any(Object),
    );
  });
});

describe("ProjectSchedulesSection default agent", () => {
  beforeEach(() => {
    mockSchedulePermissions({ read: true, create: true });
    // Only this block opens the dialog, so it's the only one that needs the
    // form's own mutations.
    const idleMutation = { mutateAsync: vi.fn(), isPending: false };
    vi.mocked(useCreateScheduleTrigger).mockReturnValue(
      idleMutation as unknown as ReturnType<typeof useCreateScheduleTrigger>,
    );
    vi.mocked(useUpdateScheduleTrigger).mockReturnValue(
      idleMutation as unknown as ReturnType<typeof useUpdateScheduleTrigger>,
    );
    vi.mocked(useProfiles).mockReturnValue({
      data: [
        {
          id: "agent-1",
          name: "Reporter",
          agentType: "agent",
          scope: "org",
          runtime: { credentials: [] },
        },
        {
          id: "agent-2",
          name: "Test1 Agent",
          agentType: "agent",
          scope: "org",
        },
      ],
    } as unknown as ReturnType<typeof useProfiles>);
  });

  /** The dialog has several comboboxes (cron, timezone); scope to the agent's. */
  function agentPicker() {
    const field = screen
      .getByText("Agent", { selector: "label" })
      .closest("div") as HTMLElement;
    return within(field).getByRole("combobox");
  }

  function schedulePicker() {
    const field = screen.getByText("Schedule", {
      selector: "label",
    }).parentElement;
    return within(field as HTMLElement).getByRole("combobox");
  }

  it("preselects the project's default agent when creating a schedule", async () => {
    render(
      <ProjectSchedulesSection
        projectId="project-1"
        canCreate
        defaultAgentId="agent-2"
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /new schedule/i }),
    );

    expect(agentPicker()).toHaveTextContent("Test1 Agent");
    expect(schedulePicker()).toHaveTextContent("Manual");
    expect(screen.queryByText("Timezone")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "On-demand report");
    await userEvent.type(
      screen.getByLabelText("Task prompt"),
      "Write a report",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(useCreateScheduleTrigger().mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, projectId: "project-1" }),
    );
    await userEvent.click(schedulePicker());
    await userEvent.click(screen.getByRole("option", { name: "Every hour" }));
    expect(screen.getByText("Timezone")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(useCreateScheduleTrigger().mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, cronExpression: "0 * * * *" }),
    );
  });

  it("leaves the agent unselected when the project pins none", async () => {
    render(<ProjectSchedulesSection projectId="project-1" canCreate />);

    await userEvent.click(
      screen.getByRole("button", { name: /new schedule/i }),
    );

    expect(agentPicker()).toHaveTextContent("Select an agent");
  });

  it("keeps an existing schedule's own agent when editing", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("schedule=trigger-1") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useScheduleTrigger).mockReturnValue({
      data: SCHEDULE,
    } as unknown as ReturnType<typeof useScheduleTrigger>);
    vi.mocked(useDialogUrlParam).mockReturnValue({
      entity: SCHEDULE,
      open: vi.fn(),
      close: vi.fn(),
    } as unknown as ReturnType<typeof useDialogUrlParam>);

    // The project pins agent-2; the schedule is bound to agent-1 and must keep it.
    render(
      <ProjectSchedulesSection
        projectId="project-1"
        canCreate
        defaultAgentId="agent-2"
      />,
    );

    expect(agentPicker()).toHaveTextContent("Reporter");
    expect(
      within(agentPicker()).getByLabelText("Dedicated runtime"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useUpdateScheduleTrigger().mutateAsync).toHaveBeenLastCalledWith({
      id: SCHEDULE.id,
      body: expect.objectContaining({
        enabled: true,
        cronExpression: SCHEDULE.cronExpression,
      }),
    });
    const schedulePicker = screen.getByText("Schedule", {
      selector: "label",
    }).parentElement;
    await userEvent.click(
      within(schedulePicker as HTMLElement).getByRole("combobox", {
        name: "Schedule",
      }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Manual" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useUpdateScheduleTrigger().mutateAsync).toHaveBeenLastCalledWith({
      id: SCHEDULE.id,
      body: expect.objectContaining({
        enabled: false,
        cronExpression: SCHEDULE.cronExpression,
      }),
    });
  });
});
