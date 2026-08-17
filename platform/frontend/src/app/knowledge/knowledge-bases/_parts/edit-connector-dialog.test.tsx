import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      "https://archestra.ai/docs/platform-knowledge#jira-auto-sync-permissions",
    );

    const adminKeyItem = screen
      .getByLabelText(/Organization admin API key/)
      .closest('[data-slot="form-item"]') as HTMLElement;
    expect(
      within(adminKeyItem).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/platform-knowledge#atlassian-organization-admin-api-key",
    );
  });

  it("submits a corrected email alone, without re-entering the token", async () => {
    mockMutateAsync.mockResolvedValue({ id: "conn-jira-1" });
    const user = userEvent.setup();
    renderDialog(makeJiraAutoSyncConnector());

    // Correcting a typo'd credential email must not be silently dropped just
    // because the token field is left empty to keep the existing token.
    fireEvent.change(screen.getByLabelText(/Email/), {
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
      "https://archestra.ai/docs/platform-knowledge#perforce-auto-sync-permissions",
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
