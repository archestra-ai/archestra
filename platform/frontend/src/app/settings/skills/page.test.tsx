import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateSkillsSettings,
} from "@/lib/organization.query";
import SkillsSettingsPage from "./page";

const mockMutateAsync = vi.fn();

function setPermission(hasPermission: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: hasPermission,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
}

function setOrganization(onlineSkillCatalogEnabled: boolean) {
  vi.mocked(useOrganization).mockReturnValue({
    data: { onlineSkillCatalogEnabled },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPermission(true);
  setOrganization(true);
  vi.mocked(useUpdateSkillsSettings).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSkillsSettings>);
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsSettingsPage />
    </QueryClientProvider>,
  );
}

describe("SkillsSettingsPage", () => {
  it("renders the online catalog setting", () => {
    renderPage();

    expect(screen.getByText("Online skill catalog")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent("Enabled");
  });

  it("reflects a disabled online catalog from the organization", () => {
    setOrganization(false);
    renderPage();

    expect(screen.getByRole("combobox")).toHaveTextContent("Disabled");
  });

  it("disables the control when the user cannot update Skills settings", () => {
    setPermission(false);
    renderPage();

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("shows a loading state instead of the control while the org is pending", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: true,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Online skill catalog")).not.toBeInTheDocument();
  });
});
