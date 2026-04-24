import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KnowledgeBasesPage from "./page.client";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/knowledge/knowledge-bases",
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    ...props
  }: React.PropsWithChildren<React.ComponentPropsWithoutRef<"button">>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBasesPaginated: () => ({
    data: {
      data: [
        {
          id: "kb-1",
          name: "KB One",
          description: null,
          status: "active",
          totalDocsIndexed: 0,
          connectors: [],
          createdAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-04-02T00:00:00.000Z").toISOString(),
        },
      ],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
    isFetching: false,
  }),
  useCreateKnowledgeBase: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteKnowledgeBase: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useIsKnowledgeBaseConfigured: () => true,
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => ({ data: [], isPending: false }),
  useAssignConnectorToKnowledgeBases: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUnassignConnectorFromKnowledgeBase: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

describe("KnowledgeBasesPage", () => {
  it("navigates to KB detail page on row click", async () => {
    const user = userEvent.setup();
    render(<KnowledgeBasesPage />);

    await user.click(screen.getByText("KB One"));

    expect(mockPush).toHaveBeenCalledWith("/knowledge/knowledge-bases/kb-1");
  });
});
