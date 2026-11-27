import { describeUnusableSkillName } from "@archestra/shared";
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
  ImportSkillsDialog: ({
    open,
    onImported,
  }: {
    open: boolean;
    onImported: (skillIds: string[]) => void;
  }) =>
    open ? (
      <div data-testid="import-skills-dialog">
        <button type="button" onClick={() => onImported(["skill-imported"])}>
          Finish import
        </button>
      </div>
    ) : null,
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
  useExternalMcpSkills,
  usePluginSkills,
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
  // No MCP or plugin skills either way; whether any skill exists is then the
  // standalone total, which `mockOwnSkills` leaves unknown (so: not "none").
  for (const hook of [useExternalMcpSkills, usePluginSkills]) {
    vi.mocked(hook).mockReturnValue({
      data: [],
      isPending: false,
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
  }
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
      "e.g. release-checklist",
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
    // The starter files go with it: a script and a reference to edit from.
    expect(body.files.map((file: { path: string }) => file.path)).toEqual([
      "references/example.md",
      "scripts/example.sh",
    ]);
    expect(body.content).toContain("## When to use");
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
    const create = screen.getByRole("button", { name: "Create skill" });
    expect(create).toHaveAttribute("aria-disabled", "true");
    // The button says what is missing, one thing at a time.
    expect(create).toHaveAccessibleDescription("Enter a skill name.");
  });

  it("says a description is missing when only the name is given", async () => {
    mockOrganization(false);
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Skill name"), "hello");

    const create = screen.getByRole("button", { name: "Create skill" });
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(create).toHaveAccessibleDescription("Enter a description.");
    await user.type(screen.getByLabelText("Description"), "Says hello.");
    expect(
      screen.getByRole("button", { name: "Create skill" }),
    ).not.toHaveAttribute("aria-disabled");
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

  it("asks before a finished import leaves a draft typed earlier behind", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();
    await fillName(user);
    // Back to the source step, which keeps the draft, and import from there.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByText("Git repository"));
    await user.click(screen.getByRole("button", { name: "Finish import" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Discard unsaved changes?",
    );
    expect(routerPush).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(routerPush).toHaveBeenCalledWith("/skills?imported=skill-imported");
  });

  it("goes straight to the imported skills when there is no draft", async () => {
    mockOrganization(true);
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByText("Git repository"));
    await user.click(screen.getByRole("button", { name: "Finish import" }));

    expect(routerPush).toHaveBeenCalledWith("/skills?imported=skill-imported");
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

describe("NewSkillPage name and description checks", () => {
  const openBlank = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByText("Blank template"));
    return user;
  };
  const typeName = async (name: string) => {
    const user = await openBlank();
    await user.type(screen.getByLabelText("Skill name"), name);
    await user.type(screen.getByLabelText("Description"), "A skill.");
    return user;
  };
  const createButton = () =>
    screen.getByRole("button", { name: "Create skill" });
  const problem = (field: "name" | "description") =>
    document.getElementById(`skill-${field}-problem`);

  it("says before the save that the author already has the name", async () => {
    mockOrganization(true);
    mockOwnSkills([
      { id: "skill-1", name: "probe-skill-one", authorId: "user-1" },
    ]);
    renderPage();
    await typeName("probe-skill-one");

    // One sentence, the same as on the plugin form.
    expect(problem("name")).toHaveTextContent(
      "Name is already in use. Try another one.",
    );
    expect(screen.getByLabelText("Skill name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("leaves another author's skill of that name alone", async () => {
    mockOrganization(true);
    mockOwnSkills([
      { id: "skill-1", name: "probe-skill-one", authorId: "someone-else" },
    ]);
    renderPage();
    await typeName("probe-skill-one");

    expect(problem("name")).toBeNull();
    expect(createButton()).not.toHaveAttribute("aria-disabled");
  });

  it.each([
    "Release Notes",
    "docs/release",
    "pdf_tools",
    "PDF-Tools",
  ])("refuses the name %j, which breaks the Agent Skills naming rules, and links the rules", async (name) => {
    mockOrganization(true);
    renderPage();
    await typeName(name);

    // The words the API sends for the same name.
    expect(problem("name")).toHaveTextContent(
      describeUnusableSkillName(name) as string,
    );
    expect(problem("name")).toHaveTextContent(
      "This name can't be used. Skill name can only contain lowercase letters, digits and single hyphens, up to 64 characters.",
    );
    expect(
      screen.getByRole("link", {
        name: "lowercase letters, digits and single hyphens, up to 64 characters",
      }),
    ).toHaveAttribute(
      "href",
      "https://agentskills.io/specification#name-field",
    );
    expect(screen.getByLabelText("Skill name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // Refused, not warned about: there is no skill to create under it.
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/published over MCP/)).not.toBeInTheDocument();
  });

  it("takes a name the naming rules allow, with no notice", async () => {
    mockOrganization(true);
    renderPage();
    await typeName("release-notes");

    expect(problem("name")).toBeNull();
    expect(createButton()).not.toHaveAttribute("aria-disabled");
  });

  it("marks both fields as required", async () => {
    mockOrganization(true);
    renderPage();
    await openBlank();

    for (const label of ["Skill name", "Description"]) {
      const field = screen.getByLabelText(label);
      expect(field).toBeRequired();
      // The mark sits beside the label, which keeps its plain text.
      expect(
        screen.getByText(label, { selector: "label" }).parentElement,
      ).toHaveTextContent(`${label}*`);
    }
  });

  it("says a field is missing once it has been left empty, not before", async () => {
    mockOrganization(true);
    renderPage();
    const user = await openBlank();

    expect(problem("name")).toBeNull();
    expect(problem("description")).toBeNull();

    await user.click(screen.getByLabelText("Skill name"));
    await user.click(screen.getByLabelText("Description"));
    expect(problem("name")).toHaveTextContent("Enter a skill name.");
    expect(problem("description")).toBeNull();
    await user.tab();
    expect(problem("description")).toHaveTextContent("Enter a description.");
    expect(screen.getByLabelText("Description")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    await user.type(screen.getByLabelText("Description"), "Says hello.");
    expect(problem("description")).toBeNull();
    expect(screen.getByLabelText("Description")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("refuses a description longer than the Agent Skills specification takes, and links the limit", async () => {
    mockOrganization(true);
    renderPage();
    const user = await openBlank();
    await user.type(screen.getByLabelText("Skill name"), "release-notes");
    // Pasted: 1025 keystrokes would take the test seconds.
    await user.click(screen.getByLabelText("Description"));
    await user.paste("d".repeat(1025));

    expect(problem("description")).toHaveTextContent(
      "This description is too long. Skill description can be up to 1024 characters.",
    );
    expect(
      screen.getByRole("link", { name: "up to 1024 characters" }),
    ).toHaveAttribute(
      "href",
      "https://agentskills.io/specification#description-field",
    );
    expect(createButton()).toHaveAttribute("aria-disabled", "true");
    expect(createButton()).toHaveAccessibleDescription(
      "This description is too long. Skill description can be up to 1024 characters.",
    );
  });
});

describe("NewSkillPage as the first skill's page", () => {
  /** The viewer can see no skill of any kind. */
  function mockNoSkillsAtAll() {
    vi.mocked(useSkillsPaginated).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isPending: false,
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
  }

  it("introduces skills, with no list to go back to, while there are none", () => {
    mockOrganization(true);
    mockNoSkillsAtAll();
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Teach your agent" }),
    ).toBeVisible();
    expect(screen.getByText(/A skill teaches your agent/)).toHaveTextContent(
      "A skill teaches your agent how to do a specific task. It can be a simple SKILL.md file or bundled with scripts and example files. Add ready skills from marketplaces or write your own. Then share them with a single command.",
    );
    expect(screen.queryByRole("link", { name: "Skills" })).toBeNull();
    // The step itself is unchanged under the introduction.
    expect(screen.getByText("Blank template")).toBeVisible();
  });

  it("offers the whole skill as a download in the header once there is a form, not on the file editor", async () => {
    mockOrganization(true);
    const user = userEvent.setup();
    renderPage();
    // Nothing to download on the step that only picks a source.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

    await user.click(screen.getByText("Blank template"));

    expect(screen.getByRole("button", { name: "Download" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Download as .zip" }),
    ).toBeNull();
  });

  it("drops the introduction and links back to the list once a skill exists", () => {
    mockOrganization(true);
    vi.mocked(useSkillsPaginated).mockReturnValue({
      data: { data: [], pagination: { total: 3 } },
      isPending: false,
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.queryByText("Teach your agent")).toBeNull();
    expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute(
      "href",
      "/skills",
    );
  });

  it("counts a skill served by an MCP server as a skill that exists", () => {
    mockOrganization(true);
    mockNoSkillsAtAll();
    vi.mocked(useExternalMcpSkills).mockReturnValue({
      data: [{ id: "external-1" }],
      isPending: false,
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.queryByText("Teach your agent")).toBeNull();
  });

  it("still introduces skills to someone whose MCP skill list was refused", () => {
    mockOrganization(true);
    mockNoSkillsAtAll();
    // Answered with a refusal: no data, and not in flight any more.
    vi.mocked(useExternalMcpSkills).mockReturnValue({
      data: undefined,
      isPending: true,
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.getByText("Teach your agent")).toBeVisible();
  });

  it("holds the step until it knows whether skills exist, so nothing jumps", () => {
    mockOrganization(true);
    vi.mocked(useSkillsPaginated).mockReturnValue({
      data: undefined,
      isPending: true,
      isFetching: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    renderPage();

    expect(screen.queryByText("Blank template")).toBeNull();
    expect(screen.queryByText("Teach your agent")).toBeNull();
  });
});
