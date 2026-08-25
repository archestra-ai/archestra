import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

function setOrganization(
  onlineSkillCatalogEnabled: boolean,
  skillMarketplaceAnonymousAccess = false,
) {
  vi.mocked(useOrganization).mockReturnValue({
    data: { onlineSkillCatalogEnabled, skillMarketplaceAnonymousAccess },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
}

/** The page has two selects; index them by the block they belong to. */
function catalogSelect() {
  return screen.getAllByRole("combobox")[0];
}

function marketplaceSelect() {
  return screen.getAllByRole("combobox")[1];
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
    expect(catalogSelect()).toHaveTextContent("Enabled");
  });

  it("reflects a disabled online catalog from the organization", () => {
    setOrganization(false);
    renderPage();

    expect(catalogSelect()).toHaveTextContent("Disabled");
  });

  it("disables the control when the user cannot update Skills settings", () => {
    setPermission(false);
    renderPage();

    expect(catalogSelect()).toBeDisabled();
    expect(marketplaceSelect()).toBeDisabled();
  });

  it("renders the marketplace access setting and reflects anonymous access", () => {
    renderPage();
    expect(screen.getByText("Skills marketplace access")).toBeInTheDocument();
    expect(marketplaceSelect()).toHaveTextContent("Require a token");

    cleanup();
    setOrganization(true, true);
    renderPage();
    expect(marketplaceSelect()).toHaveTextContent("Allow anonymous clones");
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
