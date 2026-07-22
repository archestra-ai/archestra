import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");

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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type ScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useRunScheduleTriggerNow,
  useScheduleTrigger,
  useScheduleTriggerRuns,
  useScheduleTriggers,
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
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
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
  const idleMutation = { mutate: vi.fn(), isPending: false };
  vi.mocked(useDeleteScheduleTrigger).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useDeleteScheduleTrigger>,
  );
  vi.mocked(useDisableScheduleTrigger).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useDisableScheduleTrigger>,
  );
  vi.mocked(useEnableScheduleTrigger).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useEnableScheduleTrigger>,
  );
  vi.mocked(useRunScheduleTriggerNow).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useRunScheduleTriggerNow>,
  );
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
    mockSchedulePermissions({ read: true, create: true });
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

  it("lists existing schedules", () => {
    vi.mocked(useScheduleTriggers).mockReturnValue({
      data: { data: [SCHEDULE] },
    } as unknown as ReturnType<typeof useScheduleTriggers>);

    render(<ProjectSchedulesSection projectId="project-1" />);

    expect(screen.getByText("Weekly summary")).toBeInTheDocument();
    expect(screen.getByText("Reporter")).toBeInTheDocument();
  });
});
