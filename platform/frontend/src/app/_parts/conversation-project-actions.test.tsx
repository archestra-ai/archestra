import { archestraApiClient, PROJECT_NAME_MAX_LENGTH } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { ConversationProjectActions } from "./conversation-project-actions";

vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";

type Project = { id: string; name: string; icon: string | null };
let serverProjects: Project[] = [];
const listRequests: URL[] = [];

// Searches the way the endpoint does, so the menu's results come from the
// server rather than from filtering a list it already holds.
const server = setupServer(
  http.get(`${API_ORIGIN}/api/projects`, ({ request }) => {
    const url = new URL(request.url);
    listRequests.push(url);
    const search = url.searchParams.get("search")?.toLowerCase() ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const matches = serverProjects.filter((p) =>
      p.name.toLowerCase().includes(search),
    );
    return HttpResponse.json({
      data: matches.slice(0, limit).map((p) => ({
        ...p,
        description: null,
        viewerRole: "owner",
        ownerName: null,
        createdBy: null,
        labels: [],
        conversationCount: 0,
        visibility: null,
        shareTeamNames: null,
        shareUserNames: null,
        pinnedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      })),
      pagination: {
        currentPage: 1,
        limit,
        total: matches.length,
        totalPages: Math.ceil(matches.length / limit),
        hasNext: matches.length > limit,
        hasPrev: false,
      },
    });
  }),
);

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  serverProjects = [
    { id: "project-1", name: "Research", icon: null },
    { id: "project-2", name: "Planning", icon: "P" },
  ];
  listRequests.length = 0;
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

/** Renders the actions inside an open menu, with the submenu closed. */
function renderMenu(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (content: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <DropdownMenu open modal={false}>
        <DropdownMenuContent>{content}</DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  );
  const result = renderComponent(wrap(children));
  return {
    ...result,
    rerender: (content: ReactNode) => result.rerender(wrap(content)),
  };
}

function openSubmenu() {
  fireEvent.keyDown(screen.getByText("Change project"), { key: "ArrowRight" });
}

/** Renders and opens the submenu, waiting for its first results. */
async function render(children: ReactNode) {
  const result = renderMenu(children);
  openSubmenu();
  await screen.findByRole("combobox");
  await waitFor(() =>
    expect(screen.queryByText("Loading projects...")).not.toBeInTheDocument(),
  );
  return result;
}

describe("ConversationProjectActions", () => {
  it("asks for projects only once the submenu opens", async () => {
    renderMenu(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Change project")).toBeInTheDocument();
    expect(listRequests).toHaveLength(0);

    openSubmenu();
    expect(
      await screen.findByRole("option", { name: "Research" }),
    ).toBeVisible();
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0].searchParams.get("limit")).toBe("50");
  });

  it("searches on the server as the user types", async () => {
    const user = userEvent.setup();
    serverProjects = [
      ...serverProjects,
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `bulk-${i}`,
        name: `Bulk ${i}`,
        icon: null,
      })),
    ];
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={vi.fn()}
      />,
    );
    // Only the first page of a large list is in the menu...
    expect(screen.queryByRole("option", { name: "Bulk 59" })).toBeNull();

    await user.type(screen.getByRole("combobox"), "bulk 59");
    // ...and a project beyond it is found by asking the server.
    expect(
      await screen.findByRole("option", { name: "Bulk 59" }),
    ).toBeVisible();
    expect(listRequests.at(-1)?.searchParams.get("search")).toBe("bulk 59");
  });

  it("moves a chat without a project into a selected project", async () => {
    const onProjectChange = vi.fn();
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={onProjectChange}
      />,
    );

    expect(screen.queryByText("Remove from project")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Research" }));
    expect(onProjectChange).toHaveBeenCalledWith("project-1");
  });

  it("changes or removes a chat that already belongs to a project", async () => {
    const onProjectChange = vi.fn();
    await render(
      <ConversationProjectActions
        projectId="project-1"
        isPending={false}
        onProjectChange={onProjectChange}
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /Planning/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from project" }),
    );

    expect(onProjectChange).toHaveBeenNthCalledWith(1, "project-2");
    expect(onProjectChange).toHaveBeenNthCalledWith(2, null);
  });
});

describe("inline project creation", () => {
  it("creates a project by typing a trimmed name and pressing Enter in an empty picker", async () => {
    serverProjects = [];
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onProjectChange = vi.fn();
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
      />,
    );
    expect(screen.getByText("No projects yet.")).toBeVisible();
    await user.type(screen.getByRole("combobox"), "  New research  ");
    expect(
      await screen.findByRole("option", {
        name: 'Create project "New research"',
      }),
    ).toBeVisible();
    await user.keyboard("{Enter}");
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith("New research");
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it("selects an existing project rather than creating a case-insensitive duplicate", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onProjectChange = vi.fn();
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), "research");
    await screen.findByText((_, el) =>
      Boolean(
        el?.getAttribute("role") === "option" &&
          listRequests.at(-1)?.searchParams.get("search") === "research",
      ),
    );
    expect(
      screen.queryByRole("option", { name: /Create project/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onProjectChange).toHaveBeenCalledWith("project-1");
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("offers creation when searching existing projects has no matches", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    await render(
      <ConversationProjectActions
        projectId="project-1"
        isPending={false}
        onProjectChange={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), "Invoices");
    expect(
      await screen.findByRole("option", { name: 'Create project "Invoices"' }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Research" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith("Invoices");
  });

  it.each([
    "   ",
    "x".repeat(PROJECT_NAME_MAX_LENGTH + 1),
  ])("rejects invalid project names", async (name) => {
    serverProjects = [];
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );
    await user.type(screen.getByRole("combobox"), name);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("does not offer creation without permission", async () => {
    serverProjects = [];
    const user = userEvent.setup();
    await render(
      <ConversationProjectActions
        projectId={null}
        isPending={false}
        onProjectChange={vi.fn()}
      />,
    );
    await user.type(screen.getByRole("combobox"), "Invoices");
    expect(await screen.findByText("No projects found.")).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("blocks creation while a mutation is pending", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const props = {
      projectId: null,
      isPending: false,
      onProjectChange: vi.fn(),
      onCreateProject,
    };
    const { rerender } = await render(
      <ConversationProjectActions {...props} />,
    );
    await user.type(screen.getByRole("combobox"), "Invoices");
    await screen.findByRole("option", { name: 'Create project "Invoices"' });
    rerender(<ConversationProjectActions {...props} isPending />);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(onCreateProject).not.toHaveBeenCalled();
  });
});
