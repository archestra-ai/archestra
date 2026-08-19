"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
const mockUpdateSecurityMutateAsync = vi.fn();

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

import AppsSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppsSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSecurityMutateAsync.mockResolvedValue({});
  mockOrganization = {
    newAppsDisabledByDefault: false,
    newAppsLockedByDefault: false,
  };
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
  vi.mocked(useUpdateSecuritySettings).mockReturnValue({
    mutateAsync: mockUpdateSecurityMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSecuritySettings>);
});

describe("AppsSettingsPage", () => {
  it("reflects the stored defaults", () => {
    mockOrganization = {
      newAppsDisabledByDefault: true,
      newAppsLockedByDefault: false,
    };
    renderPage();

    const [disabled, locked] = screen.getAllByRole("switch");
    expect(disabled).toBeChecked();
    expect(locked).not.toBeChecked();
  });

  it("offers no save until something actually changes", async () => {
    renderPage();

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await userEvent.click(screen.getAllByRole("switch")[0]);

    expect(
      await screen.findByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
  });

  it("sends both defaults so a save cannot drop the untouched one", async () => {
    mockOrganization = {
      newAppsDisabledByDefault: false,
      newAppsLockedByDefault: true,
    };
    renderPage();

    await userEvent.click(screen.getAllByRole("switch")[0]);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateSecurityMutateAsync).toHaveBeenCalledWith({
        newAppsDisabledByDefault: true,
        newAppsLockedByDefault: true,
      });
    });
  });

  it("restores the stored values on cancel", async () => {
    renderPage();

    await userEvent.click(screen.getAllByRole("switch")[0]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("switch")[0]).not.toBeChecked();
    });
    expect(mockUpdateSecurityMutateAsync).not.toHaveBeenCalled();
  });
});
