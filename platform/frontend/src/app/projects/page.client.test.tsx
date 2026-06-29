import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockDeleteMutateAsync = vi.fn();
const mockUpdateMutateAsync = vi.fn();
const mockPinMutate = vi.fn();

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
  pinnedAt: string | null;
  createdAt: string;
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects",
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search projects" />,
}));

vi.mock("@/components/project-scope-filter", () => ({
  ProjectScopeFilter: () => <div>scope filter</div>,
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
  DeleteConfirmDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div>{title}</div> : null,
}));

vi.mock("@/components/standard-dialog", () => ({
  StandardFormDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    open ? (
      <form>
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
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
  }) => (
    <button type={type} onClick={onClick}>
      {children}
    </button>
  ),
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
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
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

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: false }),
}));

vi.mock("@/lib/projects/projects.query", () => ({
  useProjects: () => ({ data: mockProjects, isPending: false }),
  useCreateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProject: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
  useUpdateProject: () => ({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  }),
  usePinProject: () => ({ mutate: mockPinMutate }),
  // The edit dialog fetches the project detail by id; return a minimal one.
  useProject: () => ({
    data: {
      id: "owner",
      name: "Owner project",
      description: null,
      icon: null,
      visibility: null,
      shareTeamIds: null,
    },
  }),
  useSetProjectShare: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

vi.mock("@/lib/schedule-trigger.query", () => ({
  useScheduleTriggers: () => ({ data: undefined }),
}));

import ProjectsPageClient from "./page.client";

describe("ProjectsPageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjects = [];
    mockApiKeyState = {
      hasAnyApiKey: true,
      isLoading: false,
      isLoadError: false,
      refetch: vi.fn(),
    };
    mockDeleteMutateAsync.mockResolvedValue(true);
    mockUpdateMutateAsync.mockResolvedValue(true);
  });

  it("shows the pinned section only when pinned projects exist", () => {
    mockProjects = [
      makeProject({
        id: "pinned",
        name: "Pinned project",
        pinnedAt: "2026-01-03T00:00:00.000Z",
      }),
      makeProject({ id: "plain", name: "Plain project" }),
    ];

    render(<ProjectsPageClient />);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("All projects")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pinned project")).not.toBeInTheDocument();
    expect(screen.getByText("Pinned project")).toBeInTheDocument();
    expect(screen.getByText("Plain project")).toBeInTheDocument();
  });

  it("omits the pinned section when no projects are pinned", () => {
    mockProjects = [
      makeProject({ id: "plain", name: "Plain project" }),
      makeProject({ id: "other", name: "Other project" }),
    ];

    render(<ProjectsPageClient />);

    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.queryByText("All projects")).not.toBeInTheDocument();
    expect(screen.getByText("Plain project")).toBeInTheDocument();
    expect(screen.getByText("Other project")).toBeInTheDocument();
  });

  it("shows pin, edit details, and delete in owner card menus", () => {
    mockProjects = [makeProject({ id: "owner", name: "Owner project" })];

    render(<ProjectsPageClient />);

    expect(screen.getByText("Pin")).toBeInTheDocument();
    expect(screen.getByText("Edit details")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Unpin")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Pin"));
    expect(mockPinMutate).toHaveBeenCalledWith({
      id: "owner",
      pinned: true,
    });

    fireEvent.click(screen.getByText("Edit details"));
    expect(
      screen.getByRole("heading", { name: "Edit project" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete Owner project?")).toBeInTheDocument();
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

  it("shows the add-key prompt when the keys request succeeds with no keys", () => {
    mockApiKeyState = {
      hasAnyApiKey: false,
      isLoading: false,
      isLoadError: false,
      refetch: vi.fn(),
    };

    render(<ProjectsPageClient />);

    expect(screen.getByTestId("no-api-key-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("api-key-load-error")).not.toBeInTheDocument();
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

  it("shows unpin in pinned project card menus", () => {
    mockProjects = [
      makeProject({
        id: "pinned-owner",
        name: "Pinned owner project",
        pinnedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    render(<ProjectsPageClient />);

    fireEvent.click(screen.getByText("Unpin"));
    expect(mockPinMutate).toHaveBeenCalledWith({
      id: "pinned-owner",
      pinned: false,
    });
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
    ...overrides,
  };
}
