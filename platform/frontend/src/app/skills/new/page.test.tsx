import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
// Monaco does not render in jsdom; the canonical mock is a textarea.
vi.mock("@/components/editor");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/skills/skill.query");

vi.mock("../_parts/import-skills-dialog", () => ({
  ImportSkillsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="import-skills-dialog" /> : null,
}));
// Pulls its options over the network; the wizard only needs it to exist.
vi.mock("../_parts/skill-access-fields", () => ({
  SkillAccessFields: () => <div data-testid="skill-access-fields" />,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useCreateSkill,
  useSearchSkillCatalog,
} from "@/lib/skills/skill.query";
import NewSkillPage from "./page.client";

const createMutateAsync = vi.fn();
const routerPush = vi.fn();

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
  createMutateAsync.mockResolvedValue({ id: "skill-new" });
  vi.mocked(useRouter).mockReturnValue({
    push: routerPush,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/skills/new");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  vi.mocked(useSearchSkillCatalog).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useSearchSkillCatalog>);
  vi.mocked(useCreateSkill).mockReturnValue({
    mutateAsync: createMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateSkill>);
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

const contentEditor = () =>
  screen.queryByRole("textbox", { name: "File contents" });

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
    // The source step comes first; the editor waits for a choice.
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(contentEditor()).not.toBeInTheDocument();
  });

  it("hides the catalog and both entry points and opens on the editor when disabled", () => {
    mockOrganization(false);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Search skills by name/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Blank template")).not.toBeInTheDocument();
    // The blank-template editor opens directly, with no source step to go
    // back to.
    expect(contentEditor()).toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/skills",
    );
  });

  it("shows neither the catalog nor the editor while the org setting is loading", () => {
    mockOrganization(true, true);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    // No flash of the editor before the setting resolves.
    expect(contentEditor()).not.toBeInTheDocument();
  });

  it("fails closed — opens on the editor when the org read resolves without data", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: false,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByText("Popular repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom GitHub URL")).not.toBeInTheDocument();
    expect(contentEditor()).toBeInTheDocument();
  });
});

describe("NewSkillPage wizard", () => {
  it("walks source → content → access and lands on the created skill", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByText("Blank template"));
    expect(contentEditor()).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Skill name"));
    await user.type(screen.getByLabelText("Skill name"), "release-checklist");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(
      screen.getByLabelText("Description"),
      "Verify a release before shipping.",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByTestId("skill-access-fields")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create skill" }));

    // A create has no prior read to be stale about, so it is not anchored.
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    const body = createMutateAsync.mock.calls[0][0];
    expect(body).not.toHaveProperty("baseVersion");
    expect(body).toMatchObject({ scope: "personal", files: [] });
    expect(body.content).toContain('name: "release-checklist"');
    expect(body.content).toContain(
      'description: "Verify a release before shipping."',
    );
    expect(routerPush).toHaveBeenCalledWith("/skills/skill-new");
  });

  it("does not continue past content until the manifest names the skill", async () => {
    mockOrganization(false);
    renderPage();
    const user = userEvent.setup();

    const editor = screen.getByRole("textbox", { name: "File contents" });
    await user.clear(editor);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("goes back to the source step from the content step", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByText("Blank template"));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Popular repositories")).toBeInTheDocument();
  });
});
