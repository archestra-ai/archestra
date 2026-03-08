import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockIsEmbeddingConfigured = false;

vi.mock("@/lib/organization.query", () => ({
  useIsEmbeddingConfigured: () => mockIsEmbeddingConfigured,
}));

vi.mock("@/lib/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
  usePathname: () => "/knowledge/knowledge-bases",
  useSearchParams: () => new URLSearchParams(),
}));

import { KnowledgePageLayout } from "./knowledge-page-layout";

function renderLayout(isPending = false) {
  const onCreateClick = vi.fn();
  return {
    onCreateClick,
    ...render(
      <KnowledgePageLayout
        title="Knowledge Bases"
        description="Manage your knowledge bases."
        createLabel="Create Knowledge Base"
        onCreateClick={onCreateClick}
        isPending={isPending}
      >
        <div data-testid="content">Knowledge base content here</div>
      </KnowledgePageLayout>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEmbeddingConfigured = false;
});

describe("KnowledgePageLayout", () => {
  describe("when embedding is NOT configured", () => {
    it("shows the embedding required placeholder", () => {
      renderLayout();

      expect(
        screen.getByText("Embedding configuration required"),
      ).toBeInTheDocument();
    });

    it("does not show the children content", () => {
      renderLayout();

      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
    });

    it("shows 'Go to Knowledge Settings' button", () => {
      renderLayout();

      expect(
        screen.getByRole("button", { name: /Go to Knowledge Settings/ }),
      ).toBeInTheDocument();
    });

    it("disables the create button", () => {
      renderLayout();

      const createButton = screen.getByRole("button", {
        name: /Create Knowledge Base/,
      });
      expect(createButton).toBeDisabled();
    });
  });

  describe("when embedding IS configured", () => {
    it("shows the children content", () => {
      mockIsEmbeddingConfigured = true;
      renderLayout();

      expect(screen.getByTestId("content")).toBeInTheDocument();
      expect(
        screen.getByText("Knowledge base content here"),
      ).toBeInTheDocument();
    });

    it("does not show the embedding required placeholder", () => {
      mockIsEmbeddingConfigured = true;
      renderLayout();

      expect(
        screen.queryByText("Embedding configuration required"),
      ).not.toBeInTheDocument();
    });

    it("enables the create button", () => {
      mockIsEmbeddingConfigured = true;
      renderLayout();

      const createButton = screen.getByRole("button", {
        name: /Create Knowledge Base/,
      });
      expect(createButton).not.toBeDisabled();
    });
  });

  describe("loading state", () => {
    it("shows loading spinner when isPending is true", () => {
      renderLayout(true);

      // Content and placeholder should not be visible
      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Embedding configuration required"),
      ).not.toBeInTheDocument();
    });
  });
});
