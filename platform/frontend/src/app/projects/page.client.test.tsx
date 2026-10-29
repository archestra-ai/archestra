import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

const mockRouterPush = vi.fn();
const mockCreateMutateAsync = vi.fn();
const mockDeleteMutateAsync = vi.fn();
const mockUpdateMutateAsync = vi.fn();
const mockBulkDeleteMutate = vi.fn();
/** The detail the edit dialog loads; tests override the pin and sharing. */
let mockEditingProject: Record<string, unknown> = {};
const mockPinMutate = vi.fn();
const mockRestoreMutate = vi.fn();
const mockPermanentlyDeleteMutateAsync = vi.fn();
const mockUseProjects = vi.fn();
const mockUseAllMatchingProjects = vi.fn();

let mockProjects: ProjectFixture[] = [];

type ApiKeyState = {
  hasAnyApiKey: boolean;
  isLoading: boolean;
  isLoadError: boolean;
  refetch: () => void;
};
let mockApiKeyState: ApiKeyState;

type ProjectFixture = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  viewerRole: "owner" | "shared" | "admin";
  ownerName: string | null;
  conversationCount: number;
  visibility: "organization" | "team" | null;
  shareTeamNames?: string[] | null;
  shareUserNames?: string[] | null;
  pinnedAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  labels: Array<{ key: string; value: string }>;
};

vi.mock("next/navigation");

// The edit dialog's Permissions page loads and saves the project's own policy.
// This suite is about the row actions and the General page, so it is stubbed
// rather than wiring the permission queries into every case.
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => <div>permissions</div>,
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search projects" />,
}));

vi.mock("@/components/resource-scope-filter", () => ({
  ResourceScopeFilter: () => <div>scope filter</div>,
  ResourceDeletedStatusFilter: () => <div>status filter</div>,
  useScopeFilterParams: () => ({
    scope: undefined,
    teamIds: undefined,
    authorIds: undefined,
    excludeAuthorIds: undefined,
    excludeOtherPersonal: true,
    hasActiveScopeFilters: false,
  }),
}));

vi.mock("@/components/entity-label-filter", () => ({
  EntityLabelFilter: () => <div>labels filter</div>,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/_parts/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    title,
    description,
    actionButton,
    children,
  }: {
    title: React.ReactNode;
    description?: string;
    actionButton?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {actionButton}
      {children}
    </main>
  ),
}));

vi.mock("@/components/no-api-key-setup", () => ({
  NoApiKeySetup: () => <div data-testid="no-api-key-setup" />,
}));

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: ({ icon }: { icon?: string | null }) => (
    <span>{icon ?? "project icon"}</span>
  ),
}));

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <button type="button">Pick icon</button>,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({
    open,
    title,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        {title}
        <button type="button" onClick={onConfirm}>
          Confirm
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/standard-dialog", () => ({
  StandardFormDialog: ({
    open,
    title,
    children,
    footer,
    onSubmit,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  }) =>
    open ? (
      <form onSubmit={onSubmit}>
        <h2>{title}</h2>
        {children}
        {footer}
      </form>
    ) : null,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type = "button",
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
    "aria-label"?: string;
  }) => (
    <button type={type} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

// The access filter is a real dropdown, which this file stubs flat.
vi.mock("@/components/resource-access-filter", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/resource-access-filter")
  >()),
  ResourceAccessFilter: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    onClick,
  }: {
    children: React.ReactNode;
    onSelect?: (event: Event) => void;
    onClick?: (event: React.MouseEvent) => void;
  }) => (
    <button
      type="button"
      onClick={(event) => {
        onSelect?.(event.nativeEvent);
        onClick?.(event);
      }}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useHasAnyApiKey: () => mockApiKeyState,
}));

vi.mock("@/components/api-key-load-error", () => ({
  ApiKeyLoadError: ({ onRetry }: { onRetry: () => void }) => (
    <button type="button" data-testid="api-key-load-error" onClick={onRetry}>
      retry
    </button>
  ),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

vi.mock("@/lib/projects/projects.query", () => ({
  // Records its filters: which slice the page asks for is the whole difference
  // between the trash and the active list, so a mock that dropped them would
  // stay green if the page stopped passing `status: "deleted"` and listed live
  // projects with Restore and Delete permanently on them.
  // Serves pages the way the endpoint does: split by `pinned`, cut by
  // limit/offset, with the total of the whole match.
  useProjects: (filters?: {
    status?: string;
    pinned?: boolean;
    limit?: number;
    offset?: number;
    enabled?: boolean;
  }) => {
    mockUseProjects(filters);
    const rows =
      filters?.pinned === undefined
        ? mockProjects
        : mockProjects.filter((p) => Boolean(p.pinnedAt) === filters.pinned);
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? rows.length;
    return {
      data: {
        data: rows.slice(offset, offset + limit),
        pagination: {
          currentPage: Math.floor(offset / Math.max(limit, 1)) + 1,
          limit,
          total: rows.length,
          totalPages: Math.ceil(rows.length / Math.max(limit, 1)),
          hasNext: offset + limit < rows.length,
          hasPrev: offset > 0,
        },
      },
      isPending: false,
    };
  },
  useAllMatchingProjects: (
    filters: { pinned?: boolean },
    options?: { enabled?: boolean },
  ) => {
    mockUseAllMatchingProjects(filters, options);
    return {
      data: options?.enabled
        ? mockProjects.filter((p) => Boolean(p.pinnedAt) === filters.pinned)
        : undefined,
      isFetching: false,
      isError: false,
    };
  },
  useCreateProject: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  useDeleteProject: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
  useBulkDeleteProjects: () => ({
    mutate: mockBulkDeleteMutate,
    isPending: false,
  }),
  useUpdateProject: () => ({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  }),
  usePinProject: () => ({ mutate: mockPinMutate }),
  useRestoreProject: () => ({ mutate: mockRestoreMutate, isPending: false }),
  usePermanentlyDeleteProject: () => ({
    mutateAsync: mockPermanentlyDeleteMutateAsync,
    isPending: false,
  }),
  // The edit dialog fetches the project detail by id; return a minimal one.
  useProject: () => ({ data: mockEditingProject }),
}));

let agentReferenceState: {
  data: Array<{ id: string; name: string; scope: string }> | undefined;
  isPending: boolean;
} = { data: [], isPending: false };
const agentRequests: URL[] = [];
let pendingReads: (() => void)[] = [];
const agentServer = setupServer(
  http.get("http://localhost:9000/api/agents/options", async ({ request }) => {
    const url = new URL(request.url);
    agentRequests.push(url);
    const state = agentReferenceState;
    if (state.isPending)
      await new Promise<void>((resolve) => pendingReads.push(resolve));
    return HttpResponse.json({
      data: state.data ?? [],
      pagination: { limit: 1000, hasNext: false, nextCursor: null },
    });
  }),
  http.get("http://localhost:9000/api/agents/options/page", ({ request }) => {
    agentRequests.push(new URL(request.url));
    return HttpResponse.json({
      data: agentReferenceState.data ?? [],
      pagination: { hasNext: false, nextCursor: null },
    });
  }),
);
beforeAll(() => agentServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  for (const resolve of pendingReads) resolve();
  pendingReads = [];
  agentServer.resetHandlers();
  agentRequests.length = 0;
});
afterAll(() => {
  agentServer.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function render(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderUI(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

vi.mock("@/lib/teams/team.query");

vi.mock("@/lib/schedule-trigger.query", () => ({
  useScheduleTriggers: () => ({ data: undefined }),
}));

import ProjectsPageClient from "./page.client";

describe("ProjectsPageClient", () => {
  beforeEach(() => {
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    agentReferenceState = { data: [], isPending: false };
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/projects");
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: true,
      isLoading: false,
    });
    mockProjects = [];
    mockApiKeyState = {
      hasAnyApiKey: true,
      isLoading: false,
      isLoadError: false,
      refetch: vi.fn(),
    };
    mockDeleteMutateAsync.mockResolvedValue(true);
    mockUpdateMutateAsync.mockResolvedValue(true);
    mockEditingProject = {
      id: "owner",
      name: "Owner project",
      description: null,
      icon: null,
      visibility: null,
      shareTeamIds: null,
      shareUserIds: null,
      viewerRole: "owner",
      defaultAgent: null,
      labels: [],
    };
    mockCreateMutateAsync.mockResolvedValue({ id: "created-project" });
    window.localStorage.clear();
  });

  it("shows pinned projects as tiles and the rest in the table", () => {
    mockProjects = [
      makeProject({ id: "plain", name: "Plain project" }),
      makeProject({
        id: "pinned",
        name: "Pinned project",
        description: "Quarterly planning",
        conversationCount: 3,
        pinnedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    render(<ProjectsPageClient />);

    const tiles = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(tiles).getByRole("link", { name: "Pinned project" }),
    ).toHaveAttribute("href", "/projects/pinned");
    expect(
      within(tiles).getByText("3 chats · Quarterly planning"),
    ).toBeInTheDocument();
    // The tile's one action starts a chat in the project.
    expect(
      within(tiles).getByRole("link", { name: "New chat" }),
    ).toHaveAttribute("href", "/chat?project=pinned");
    expect(within(tiles).queryByText("Plain project")).not.toBeInTheDocument();

    expect(screen.getByText("All projects")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Plain project")).toBeInTheDocument();
    expect(within(table).queryByText("Pinned project")).not.toBeInTheDocument();

    fireEvent.click(
      within(tiles).getByRole("button", { name: "Unpin Pinned project" }),
    );
    expect(mockPinMutate).toHaveBeenCalledWith({
      id: "pinned",
      pinned: false,
    });
  });

  it("shows no pinned tiles when no projects are pinned", () => {
    mockProjects = [
      makeProject({ id: "plain", name: "Plain project" }),
      makeProject({ id: "other", name: "Other project" }),
    ];

    render(<ProjectsPageClient />);

    expect(
      screen.queryByRole("region", { name: "Pinned" }),
    ).not.toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Plain project")).toBeInTheDocument();
    expect(within(table).getByText("Other project")).toBeInTheDocument();
  });

  it("offers pin, edit details, and delete on an owner's row", () => {
    mockProjects = [makeProject({ id: "owner", name: "Owner project" })];

    render(<ProjectsPageClient />);

    expect(
      screen.getByRole("button", { name: "Edit details Owner project" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Unpin Owner project" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pin Owner project" }));
    expect(mockPinMutate).toHaveBeenCalledWith({
      id: "owner",
      pinned: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete Owner project?")).toBeInTheDocument();
  });

  it("creates a project with a label", async () => {
    render(<ProjectsPageClient />);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Labelled project" },
    });
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    fireEvent.change(screen.getByLabelText("Label key"), {
      target: { value: "stage" },
    });
    fireEvent.change(screen.getByLabelText("Label value"), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Labelled project",
          labels: [{ key: "stage", value: "draft" }],
        }),
      ),
    );
  });

  it("edits project labels", async () => {
    mockProjects = [makeProject({ id: "owner", name: "Owner project" })];
    render(<ProjectsPageClient />);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit details Owner project" }),
    );
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    fireEvent.change(screen.getByLabelText("Label key"), {
      target: { value: "stage" },
    });
    fireEvent.change(screen.getByLabelText("Label value"), {
      target: { value: "ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "owner",
          labels: [{ key: "stage", value: "ready" }],
        }),
      ),
    );
  });

  it("hides the default-agent field from an editor without agent:read", () => {
    mockProjects = [makeProject({ id: "owner", name: "Owner project" })];

    render(<ProjectsPageClient />);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit details Owner project" }),
    );

    // An empty picker would read as "this org has no agents" rather than
    // "not yours to set".
    expect(screen.queryByText("Default agent")).not.toBeInTheDocument();
    expect(agentRequests).toHaveLength(0);
  });

  it("shows the default-agent field to an editor with agent:read", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.agent?.includes("read") === true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockProjects = [makeProject({ id: "owner", name: "Owner project" })];

    render(<ProjectsPageClient />);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit details Owner project" }),
    );

    expect(screen.getByText("Default agent")).toBeInTheDocument();
    expect(screen.getByText("Default agent")).toBeVisible();
  });

  describe("default agent, with agent:read granted", () => {
    const PINNED = { id: "pinned", name: "Pinned Agent", scope: "org" };

    beforeEach(() => {
      vi.mocked(useHasPermissions).mockImplementation(
        (permissions) =>
          ({
            data: permissions.agent?.includes("read") === true,
          }) as ReturnType<typeof useHasPermissions>,
      );
      mockProjects = [makeProject({ id: "owner", name: "Owner project" })];
      mockEditingProject = {
        ...mockEditingProject,
        defaultAgent: { id: PINNED.id, name: PINNED.name },
      };
    });

    it("keeps the saved pin selected once its explicit reference arrives", async () => {
      agentReferenceState = {
        data: [PINNED],
        isPending: false,
      };

      render(<ProjectsPageClient />);
      fireEvent.click(
        screen.getByRole("button", { name: "Edit details Owner project" }),
      );

      expect(await screen.findByText("Pinned Agent")).toBeInTheDocument();
      expect(
        agentRequests.every(
          (url) => url.searchParams.has("ids[]") || url.searchParams.has("ids"),
        ),
      ).toBe(true);
    });

    it("does not clear the saved pin while the agent list is still loading", () => {
      // Every agent looks unreachable against an empty list, so an unguarded
      // reset wipes the project's pin the moment the dialog opens.
      agentReferenceState = {
        data: undefined,
        isPending: true,
      };

      render(<ProjectsPageClient />);
      fireEvent.click(
        screen.getByRole("button", { name: "Edit details Owner project" }),
      );

      expect(screen.queryByText("Default")).not.toBeInTheDocument();
    });

    it("saves the project without a sharing payload", async () => {
      agentReferenceState = {
        data: [PINNED],
        isPending: false,
      };

      render(<ProjectsPageClient />);
      fireEvent.click(
        screen.getByRole("button", { name: "Edit details Owner project" }),
      );
      await screen.findByText("Pinned Agent");
      fireEvent.change(screen.getByLabelText("Name *"), {
        target: { value: "Renamed project" },
      });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockUpdateMutateAsync).toHaveBeenCalled());
      // Sharing is a permission policy now, saved through the permissions
      // block. The legacy columns this form used to write are read by nothing.
      const body = mockUpdateMutateAsync.mock.calls[0][0];
      expect(body).toEqual(
        expect.objectContaining({ id: "owner", name: "Renamed project" }),
      );
      expect(body).not.toHaveProperty("visibility");
      expect(body).not.toHaveProperty("teamIds");
      expect(body).not.toHaveProperty("userIds");
    });

    it("no longer offers the legacy sharing control", () => {
      render(<ProjectsPageClient />);
      fireEvent.click(
        screen.getByRole("button", { name: "Edit details Owner project" }),
      );

      expect(screen.queryByText("Sharing")).not.toBeInTheDocument();
      // Access is edited in place, below the project's own fields.
      expect(screen.getByText("permissions")).toBeVisible();
    });
  });

  it("shows the load-error retry state, not the add-key prompt, when the keys request fails", () => {
    const refetch = vi.fn();
    mockApiKeyState = {
      hasAnyApiKey: false,
      isLoading: false,
      isLoadError: true,
      refetch,
    };

    render(<ProjectsPageClient />);

    expect(screen.getByTestId("api-key-load-error")).toBeInTheDocument();
    expect(screen.queryByTestId("no-api-key-setup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("api-key-load-error"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the add-key prompt without the page header when the keys request succeeds with no keys", () => {
    mockApiKeyState = {
      hasAnyApiKey: false,
      isLoading: false,
      isLoadError: false,
      refetch: vi.fn(),
    };

    render(<ProjectsPageClient />);

    expect(screen.getByTestId("no-api-key-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("api-key-load-error")).not.toBeInTheDocument();
    // Matches the new-chat screen: the prompt stands alone, centered, with no
    // "Projects" header above it.
    expect(
      screen.queryByRole("heading", { name: "Projects" }),
    ).not.toBeInTheDocument();
  });

  it("keeps showing projects when a refetch fails but cached keys remain", () => {
    // A failed background refetch after a prior success is not a load error,
    // so the cached keys keep the project list on screen.
    mockApiKeyState = {
      hasAnyApiKey: true,
      isLoading: false,
      isLoadError: false,
      refetch: vi.fn(),
    };
    mockProjects = [makeProject({ id: "plain", name: "Plain project" })];

    render(<ProjectsPageClient />);

    expect(screen.queryByTestId("api-key-load-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("no-api-key-setup")).not.toBeInTheDocument();
    expect(screen.getByText("Plain project")).toBeInTheDocument();
  });

  it("offers restore and permanent delete in the trash view", () => {
    // ?status=deleted is the trash. A deleted project has no pin and no
    // route to navigate to, so it renders as a table of Restore + Delete
    // permanently and nothing else.
    // The trash is served to overseers of every project (`update` at `*`),
    // and restoring one is its `delete` grant, so the viewer holds both.
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.project !== undefined,
        }) as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=deleted") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockProjects = [
      makeProject({
        id: "trashed",
        name: "Trashed project",
        deletedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];

    render(<ProjectsPageClient />);

    // The deleted slice is a different request, not a client-side filter of
    // the active list — without this the rows below would be live projects.
    expect(mockUseProjects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );
    expect(screen.getByText("Trashed project")).toBeInTheDocument();
    expect(screen.queryByText("Edit details")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pin")).not.toBeInTheDocument();
    // The backend serves the deleted slice whole, ignoring search and scope, so
    // leaving those controls live would read as filters that do nothing.
    expect(screen.queryByLabelText("Search projects")).not.toBeInTheDocument();
    expect(screen.queryByText("scope filter")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Restore Trashed project"));
    expect(mockRestoreMutate).toHaveBeenCalledWith({ id: "trashed" });

    fireEvent.click(
      screen.getByLabelText("Delete permanently Trashed project"),
    );
    expect(screen.getByText("Delete project permanently")).toBeInTheDocument();
  });

  it("says the trash is empty rather than showing the no-projects prompt", () => {
    // "No projects yet" would read as an empty deployment; an empty trash is
    // a different, unalarming fact.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=deleted") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockProjects = [];

    render(<ProjectsPageClient />);

    expect(mockUseProjects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );
    expect(screen.getByText("No deleted projects")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
  });

  it("asks for the active slice everywhere but the trash", () => {
    mockProjects = [makeProject({ id: "plain", name: "Plain project" })];

    render(<ProjectsPageClient />);

    // The counterpart to the trash assertions: `status` left unset is what
    // makes the default view the live list rather than the deleted one.
    expect(mockUseProjects).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
    expect(screen.getByText("Plain project")).toBeInTheDocument();
  });

  it("asks for the pinned tiles and the table's page separately, the page from the URL", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("page=2&pageSize=10") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockProjects = [
      makeProject({
        id: "pinned",
        name: "Pinned project",
        pinnedAt: "2026-02-01T00:00:00.000Z",
      }),
      ...Array.from({ length: 15 }, (_, i) =>
        makeProject({ id: `p${i + 1}`, name: `Project ${i + 1}` }),
      ),
    ];

    render(<ProjectsPageClient />);

    expect(mockUseProjects).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true, limit: 100, offset: 0 }),
    );
    expect(mockUseProjects).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: false, limit: 10, offset: 10 }),
    );
    // The tile is shown on every page; the table holds page 2 alone.
    expect(screen.getByText("Pinned project")).toBeInTheDocument();
    expect(screen.getByText("Project 11")).toBeInTheDocument();
    expect(screen.getByText("Project 15")).toBeInTheDocument();
    expect(screen.queryByText("Project 10")).not.toBeInTheDocument();
  });

  it("keeps the pinned tiles and notes there are no other projects when every project is pinned", () => {
    mockProjects = [
      makeProject({
        id: "pinned",
        name: "Pinned project",
        pinnedAt: "2026-02-01T00:00:00.000Z",
      }),
    ];

    render(<ProjectsPageClient />);

    expect(screen.getByText("Pinned project")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
    expect(screen.getByText("All projects")).toBeInTheDocument();
    expect(screen.getByText("No other projects yet")).toBeInTheDocument();
  });

  it("selects every matching project across pages, not only the page in view", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data:
            permissions.project?.includes("update") === true ||
            permissions.project?.includes("delete") === true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockProjects = Array.from({ length: 25 }, (_, i) =>
      makeProject({ id: `p${i + 1}`, name: `Project ${i + 1}` }),
    );

    render(<ProjectsPageClient />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all projects on this page",
      }),
    );
    expect(mockUseAllMatchingProjects).not.toHaveBeenCalledWith(
      expect.anything(),
      { enabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: /Select all 25/ }));

    // The table's rows are the unpinned ones, so that is what "all" walks.
    expect(mockUseAllMatchingProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ pinned: false }),
      { enabled: true },
    );
    expect(
      screen.getAllByText("All 25 projects selected").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mockBulkDeleteMutate.mock.calls.at(-1)?.[0]).toHaveLength(25);
  });

  it("counts only the projects the bulk actions can change once every match is selected", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("pageSize=1") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    // A member: may update and delete their own projects, but holds no
    // grant on every project (the "*" scope), so a shared row is not theirs
    // to change.
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions, scope) =>
        ({
          data:
            scope !== "*" &&
            (permissions.project?.includes("update") === true ||
              permissions.project?.includes("delete") === true),
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockProjects = [
      makeProject({ id: "own-1", name: "Own one" }),
      makeProject({ id: "own-2", name: "Own two" }),
      makeProject({ id: "shared", name: "Shared one", viewerRole: "shared" }),
    ];

    render(<ProjectsPageClient />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all projects on this page",
      }),
    );
    // The offer counts every match the server reports...
    fireEvent.click(screen.getByRole("button", { name: /Select all 3/ }));
    // ...the selection counts what Delete and Edit sharing will act on.
    expect(
      screen.getAllByText("All 2 projects selected").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("All 3 projects selected"),
    ).not.toBeInTheDocument();
  });

  it("shows bulk actions and targets the selected project", async () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data:
            permissions.project?.includes("update") === true ||
            permissions.project?.includes("delete") === true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockProjects = [
      makeProject({ id: "first", name: "First project" }),
      makeProject({ id: "second", name: "Second project" }),
    ];

    render(<ProjectsPageClient />);

    expect(screen.queryByText("1 project selected")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select First project" }),
    );

    expect(screen.getAllByText("1 project selected")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mockBulkDeleteMutate).toHaveBeenCalledWith(
      [{ id: "first", name: "First project" }],
      expect.any(Object),
    );
  });
});

function makeProject(overrides: Partial<ProjectFixture>): ProjectFixture {
  return {
    id: "project-id",
    name: "Project",
    description: null,
    icon: null,
    viewerRole: "owner",
    ownerName: null,
    conversationCount: 0,
    visibility: null,
    pinnedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    labels: [],
    ...overrides,
  };
}
