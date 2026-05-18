"use client";

import { DocsPage, getDocsUrl } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("lets admins unset the default user limit", async () => {
    mockOrganization = {
      compressionScope: "organization",
      convertToolResultsToToon: true,
      defaultUserLimitValue: 500,
      defaultUserLimitModel: null,
      defaultUserLimitCleanupInterval: "1w",
    };
    const user = userEvent.setup();

    renderPage();

    await user.click(await screen.findByRole("button", { name: "Unset" }));

    expect(screen.getByPlaceholderText("Disabled")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockUpdateLlmSettingsMutateAsync).toHaveBeenCalledWith({
      defaultUserLimitValue: null,
      defaultUserLimitModel: null,
      defaultUserLimitCleanupInterval: null,
    });
  });
});
