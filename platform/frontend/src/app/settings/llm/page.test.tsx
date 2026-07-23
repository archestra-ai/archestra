"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
const { mockUpdateTeam } = vi.hoisted(() => ({ mockUpdateTeam: vi.fn() }));

vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@archestra/shared")>(
      "@archestra/shared",
    );
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      updateTeam: mockUpdateTeam,
    },
  };
});

vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateLlmSettings,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useOrganization).mockImplementation(
    () =>
      ({
        data: mockOrganization,
        isPending: false,
      }) as ReturnType<typeof useOrganization>,
  );
  vi.mocked(useUpdateLlmSettings).mockReturnValue({
    mutateAsync: mockUpdateLlmSettingsMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateLlmSettings>);
  vi.mocked(useTeams).mockImplementation(
    () =>
      ({
        data: mockTeams,
        isPending: false,
      }) as ReturnType<typeof useTeams>,
  );
});

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
  mockUpdateTeam.mockResolvedValue({ data: {} });
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

  it("shows no pending change when compression is disabled and no team opted in", async () => {
    mockOrganization = {
      compressionScope: "organization",
      convertToolResultsToToon: false,
    };
    mockTeams = [
      {
        id: "t1",
        name: "Alpha",
        description: null,
        convertToolResultsToToon: false,
      },
    ];

    renderPage();

    await screen.findByText("Apply compression to tool results");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("clears stored team opt-ins when saving the disabled mode", async () => {
    // The backend honors team-level opt-ins even when the org-level setting is
    // off (e.g. flags written via the API), so the page surfaces them as a
    // pending change and clears them on save to make "Disabled" mean disabled.
    mockOrganization = {
      compressionScope: "organization",
      convertToolResultsToToon: false,
    };
    mockTeams = [
      {
        id: "t1",
        name: "Alpha",
        description: null,
        convertToolResultsToToon: true,
      },
      {
        id: "t2",
        name: "Beta",
        description: null,
        convertToolResultsToToon: false,
      },
    ];

    renderPage();
    const user = userEvent.setup();

    const saveButton = await screen.findByRole("button", { name: "Save" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockUpdateLlmSettingsMutateAsync).toHaveBeenCalledWith({
        compressionScope: "organization",
        convertToolResultsToToon: false,
      });
    });
    // Only the opted-in team is written back, with the flag cleared.
    await waitFor(() => {
      expect(mockUpdateTeam).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdateTeam).toHaveBeenCalledWith({
      path: { id: "t1" },
      body: {
        name: "Alpha",
        description: undefined,
        convertToolResultsToToon: false,
      },
    });
  });
});
