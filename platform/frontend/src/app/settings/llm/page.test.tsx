"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
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
const mockUpdateLlmSettingsMutateAsync = vi.fn();

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: false,
  }),
  useUpdateLlmSettings: () => ({
    mutateAsync: mockUpdateLlmSettingsMutateAsync,
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
  mockUpdateLlmSettingsMutateAsync.mockResolvedValue({});
  mockOrganization = {
    compressionScope: "organization",
    convertToolResultsToToon: true,
  };
  mockTeams = [];
});

describe("LlmSettingsPage", () => {
  it("links TOON compression help text to the costs and limits docs section", async () => {
    renderPage();

    const link = await screen.findByRole("link", {
      name: /learn how toon compression works/i,
    });

    expect(link).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformCostsAndLimits, "toon-compression"),
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  // The org-wide default user limit is no longer edited from the LLM settings
  // save bar (the old "Unset" button). It now lives in the unified
  // "Default user limits" list (a NULL-environment row with its own delete
  // action), whose CRUD is covered by the default-user-limit route tests.
});
