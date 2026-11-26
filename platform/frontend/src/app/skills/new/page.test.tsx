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
  useSession,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useCreateSkill,
  useSearchSkillCatalog,
  useSkillsPaginated,
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
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
    // biome-ignore lint/suspicious/noExplicitAny: partial session is enough
  } as any);
  mockOwnSkills([]);
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

/** What the name lookup finds among the skills the reader can see. */
function mockOwnSkills(
  skills: Array<{ id: string; name: string; authorId: string | null }>,
) {
  vi.mocked(useSkillsPaginated).mockReturnValue({
    data: { data: skills },
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

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
    expect(screen.getByText("Git repository")).toBeInTheDocument();
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
    expect(screen.queryByText("Git repository")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Git repository")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Git repository")).not.toBeInTheDocument();
    expect(contentEditor()).toBeInTheDocument();
  });
});

describe("NewSkillPage wizard", () => {
  it("fills one page — content and access together — and lands on the created skill", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByText("Blank template"));
    expect(contentEditor()).toBeInTheDocument();
    expect(screen.getByLabelText("Skill name")).toHaveValue("");
    expect(screen.getByLabelText("Skill name")).toHaveAttribute(
      "placeholder",
      "release-checklist",
    );
    expect(screen.getByLabelText("Description")).toHaveValue("");
    await user.clear(screen.getByLabelText("Skill name"));
    await user.type(screen.getByLabelText("Skill name"), "release-checklist");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(
      screen.getByLabelText("Description"),
      "Verify a release before shipping.",
    );
    // Access is the end of the same page, not a step after it — the same
    // shape the skill's own page uses once it exists.
    expect(screen.getByTestId("skill-access-fields")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create skill" }));

    // A create has no prior read to be stale about, so it is not anchored.
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    const body = createMutateAsync.mock.calls[0][0];
    expect(body).not.toHaveProperty("baseVersion");
    expect(body).toMatchObject({ files: [] });
    // Access is the initial grants alone; the retired scope is not sent.
    expect(body).not.toHaveProperty("scope");
    expect(body.content).toContain('name: "release-checklist"');
    expect(body.content).toContain(
      'description: "Verify a release before shipping."',
    );
    expect(routerPush).toHaveBeenCalledWith("/skills/skill-new");
  });

  it("does not create a skill until the manifest names it", async () => {
    mockOrganization(false);
    renderPage();
    const user = userEvent.setup();

    const editor = screen.getByRole("textbox", { name: "File contents" });
    await user.clear(editor);
    expect(screen.getByRole("button", { name: "Create skill" })).toBeDisabled();
  });

  it("goes back to the source step from the form", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByText("Blank template"));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Popular repositories")).toBeInTheDocument();
  });
});

describe("NewSkillPage unsaved draft", () => {
  const fillName = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByText("Blank template"));
    await user.type(screen.getByLabelText("Skill name"), "release-checklist");
  };
  /** A link the page does not own, as the sidebar's are. */
  const outsideLink = () => {
    const link = document.createElement("a");
    link.href = "/plugins";
    link.textContent = "Plugins";
    document.body.appendChild(link);
    return link;
  };

  it("asks before a link elsewhere in the app discards the draft", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();
    await fillName(user);

    const link = outsideLink();
    await user.click(link);

    // The draft lives only on this page, so leaving it used to lose it
    // without a word.
    const prompt = await screen.findByRole("dialog");
    expect(prompt).toHaveTextContent("Discard unsaved changes?");
    expect(routerPush).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Skill name")).toHaveValue(
      "release-checklist",
    );
    expect(routerPush).not.toHaveBeenCalled();

    await user.click(link);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(routerPush).toHaveBeenCalledWith("/plugins");
    link.remove();
  });

  it("does not ask when nothing has been typed", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByText("Blank template"));

    const link = outsideLink();
    // Nothing intercepts the click, so the link is left to navigate.
    let prevented = true;
    link.addEventListener("click", (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    });
    await user.click(link);

    expect(prevented).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    link.remove();
  });

  it("moves between the wizard's own steps without asking, and keeps the draft", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();
    await fillName(user);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByText("Blank template"));
    expect(screen.getByLabelText("Skill name")).toHaveValue(
      "release-checklist",
    );
  });
});

describe("NewSkillPage name check", () => {
  const typeName = async (name: string) => {
    const user = userEvent.setup();
    await user.click(screen.getByText("Blank template"));
    await user.type(screen.getByLabelText("Skill name"), name);
    await user.type(screen.getByLabelText("Description"), "A skill.");
  };

  it("says before the save that the author already has the name in another letter case", async () => {
    mockOrganization(true);
    mockOwnSkills([
      { id: "skill-1", name: "probe-skill-one", authorId: "user-1" },
    ]);
    renderPage();
    await typeName("Probe-Skill-One");

    expect(screen.getByText("Name already in use")).toBeInTheDocument();
    expect(
      screen.getByText(/A skill named "probe-skill-one" by the same author/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Skill name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("button", { name: "Create skill" })).toBeDisabled();
  });

  it("leaves another author's skill of that name alone", async () => {
    mockOrganization(true);
    mockOwnSkills([
      { id: "skill-1", name: "probe-skill-one", authorId: "someone-else" },
    ]);
    renderPage();
    await typeName("Probe-Skill-One");

    expect(screen.queryByText("Name already in use")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create skill" })).toBeEnabled();
  });

  it("refuses a name that cannot be a folder name, and still takes one the Agent Skills rules would not publish", async () => {
    mockOrganization(true);
    renderPage();
    await typeName("docs/release");

    expect(screen.getByText("This name cannot be used")).toBeInTheDocument();
    expect(screen.getByText(/cannot contain a slash/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create skill" })).toBeDisabled();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Skill name"));
    await user.type(screen.getByLabelText("Skill name"), "Release Notes");
    expect(
      screen.queryByText("This name cannot be used"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create skill" })).toBeEnabled();
  });
});
