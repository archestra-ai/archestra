import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/skills/skill.query");

vi.mock("../_parts/import-skills-dialog", () => ({
  ImportSkillsDialog: () => <div data-testid="import-skills-dialog" />,
}));
vi.mock("../_parts/skill-editor-dialog", () => ({
  SkillEditorDialog: () => <div data-testid="skill-editor-dialog" />,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/lib/organization.query";
import { useSearchSkillCatalog } from "@/lib/skills/skill.query";
import NewSkillPage from "./page.client";

function mockOrganization(
  onlineSkillCatalogEnabled: boolean,
  isPending = false,
) {
  vi.mocked(useOrganization).mockReturnValue({
    data: isPending ? undefined : { onlineSkillCatalogEnabled },
    isPending,
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/skills/new");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useSearchSkillCatalog).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useSearchSkillCatalog>);
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewSkillPage />
    </QueryClientProvider>,
  );
}

describe("NewSkillPage catalog gating", () => {
  it("shows the popular-repositories catalog when the online catalog is enabled", () => {
    mockOrganization(true);
    renderPage();

    expect(screen.getByText("Popular repositories")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search skills by name/i),
    ).toBeInTheDocument();
  });

  it("hides the catalog and search when the online catalog is disabled", () => {
    mockOrganization(false);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Search skills by name/i),
    ).not.toBeInTheDocument();
    // The always-available manual entry points remain.
    expect(screen.getByText("Custom GitHub URL")).toBeInTheDocument();
    expect(screen.getByText("Blank template")).toBeInTheDocument();
  });

  it("hides the catalog while the org setting is still loading", () => {
    mockOrganization(true, true);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.getByText("Custom GitHub URL")).toBeInTheDocument();
  });

  it("fails closed — hides the catalog when the org read resolves without data", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: false,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.getByText("Custom GitHub URL")).toBeInTheDocument();
  });
});
