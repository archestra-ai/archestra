import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { EditConnectorDialog } from "./edit-connector-dialog";

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  right: 100,
  bottom: 20,
  left: 0,
  toJSON: () => {},
});

if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {}
    static fromRect() {
      return new DOMRect();
    }
  } as unknown as typeof globalThis.DOMRect;
}

Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mockMutateAsync = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useUpdateConnector: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/teams/team.query");

import { useTeams } from "@/lib/teams/team.query";

type ConnectorFixture = Parameters<typeof EditConnectorDialog>[0]["connector"];

function makeAsanaConnector(
  overrides?: Partial<ConnectorFixture["config"]>,
): ConnectorFixture {
  return {
    id: "conn-asana-1",
    name: "Engineering Asana",
    description: "",
    visibility: "org-wide",
    syncPermissionsFromSource: false,
    teamIds: [],
    connectorType: "asana",
    environmentId: null,
    config: {
      type: "asana",
      workspaceGid: "1234567890",
      projectGids: ["111", "222"],
      tagsToSkip: ["internal", "draft"],
      ...overrides,
    },
    schedule: "0 */6 * * *",
    ftsLanguage: "english",
    permissionSyncIntervalSeconds: 1800,
    enabled: true,
  } as ConnectorFixture;
}

function renderDialog(connector: ConnectorFixture = makeAsanaConnector()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <EditConnectorDialog
        connector={connector}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );

  return { onOpenChange };
}

describe("EditConnectorDialog - GitHub repository settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({ id: "conn-github" });
  });

  const legacyConnector = () =>
    ({
      ...makeAsanaConnector(),
      id: "conn-github",
      connectorType: "github",
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "example-org",
        repos: ["repo-a", "repo-b"],
        includeIssues: false,
        includePullRequests: true,
        includeRepositoryFiles: true,
        includePaths: ["legacy"],
        labelsToSkip: ["skip"],
        repositoryPathFilters: [
          {
            repository: "repo-a",
            includePaths: ["docs"],
            excludePaths: ["docs/internal"],
          },
          {
            repository: "repo-b",
            includePaths: ["handbook"],
            excludePaths: ["drafts"],
          },
        ],
      },
    }) as ConnectorFixture;

  function loadedOverridesConnector(): ConnectorFixture {
    const connector = legacyConnector();
    connector.config = {
      ...connector.config,
      includeIssues: true,
      includePaths: ["docs"],
      repositoryOverrides: [
        {
          repository: "repo-a",
          includeIssues: false,
          includePaths: ["custom-docs"],
        },
      ],
    } as ConnectorFixture["config"];
    return connector;
  }

  function entryConnector(
    repos: string[],
    overrides: Record<string, unknown>[],
  ): ConnectorFixture {
    const connector = legacyConnector();
    connector.config = {
      ...connector.config,
      repos,
      repositoryOverrides: overrides,
    } as ConnectorFixture["config"];
    return connector;
  }

  async function openRow(
    user: ReturnType<typeof userEvent.setup>,
    repository: string,
  ) {
    const row = within(
      screen.getByRole("group", {
        name:
          repository === "All repositories"
            ? repository
            : `Repository ${repository}`,
      }),
    );
    await user.click(
      row.getByRole("button", {
        name: `Repository settings for ${repository}`,
      }),
    );
    return row;
  }
  it("shows concrete production controls and preserves untouched legacy representation", async () => {
    const user = userEvent.setup();
    renderDialog(legacyConnector());
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    expect(
      row
        .getAllByRole("switch")
        .map((element) => element.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "true"]);
    expect(row.getByLabelText("Folders (optional)")).toHaveValue("docs");
    expect(row.getByLabelText("Exclude paths")).toHaveValue("docs/internal");
    expect(screen.queryByText("Repository defaults")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Customize|Reset|Edit repository|Done/,
      }),
    ).not.toBeInTheDocument();
    expect(row.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const config = mockMutateAsync.mock.calls[0][0].body.config;
    expect(config).toMatchObject({
      repos: ["repo-a", "repo-b"],
      includeIssues: false,
      includePaths: ["legacy"],
      repositoryOverrides: [
        {
          repository: "repo-a",
          includePaths: ["docs"],
          excludePaths: ["docs/internal"],
        },
        {
          repository: "repo-b",
          includePaths: ["handbook"],
          excludePaths: ["drafts"],
        },
      ],
    });
    expect(config.repositoryOverrides[0]).not.toHaveProperty("includeIssues");
    expect(config).not.toHaveProperty("repositoryEntries");
  });
  it("changes one repository's switches and explicit empty lists without altering another", async () => {
    const user = userEvent.setup();
    renderDialog(loadedOverridesConnector());
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    expect(
      row.getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    await user.click(row.getByRole("switch", { name: "Include Issues" }));
    fireEvent.change(row.getByLabelText("Folders (optional)"), {
      target: { value: "" },
    });
    fireEvent.change(row.getByLabelText("Labels to Skip (optional)"), {
      target: { value: "" },
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      includeIssues: true,
      includePaths: ["docs"],
      repositoryOverrides: [
        {
          repository: "repo-a",
          includeIssues: true,
          includePaths: [],
          labelsToSkip: [],
        },
      ],
    });
  });
  it("keeps settings attached through a blank intermediate rename", async () => {
    const user = userEvent.setup();
    renderDialog(loadedOverridesConnector());
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "" },
    });
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "repo-c" },
    });
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: ["repo-c", "repo-b"],
      repositoryOverrides: [
        {
          repository: "repo-c",
          includeIssues: false,
          includePaths: ["custom-docs"],
        },
      ],
    });
  });
  it.each([
    "REPO-A",
    "Example-Org/repo-a",
  ])("rejects equivalent selected repository %s", async (duplicate) => {
    const user = userEvent.setup();
    renderDialog(entryConnector(["repo-a"], []));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    fireEvent.change(
      within(
        screen.getByRole("group", { name: "Repository New repository" }),
      ).getByLabelText("Repository"),
      {
        target: { value: duplicate },
      },
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(
      (await screen.findAllByText("Each repository can be selected only once"))
        .length,
    ).toBeGreaterThan(0);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "invalid/owner/repo",
    "repo-a,repo-b",
  ])("keeps invalid repository %s visible on save", async (name) => {
    const user = userEvent.setup();
    renderDialog(entryConnector(["repo-a"], []));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    fireEvent.change(
      within(
        screen.getByRole("group", { name: "Repository New repository" }),
      ).getByLabelText("Repository"),
      {
        target: { value: name },
      },
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(
      await screen.findByText(
        name ? "Use a repository name or owner/repo" : "Repository is required",
      ),
    ).toBeVisible();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
  it("uses qualified precedence and re-evaluates settings when owner changes", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a"],
        [
          { repository: "repo-a", includeIssues: false },
          {
            repository: "example-org/repo-a",
            includeIssues: true,
            includePaths: ["docs"],
          },
        ],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    let row = await openRow(user, "repo-a");
    expect(row.getByRole("switch", { name: "Include Issues" })).toBeChecked();
    expect(row.getByLabelText("Folders (optional)")).toHaveValue("docs");
    await user.click(screen.getByRole("button", { name: /General/ }));
    fireEvent.change(screen.getByLabelText(/^Owner$/), {
      target: { value: "new-owner" },
    });
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    row = within(screen.getByRole("group", { name: "Repository repo-a" }));
    expect(
      row.getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    expect(row.getByLabelText("Folders (optional)")).toHaveValue("legacy");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mockMutateAsync.mock.calls[0][0].body.config.repositoryOverrides,
    ).toHaveLength(2);
  });
  it("adopts retained inactive settings when adding or renaming an unconfigured repository", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a"],
        [{ repository: "repo-b", includeIssues: false }],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "repo-b" },
    });
    expect(
      row.getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: ["repo-b"],
      repositoryOverrides: [{ repository: "repo-b", includeIssues: false }],
    });
  });
  it("guards a rename that would collide with retained qualified settings", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a"],
        [
          { repository: "repo-a", includeIssues: true },
          { repository: "example-org/repo-b", includeIssues: false },
        ],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "repo-b" },
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(
      await screen.findByText(
        "This repository already has saved settings. Remove them before renaming this entry.",
      ),
    ).toBeVisible();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
  it("removes only a shadowed saved rule without deleting the qualified active rule", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a"],
        [
          { repository: "repo-a", includeIssues: false },
          { repository: "example-org/repo-a", includeIssues: true },
        ],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(
      screen.getByRole("button", { name: "Remove saved settings for repo-a" }),
    );
    const row = await openRow(user, "repo-a");
    expect(row.getByRole("switch", { name: "Include Issues" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mockMutateAsync.mock.calls[0][0].body.config.repositoryOverrides,
    ).toEqual([{ repository: "example-org/repo-a", includeIssues: true }]);
  });

  it("preserves a shared legacy rule while removing one equivalent selection", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a", "example-org/repo-a"],
        [{ repository: "repo-a", includeIssues: false }],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(
      screen.getByRole("button", { name: "Remove repository repo-a" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: ["example-org/repo-a"],
      repositoryOverrides: [{ repository: "repo-a", includeIssues: false }],
    });
  });
  it("preserves unrelated inactive settings when removing a selected repository", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a", "repo-b"],
        [
          { repository: "repo-a", includeIssues: false },
          { repository: "repo-c", includePaths: ["archive"] },
        ],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(
      screen.getByRole("button", { name: "Remove repository repo-a" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: ["repo-b"],
      repositoryOverrides: [
        { repository: "repo-c", includePaths: ["archive"] },
      ],
    });
  });
  it("reconciles discovery names when returning to selected repositories", async () => {
    const user = userEvent.setup();
    renderDialog(
      entryConnector(
        ["repo-a"],
        [{ repository: "repo-a", includeIssues: false }],
      ),
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(
      screen.getByRole("combobox", { name: "Repository selection" }),
    );
    await user.click(
      screen.getByRole("option", { name: "All accessible repositories" }),
    );
    const row = await openRow(user, "repo-a");
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "repo-b" },
    });
    await user.click(
      screen.getByRole("combobox", { name: "Repository selection" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Selected repositories" }),
    );
    await openRow(user, "repo-a");
    expect(
      within(
        screen.getByRole("group", { name: "Repository repo-a" }),
      ).getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("group", { name: "Repository repo-b (inactive)" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: ["repo-a"],
      repositoryOverrides: [{ repository: "repo-b", includeIssues: false }],
    });
  });
  it("keeps unnamed repository controls disabled and permits deliberate discovery", async () => {
    const user = userEvent.setup();
    renderDialog(entryConnector(["repo-a"], []));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    const row = within(
      screen.getByRole("group", { name: "Repository New repository" }),
    );
    expect(row.getByRole("switch", { name: "Include Issues" })).toBeDisabled();
    await user.click(row.getByRole("switch", { name: "Include Issues" }));
    await user.click(
      screen.getByRole("combobox", { name: "Repository selection" }),
    );
    await user.click(
      screen.getByRole("option", { name: "All accessible repositories" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: [],
      repositoryOverrides: [],
    });
  });

  it("allows deliberate discovery after an unfinished selected entry", async () => {
    const user = userEvent.setup();
    renderDialog(entryConnector(["repo-a"], []));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await user.click(
      screen.getByRole("combobox", { name: "Repository selection" }),
    );
    await user.click(
      screen.getByRole("option", { name: "All accessible repositories" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config.repos).toEqual([]);
  });
  it("shows the All repositories production controls without changing discovery on untouched save", async () => {
    const user = userEvent.setup();
    renderDialog(entryConnector([], []));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "All repositories");
    expect(
      row.getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    expect(row.getByLabelText("Folders (optional)")).toHaveValue("legacy");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      repos: [],
      repositoryOverrides: [],
      includePaths: ["legacy"],
    });
  });
  it("discards repository changes on cancel and restores saved controls on reopen", async () => {
    const user = userEvent.setup();
    const connector = legacyConnector();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Reopen connector</Button>
          <EditConnectorDialog
            connector={connector}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const row = await openRow(user, "repo-a");
    await user.click(row.getByRole("switch", { name: "Include Issues" }));
    fireEvent.change(row.getByLabelText("Repository"), {
      target: { value: "unsaved" },
    });
    await user.click(
      screen.getByRole("button", { name: "Remove repository repo-b" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Reopen connector" }));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const restored = await openRow(user, "repo-a");
    expect(
      restored.getByRole("switch", { name: "Include Issues" }),
    ).not.toBeChecked();
    expect(restored.getByLabelText("Folders (optional)")).toHaveValue("docs");
    expect(
      screen.getByRole("button", { name: "Remove repository repo-b" }),
    ).toBeVisible();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});

describe("EditConnectorDialog - Asana", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  it("submits array fields as arrays when the user does not edit them", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-asana-1" });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    expect(call[0]).toMatchObject({
      id: "conn-asana-1",
      body: {
        config: {
          type: "asana",
          workspaceGid: "1234567890",
          projectGids: ["111", "222"],
          tagsToSkip: ["internal", "draft"],
        },
      },
    });
    // apiToken was not changed -> credentials must be omitted to keep existing token
    expect(call[0].body).not.toHaveProperty("credentials");
  });

  it("re-parses edited array fields back into arrays on submit", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-asana-1" });
    const user = userEvent.setup();
    renderDialog();

    // User expands Advanced and rewrites the array fields as comma-separated strings
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Project GIDs/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Project GIDs/), {
      target: { value: "333, 444, 555" },
    });
    fireEvent.change(screen.getByLabelText(/Tags to Skip/), {
      target: { value: "wip, archived" },
    });

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    expect(call[0].body.config).toMatchObject({
      type: "asana",
      projectGids: ["333", "444", "555"],
      tagsToSkip: ["wip", "archived"],
    });
  });

  it("does not show the permissions sync frequency picker for a non-auto-sync connector", () => {
    renderDialog();
    expect(
      screen.queryByText("Permissions Sync Frequency"),
    ).not.toBeInTheDocument();
  });

  it("includes credentials only when a new token is provided", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-asana-1" });
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByLabelText(/Personal Access Token/), {
      target: { value: "new-pat-xyz" },
    });

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    expect(call[0].body.credentials).toEqual({ apiToken: "new-pat-xyz" });
    // Asana does not use the email field
    expect(call[0].body.credentials).not.toHaveProperty("email");
  });
});

describe("EditConnectorDialog - Jira admin API key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  function makeJiraAutoSyncConnector(): ConnectorFixture {
    return {
      id: "conn-jira-1",
      name: "Engineering Jira",
      description: "",
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "jira",
      environmentId: null,
      config: {
        type: "jira",
        jiraBaseUrl: "https://test.atlassian.net",
        isCloud: true,
        projectKey: "TEST",
      },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture;
  }

  it("submits the admin API key alone, without the API token", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-jira-1" });
    const user = userEvent.setup();
    renderDialog(makeJiraAutoSyncConnector());

    fireEvent.change(screen.getByLabelText(/Organization admin API key/), {
      target: { value: "org-admin-key" },
    });

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    // The backend merges submitted fields over the stored secret, so the
    // admin key must survive an empty token field instead of being dropped.
    expect(call[0].body.credentials).toEqual({ adminApiKey: "org-admin-key" });
  });

  it("keeps the connector requirement and the admin-key note on separate fields", () => {
    renderDialog(makeJiraAutoSyncConnector());

    // The API token is the identity whose Jira permissions decide what the
    // snapshot can read; the org admin key only resolves managed-account
    // emails. Two credentials, two problems, two docs sections.
    const apiTokenItem = screen
      .getByLabelText(/^API Token$/)
      .closest('[data-slot="form-item"]') as HTMLElement;
    expect(
      within(apiTokenItem).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/knowledge/connectors/jira#jira-auto-sync-permissions",
    );

    const adminKeyItem = screen
      .getByLabelText(/Organization admin API key/)
      .closest('[data-slot="form-item"]') as HTMLElement;
    expect(
      within(adminKeyItem).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/knowledge/connectors/jira#organization-admin-api-key",
    );
  });

  it("places the Jira admin key directly below the permission sync switch", () => {
    renderDialog(makeJiraAutoSyncConnector());
    const toggle = screen.getByRole("switch", {
      name: "Sync permissions from the source",
    });
    const adminKey = screen.getByLabelText(/Organization admin API key/);

    expect(toggle.parentElement?.nextElementSibling).toBe(
      adminKey.closest('[data-slot="form-item"]'),
    );
  });

  it("submits a corrected email alone, without re-entering the token", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-jira-1" });
    const user = userEvent.setup();
    renderDialog(makeJiraAutoSyncConnector());

    // Correcting a typo'd credential email must not be silently dropped just
    // because the token field is left empty to keep the existing token.
    fireEvent.change(screen.getByRole("textbox", { name: /^Email/ }), {
      target: { value: "correct@example.com" },
    });

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    expect(call[0].body.credentials).toEqual({ email: "correct@example.com" });
  });
});

describe("EditConnectorDialog - Perforce permission sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  function makePerforceAutoSyncConnector(): ConnectorFixture {
    return {
      id: "conn-p4-1",
      name: "Docs Depot",
      description: "",
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "perforce",
      environmentId: null,
      config: {
        type: "perforce",
        serverUrl: "https://perforce.example.com:8080",
        depotPaths: ["//depot/docs"],
        p4Port: "ssl:perforce.example.com:1666",
        adminUsername: "p4admin",
      },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture;
  }

  it("shows the permission sync fields with the stored config values", () => {
    renderDialog(makePerforceAutoSyncConnector());

    expect(screen.getByLabelText(/^P4 Port$/)).toHaveValue(
      "ssl:perforce.example.com:1666",
    );
    expect(screen.getByLabelText(/^Admin Username$/)).toHaveValue("p4admin");
    // The stored admin password never round-trips into the form.
    expect(screen.getByLabelText(/^Admin Password$/)).toHaveValue("");
  });

  it("points the admin account, not the ticket, at the Perforce setup docs", () => {
    renderDialog(makePerforceAutoSyncConnector());

    const adminPasswordItem = screen
      .getByLabelText(/^Admin Password$/)
      .closest('[data-slot="form-item"]') as HTMLElement;
    expect(adminPasswordItem).toHaveTextContent(
      /Auto-sync permissions needs an account that can read the full protections table/,
    );
    expect(
      within(adminPasswordItem).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/knowledge/connectors/perforce#perforce-auto-sync-permissions",
    );

    // The edit-mode note and the requirement share one description. Two
    // stacked description blocks under a single field read as a rendering bug.
    const descriptions = adminPasswordItem.querySelectorAll(
      '[data-slot="form-description"]',
    );
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toHaveTextContent(
      /Leave empty to keep the existing password\..*needs an account that can read the full protections table/,
    );

    // The login ticket belongs to the content identity, which only needs read
    // on the depot paths — putting the admin requirement there would be wrong.
    const loginTicketItem = screen
      .getByLabelText(/^Login Ticket$/)
      .closest('[data-slot="form-item"]') as HTMLElement;
    expect(
      within(loginTicketItem).queryByRole("link", { name: /Learn more/ }),
    ).not.toBeInTheDocument();
  });

  it("saves without a P4 port, which the backend derives from the Server URL", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-p4-1" });
    const user = userEvent.setup();
    const connector = makePerforceAutoSyncConnector();
    delete (connector.config as { p4Port?: string }).p4Port;
    renderDialog(connector);

    // The derived address is shown as the placeholder so it is not a mystery.
    expect(screen.getByLabelText(/^P4 Port$/)).toHaveAttribute(
      "placeholder",
      "perforce.example.com:1666 (derived from Server URL)",
    );

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    const [call] = mockMutateAsync.mock.calls;
    expect(call[0].body.config).not.toHaveProperty("p4Port");
    expect(call[0].body.config).toMatchObject({ adminUsername: "p4admin" });
  });

  it("keeps the stored admin password when the field is left blank", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-p4-1" });
    const user = userEvent.setup();
    renderDialog(makePerforceAutoSyncConnector());

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    // A blank password must not clobber the stored credential.
    expect(call[0].body).not.toHaveProperty("credentials");
    expect(call[0].body.config).toMatchObject({
      type: "perforce",
      p4Port: "ssl:perforce.example.com:1666",
      adminUsername: "p4admin",
    });
  });

  it("submits a new admin password alone, without the login ticket", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-p4-1" });
    const user = userEvent.setup();
    renderDialog(makePerforceAutoSyncConnector());

    fireEvent.change(screen.getByLabelText(/^Admin Password$/), {
      target: { value: "new-admin-password" },
    });

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    // The backend merges submitted fields over the stored secret, so the
    // admin password must survive an empty token field instead of being
    // dropped.
    expect(call[0].body.credentials).toEqual({
      adminApiKey: "new-admin-password",
    });
  });
});

describe("EditConnectorDialog - permission sync interval (auto-sync)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  function makeAutoSyncGithubConnector(): ConnectorFixture {
    return {
      id: "conn-gh-1",
      name: "Engineering GitHub",
      description: "",
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "github",
      environmentId: null,
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "pat",
      },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture;
  }

  it("shows the picker with the connector's saved interval and submits a new one", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-gh-1" });
    const user = userEvent.setup();
    renderDialog(makeAutoSyncGithubConnector());

    // The picker lives in the Advanced section, under the content schedule.
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(
      await screen.findByText("Permissions Sync Frequency"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: /Permissions Sync Frequency/ }),
    );
    // Saved 1800s marks its preset as the selected option.
    expect(
      await screen.findByRole("option", { name: "Every 30 minutes" }),
    ).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: "Every hour" }));

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const [call] = mockMutateAsync.mock.calls;
    expect(call[0].body.permissionSyncIntervalSeconds).toBe(3600);
  });
});

describe("EditConnectorDialog - Notion auto-sync limitation note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  function makeNotionConnector(
    visibility: ConnectorFixture["visibility"],
  ): ConnectorFixture {
    return {
      id: "conn-notion-1",
      name: "Company Notion",
      description: "",
      visibility,
      syncPermissionsFromSource: visibility === "auto-sync-permissions",
      teamIds: [],
      connectorType: "notion",
      environmentId: null,
      config: { type: "notion" },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture;
  }

  it("shows the workspace-audience note for auto-sync Notion", () => {
    renderDialog(makeNotionConnector("auto-sync-permissions"));

    const note = screen.getByText(
      /every synced page visible to all workspace members/,
    );
    expect(note).toBeInTheDocument();
    // The recommendation sentence rides in the same note. What the credential
    // itself needs lives on the Integration Token field instead, so this note
    // carries no docs link of its own.
    expect(note).toHaveTextContent(/Share only workspace-appropriate/);
    expect(within(note).queryByRole("link")).not.toBeInTheDocument();
  });

  it("hides the note for a Notion connector without auto-sync visibility", () => {
    renderDialog(makeNotionConnector("org-wide"));
    expect(
      screen.queryByText(/every synced page visible to all workspace members/),
    ).not.toBeInTheDocument();
  });

  it("does not show the Notion note on other auto-sync connector types", () => {
    renderDialog({
      id: "conn-gh-2",
      name: "Engineering GitHub",
      description: "",
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "github",
      environmentId: null,
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "pat",
      },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture);
    expect(
      screen.queryByText(/every synced page visible to all workspace members/),
    ).not.toBeInTheDocument();
  });
});

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
describe("EditConnectorDialog - permission sync capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
      typeof useTeams
    >);
    mockMutateAsync.mockResolvedValue({ id: "conn-jira-1" });
  });

  function makeJiraConnector(
    visibility: ConnectorFixture["visibility"],
    teamIds: string[] = [],
  ): ConnectorFixture {
    return {
      id: "conn-jira-1",
      name: "Engineering Jira",
      description: "",
      visibility,
      syncPermissionsFromSource: visibility === "auto-sync-permissions",
      teamIds,
      connectorType: "jira",
      environmentId: null,
      config: {
        type: "jira",
        jiraBaseUrl: "https://test.atlassian.net",
        isCloud: true,
        projectKey: "TEST",
      },
      schedule: "0 */6 * * *",
      ftsLanguage: "english",
      permissionSyncIntervalSeconds: 1800,
      enabled: true,
    } as ConnectorFixture;
  }

  it("keeps permission sync on when an unrelated field is saved", async () => {
    const user = userEvent.setup();
    renderDialog(makeJiraConnector("auto-sync-permissions"));

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const { body } = mockMutateAsync.mock.calls[0][0];
    expect(body.visibility).toBe("auto-sync-permissions");
    expect(body.permissionSyncIntervalSeconds).toBe(1800);
  });

  it("reads permission sync from its own column, not the visibility value", async () => {
    // A connector created since the create API dropped `visibility` carries
    // the switch alone; the dialog must show it on and keep it on.
    const user = userEvent.setup();
    renderDialog({
      ...makeJiraConnector("org-wide"),
      syncPermissionsFromSource: true,
    });

    expect(
      screen.getByRole("switch", { name: /Sync permissions from the source/ }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const { body } = mockMutateAsync.mock.calls[0][0];
    expect(body.visibility).toBe("auto-sync-permissions");
  });

  it("stops syncing permissions when the capability is switched off", async () => {
    const user = userEvent.setup();
    renderDialog(makeJiraConnector("auto-sync-permissions"));

    await user.click(
      screen.getByRole("switch", { name: /Sync permissions from the source/ }),
    );
    // The fields that only exist for a permission-syncing connector go with it.
    expect(
      screen.queryByLabelText(/Organization admin API key/),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const { body } = mockMutateAsync.mock.calls[0][0];
    expect(body.visibility).toBe("org-wide");
    expect(body).not.toHaveProperty("permissionSyncIntervalSeconds");
  });

  it("leaves a connector's stored sharing value alone on an ordinary save", async () => {
    const user = userEvent.setup();
    renderDialog(makeJiraConnector("team-scoped", ["engineering"]));

    // Sharing moved to grants, so the dialog no longer offers this choice —
    // and must not quietly rewrite the column it no longer shows.
    expect(
      screen.queryByRole("button", { name: /Teams Share/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const { body } = mockMutateAsync.mock.calls[0][0];
    expect(body.visibility).toBe("team-scoped");
    expect(body.teamIds).toEqual(["engineering"]);
  });
});

describe("EditConnectorDialog - SharePoint publication status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
      typeof useTeams
    >);
    mockMutateAsync.mockResolvedValue({ id: "conn-sharepoint-1" });
  });

  it.each([
    undefined,
    "draft",
    "published",
    "both",
  ] as const)("preserves %s on an unrelated edit", async (status) => {
    const user = userEvent.setup();
    renderDialog({
      ...makeAsanaConnector(),
      id: "conn-sharepoint-1",
      connectorType: "sharepoint",
      config: {
        type: "sharepoint",
        tenantId: "test-tenant",
        siteUrl: "https://tenant.sharepoint.com",
        pagePublicationStatus: status,
      },
    });
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(
      screen.getByRole("combobox", { name: "Page publication status" }),
    ).toHaveTextContent(
      status === "draft"
        ? "Draft only"
        : status === "published"
          ? "Published only"
          : "Both",
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mockMutateAsync.mock.calls[0][0].body.config.pagePublicationStatus,
    ).toBe(status);
  });

  it("saves a changed selection and preserves it while pages are disabled", async () => {
    const user = userEvent.setup();
    renderDialog({
      ...makeAsanaConnector(),
      id: "conn-sharepoint-1",
      connectorType: "sharepoint",
      config: {
        type: "sharepoint",
        tenantId: "test-tenant",
        siteUrl: "https://tenant.sharepoint.com",
      },
    });
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(
      screen.getByRole("combobox", { name: "Page publication status" }),
    );
    await user.click(screen.getByRole("option", { name: "Draft only" }));
    await user.click(screen.getByRole("switch", { name: "Include Pages" }));
    expect(
      screen.queryByRole("combobox", { name: "Page publication status" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Include Pages" }));
    expect(
      screen.getByRole("combobox", { name: "Page publication status" }),
    ).toHaveTextContent("Draft only");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      pagePublicationStatus: "draft",
      includePages: true,
    });
  });
});
// SPDX-SnippetEnd

describe("EditConnectorDialog - Salesforce OAuth migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
      typeof useTeams
    >);
  });
  function salesforceConnector(oauth: boolean): ConnectorFixture {
    return {
      ...makeAsanaConnector(),
      connectorType: "salesforce",
      config: {
        type: "salesforce",
        loginUrl: oauth
          ? "https://example.my.salesforce.com"
          : "https://login.salesforce.com",
        ...(oauth
          ? { authMethod: "oauth_client_credentials", clientId: "consumer-key" }
          : {}),
        objects: ["Account"],
      },
    } as ConnectorFixture;
  }
  it("preserves legacy authentication and stored credentials when saving an existing connector", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-salesforce" });
    const user = userEvent.setup();
    renderDialog(salesforceConnector(false));
    expect(
      screen.getByRole("combobox", { name: "Authentication" }),
    ).toHaveTextContent("Username/password (legacy)");
    expect(screen.queryByLabelText("Consumer Key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledOnce());
    expect(mockMutateAsync.mock.calls[0][0].body).toMatchObject({
      config: {
        authMethod: "soap_legacy",
        loginUrl: "https://login.salesforce.com",
        objects: ["Account"],
      },
    });
    expect(mockMutateAsync.mock.calls[0][0].body.credentials).toBeUndefined();
  });
  it("can return to legacy after exploring OAuth and keep stored credentials", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-salesforce" });
    const user = userEvent.setup();
    renderDialog(salesforceConnector(false));
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      screen.getByRole("option", {
        name: "OAuth client credentials (recommended)",
      }),
    );
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      screen.getByRole("option", { name: "Username/password (legacy)" }),
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledOnce());
    expect(mockMutateAsync.mock.calls[0][0].body.config).toMatchObject({
      authMethod: "soap_legacy",
      loginUrl: "https://login.salesforce.com",
    });
    expect(mockMutateAsync.mock.calls[0][0].body.credentials).toBeUndefined();
  });
  it("clears typed legacy credentials when switching to OAuth", async () => {
    const user = userEvent.setup();
    renderDialog(salesforceConnector(false));
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "legacy-password" },
    });
    fireEvent.change(screen.getByLabelText(/^Username/), {
      target: { value: "legacy@example.com" },
    });
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      screen.getByRole("option", {
        name: "OAuth client credentials (recommended)",
      }),
    );
    expect(screen.getByLabelText("Consumer Secret")).toHaveValue("");
    expect(screen.getByLabelText("My Domain URL")).toHaveValue("");
    expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument();
  });
  it("requires a replacement secret and submits an explicit OAuth configuration for a legacy connector", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-salesforce" });
    const user = userEvent.setup();
    renderDialog(salesforceConnector(false));
    expect(screen.getByText("Migrate before Summer ’27")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Username/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      screen.getByRole("option", {
        name: "OAuth client credentials (recommended)",
      }),
    );
    expect(
      screen.getByPlaceholderText(
        "Enter a new Salesforce OAuth consumer secret",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^My Domain URL$/), {
      target: { value: "https://example.my.salesforce.com" },
    });
    fireEvent.change(screen.getByLabelText(/^Consumer Key$/), {
      target: { value: "consumer-key" },
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Enter a new OAuth consumer secret to migrate this connector",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Consumer Secret$/), {
      target: { value: "consumer-secret" },
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledOnce());
    expect(mockMutateAsync.mock.calls[0][0].body).toMatchObject({
      config: {
        authMethod: "oauth_client_credentials",
        clientId: "consumer-key",
        loginUrl: "https://example.my.salesforce.com",
        objects: ["Account"],
      },
      credentials: { apiToken: "consumer-secret" },
    });
  });
  it("keeps the stored OAuth secret when editing a migrated connector", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-salesforce" });
    const user = userEvent.setup();
    renderDialog(salesforceConnector(true));
    expect(
      screen.queryByRole("combobox", { name: "Authentication" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledOnce());
    expect(mockMutateAsync.mock.calls[0][0].body.credentials).toBeUndefined();
  });
});
