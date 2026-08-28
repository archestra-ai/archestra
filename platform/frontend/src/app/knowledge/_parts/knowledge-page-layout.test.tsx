import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockIsKnowledgeBaseConfigured = false;

let mockConfigStatus = { embedding: false, reranker: false };

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useIsKnowledgeBaseConfigured: () => mockIsKnowledgeBaseConfigured,
  useKnowledgeBaseConfigStatus: () => mockConfigStatus,
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

vi.mock("next/navigation");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useSmallTeamTier } from "@/lib/config/config.query";
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
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/knowledge/knowledge-bases");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  mockIsKnowledgeBaseConfigured = false;
  mockConfigStatus = { embedding: false, reranker: false };
});

describe("KnowledgePageLayout", () => {
  describe("when embedding is NOT configured", () => {
    it("shows the setup required placeholder", () => {
      renderLayout();

      expect(
        screen.getByText(
          "Connect your docs, drives, and repos so your agents answer from your knowledge",
        ),
      ).toBeInTheDocument();
    });

    it("does not show the children content", () => {
      renderLayout();

      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
    });

    it("shows 'Configure now' button", () => {
      renderLayout();

      expect(
        screen.getByRole("button", { name: /Configure now/ }),
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
      mockIsKnowledgeBaseConfigured = true;
      mockConfigStatus = { embedding: true, reranker: true };
      renderLayout();

      expect(screen.getByTestId("content")).toBeInTheDocument();
      expect(
        screen.getByText("Knowledge base content here"),
      ).toBeInTheDocument();
    });

    it("does not show the setup required placeholder", () => {
      mockIsKnowledgeBaseConfigured = true;
      mockConfigStatus = { embedding: true, reranker: true };
      renderLayout();

      expect(
        screen.queryByText(
          "Connect your docs, drives, and repos so your agents answer from your knowledge",
        ),
      ).not.toBeInTheDocument();
    });

    it("enables the create button", () => {
      mockIsKnowledgeBaseConfigured = true;
      mockConfigStatus = { embedding: true, reranker: true };
      renderLayout();

      const createButton = screen.getByRole("button", {
        name: /Create Knowledge Base/,
      });
      expect(createButton).not.toBeDisabled();
    });
  });

  describe("small team tier notice", () => {
    /**
     * Knowledge pages are working surfaces, so the licensing notice is an
     * icon beside the title rather than a block above the content: it stays
     * reachable without interrupting every visit to a page whose licensing
     * state has not changed.
     */
    it("offers the tier notice as a hover trigger, not a banner above the content", () => {
      vi.mocked(useSmallTeamTier).mockReturnValue({
        communicate: true,
        smallTeam: true,
        envFlag: false,
        userCount: 5,
        threshold: 30,
      } as ReturnType<typeof useSmallTeamTier>);
      renderLayout();

      expect(
        screen.getByRole("button", { name: /licensing for this feature/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/within the free tier for teams under 30 users/),
      ).not.toBeInTheDocument();
    });

    /**
     * The licence gates team-scoped connector visibility and auto-sync
     * permissions — not Knowledge as a whole. Creating knowledge bases,
     * indexing and retrieval keep working above the threshold, so the notice
     * must not tell an operator the feature has been switched off.
     */
    it("names the gated capabilities rather than declaring Knowledge disabled", async () => {
      vi.mocked(useSmallTeamTier).mockReturnValue({
        communicate: true,
        smallTeam: false,
        envFlag: false,
        userCount: 42,
        threshold: 30,
      } as ReturnType<typeof useSmallTeamTier>);
      renderLayout();

      await userEvent.hover(
        screen.getByRole("button", { name: /licensing for this feature/i }),
      );

      expect(
        await screen.findByText(
          /Enterprise features \(RBAC, SSO, Knowledge Base with access control\) are disabled until a license is activated\./,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Knowledge is an enterprise feature/),
      ).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows the shared loading state when isPending is true", () => {
      renderLayout(true);

      expect(screen.getByRole("status", { name: "Loading…" })).toBeVisible();
      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Embedding configuration required"),
      ).not.toBeInTheDocument();
    });
  });
});
