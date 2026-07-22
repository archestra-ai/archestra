import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/skills/skill.query");

vi.mock("../_parts/import-skills-dialog", () => ({
  ImportSkillsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="import-skills-dialog" /> : null,
}));
vi.mock("../_parts/skill-editor-dialog", () => ({
  SkillEditorDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="skill-editor-dialog" /> : null,
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
  it("shows the catalog and both entry points when the online catalog is enabled", () => {
    mockOrganization(true);
    renderPage();

    expect(screen.getByText("Popular repositories")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search skills by name/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Custom GitHub URL")).toBeInTheDocument();
    expect(screen.getByText("Blank template")).toBeInTheDocument();
    // The blank-template form stays closed until the user opens it.
    expect(screen.queryByTestId("skill-editor-dialog")).not.toBeInTheDocument();
  });

  it("hides the catalog and both entry points and opens the blank form when disabled", () => {
    mockOrganization(false);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Search skills by name/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Blank template")).not.toBeInTheDocument();
    // The blank-template form opens directly.
    expect(screen.getByTestId("skill-editor-dialog")).toBeInTheDocument();
  });

  it("shows neither the catalog nor the form while the org setting is loading", () => {
    mockOrganization(true, true);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    // No flash of the blank form before the setting resolves.
    expect(screen.queryByTestId("skill-editor-dialog")).not.toBeInTheDocument();
  });

  it("fails closed — opens the blank form when the org read resolves without data", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: false,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    expect(screen.getByTestId("skill-editor-dialog")).toBeInTheDocument();
  });
});
