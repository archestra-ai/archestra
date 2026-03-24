"use client";

import { DocsPage, getDocsUrl } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
let mockTeams: Array<{
  id: string;
  name: string;
  description: string | null;
  convertToolResultsToToon: boolean;
}> = [];

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: false,
  }),
  useUpdateLlmSettings: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({
    data: mockTeams,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

import LlmSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LlmSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrganization = {
    compressionScope: "organization",
    convertToolResultsToToon: true,
    limitCleanupInterval: "1h",
  };
  mockTeams = [];
});

describe("LlmSettingsPage", () => {
  it("links TOON compression help text to the costs and limits docs section", () => {
    renderPage();

    const link = screen.getByRole("link", {
      name: /learn how toon compression works/i,
    });

    expect(link).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformCostsAndLimits, "toon-compression"),
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
