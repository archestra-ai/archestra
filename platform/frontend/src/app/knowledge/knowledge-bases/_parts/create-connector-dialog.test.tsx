import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectorSupportsAutoSync } from "./connector-dialog-config";
import { CreateConnectorDialog } from "./create-connector-dialog";

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix Popper needs getBoundingClientRect to return real values
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

// DOMRect polyfill for floating-ui
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

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mockMutateAsync = vi.fn();

vi.mock("next/navigation");

const mockStartGoogleDriveOAuth = vi.fn();
const MOCK_VAF_ADD_ON_DOWNLOAD_URL =
  "https://github.com/archestra-ai/archestra/releases/download/m-files-vaf-add-on-v1.0.0/archestra-m-files-vaf-add-on-1.0.0.mfappx";

// Both M-Files gates open by default: the suite exercises the M-Files form,
// including its Application Account (OAuth) fields. The gate tests flip
// individual flags through mockUseFeature.
const mockUseFeature = vi.fn((_key: string): boolean => true);
vi.mock("@/lib/config/config.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/config.query")>()),
  useFeature: (key: string) => mockUseFeature(key),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useCreateConnector: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
  useStartGoogleDriveOAuth: () => ({
    mutate: mockStartGoogleDriveOAuth,
    isPending: false,
  }),
  useMfilesVafAddOnDistribution: () => ({
    data: { packageDownloadUrl: MOCK_VAF_ADD_ON_DOWNLOAD_URL },
    isPending: false,
  }),
}));

function renderDialog(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <CreateConnectorDialog
        knowledgeBaseId="kg-1"
        open={open}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );

  return { onOpenChange };
}

/** Renders the dialog and selects Jira to advance to the configure step. */
async function renderConfigureStep() {
  const user = userEvent.setup();
  const result = renderDialog();
  await user.click(screen.getByText("Jira"));
  await waitFor(() => {
    expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
  });
  return { ...result, user };
}

async function renderGithubConfigureStep() {
  const user = userEvent.setup();
  const result = renderDialog();
  await user.click(screen.getByText("GitHub"));
  await waitFor(() => {
    expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
  });
  return { ...result, user };
}

describe("CreateConnectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeature.mockImplementation(() => true);
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/knowledge/knowledge-bases");
  });

  describe("rendering", () => {
    it("renders connector type selection on first step", () => {
      renderDialog();

      expect(screen.getByText("Add Connector")).toBeInTheDocument();
      expect(screen.getByText("Jira")).toBeInTheDocument();
      expect(screen.getByText("Confluence")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("GitLab")).toBeInTheDocument();
      expect(screen.getByText("Asana")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
      expect(screen.getByText("Salesforce")).toBeInTheDocument();
    });

    it("renders all required fields after selecting a connector type", async () => {
      await renderConfigureStep();

      expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^URL$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^API Token$/)).toBeInTheDocument();
    });

    it("renders Create Connector and Back buttons in configure step", async () => {
      await renderConfigureStep();

      expect(
        screen.getByRole("button", { name: "Create Connector" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    });

    it("renders the Advanced section collapsed by default", async () => {
      await renderConfigureStep();

      expect(
        screen.getByRole("button", { name: /Advanced/ }),
      ).toBeInTheDocument();
      // Cloud Instance is now in the main form, not Advanced
      expect(screen.getByText("Cloud Instance")).toBeInTheDocument();
      // Advanced-only fields should not be visible when collapsed
      expect(screen.queryByText(/Project Keys/)).not.toBeInTheDocument();
    });
  });

  describe("Advanced section", () => {
    it("shows Jira-specific fields when expanded with Jira selected", async () => {
      const { user } = await renderConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText(/Project Keys/)).toBeInTheDocument();
      });
      expect(screen.getByText(/JQL Query/)).toBeInTheDocument();
    });

    it("hides advanced fields when collapsed", async () => {
      const { user } = await renderConfigureStep();

      // Expand
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByText(/Project Keys/)).toBeInTheDocument();
      });

      // Collapse
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.queryByText(/Project Keys/)).not.toBeInTheDocument();
      });
    });

    it("does not duplicate the URL field inside Advanced section", async () => {
      const { user } = await renderConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText(/Project Keys/)).toBeInTheDocument();
      });
      // Only one URL label should exist (the main one, not inside Advanced)
      const urlLabels = screen.getAllByText("URL");
      expect(urlLabels).toHaveLength(1);
    });

    it("shows GitHub file types only when repository files are enabled", async () => {
      const { user } = await renderGithubConfigureStep();

      expect(screen.getByText("Owner")).toBeInTheDocument();
      expect(screen.getByText("Authentication Method")).toBeInTheDocument();
      expect(
        screen.queryByText("Labels to Skip (optional)"),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(
          screen.getByText("Include Repository Files"),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Labels to Skip (optional)")).toBeInTheDocument();
      expect(
        screen.queryByText("File Types (optional)"),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("switch", { name: /Include Repository Files/ }),
      );

      await waitFor(() => {
        expect(screen.getByText("File Types (optional)")).toBeInTheDocument();
      });
    });

    it("keeps GitHub authentication fields out of Advanced", async () => {
      const { user } = await renderGithubConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(
          screen.getByText("Include Repository Files"),
        ).toBeInTheDocument();
      });

      expect(screen.getAllByText("Authentication Method")).toHaveLength(1);
    });
  });

  describe("form validation", () => {
    it("shows validation error when name is empty", async () => {
      const { user } = await renderConfigureStep();

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(screen.getByText("Name is required")).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("shows validation error when URL is empty", async () => {
      const { user } = await renderConfigureStep();

      await user.type(screen.getByLabelText(/^Name$/), "Test Connector");
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(screen.getByText("URL is required")).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("shows validation error when email is empty", async () => {
      const { user } = await renderConfigureStep();

      await user.type(screen.getByLabelText(/^Name$/), "Test Connector");
      await user.type(
        screen.getByLabelText(/^URL$/),
        "https://example.atlassian.net",
      );
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(screen.getByText("Email is required")).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("shows validation error when API token is empty", async () => {
      const { user } = await renderConfigureStep();

      await user.type(screen.getByLabelText(/^Name$/), "Test Connector");
      await user.type(
        screen.getByLabelText(/^URL$/),
        "https://example.atlassian.net",
      );
      await user.type(screen.getByLabelText(/^Email$/), "user@example.com");
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(screen.getByText("API token is required")).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("submits the form with all required fields filled", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderConfigureStep();

      // Use fireEvent.change instead of user.type to avoid timeout from
      // simulating 77+ individual keystrokes across all fields.
      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Test Connector" },
      });
      fireEvent.change(screen.getByLabelText(/^URL$/), {
        target: { value: "https://example.atlassian.net" },
      });
      fireEvent.change(screen.getByLabelText(/^Email$/), {
        target: { value: "user@example.com" },
      });
      fireEvent.change(screen.getByLabelText(/^API Token$/), {
        target: { value: "my-secret-token" },
      });
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Connector",
          connectorType: "jira",
          credentials: {
            email: "user@example.com",
            apiToken: "my-secret-token",
          },
          schedule: "0 */6 * * *",
        }),
      );
    });
  });

  /**
   * Asana has a non-standard connector form: no URL field, no email field,
   * `workspaceGid` as the required primary config field instead. These tests
   * ensure that shape is preserved.
   */
  describe("Asana-specific flow", () => {
    async function renderAsanaConfigureStep() {
      const user = userEvent.setup();
      const result = renderDialog();
      await user.click(screen.getByText("Asana"));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      });
      return { ...result, user };
    }

    it("shows Workspace GID field and hides URL/Email fields", async () => {
      await renderAsanaConfigureStep();

      expect(screen.getByLabelText(/^Workspace GID$/)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^Personal Access Token$/),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText(/^URL$/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^Email$/)).not.toBeInTheDocument();
    });

    it("shows validation error when Workspace GID is empty", async () => {
      const { user } = await renderAsanaConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "My Asana" },
      });
      fireEvent.change(screen.getByLabelText(/^Personal Access Token$/), {
        target: { value: "pat-123" },
      });
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(
          screen.getByText("Workspace GID is required"),
        ).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("submits with Asana-shaped config (workspaceGid, no URL/email)", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderAsanaConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Engineering Asana" },
      });
      fireEvent.change(screen.getByLabelText(/^Workspace GID$/), {
        target: { value: "1234567890" },
      });
      fireEvent.change(screen.getByLabelText(/^Personal Access Token$/), {
        target: { value: "pat-abc" },
      });
      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });

      const [call] = mockMutateAsync.mock.calls;
      const payload = call[0];

      expect(payload).toMatchObject({
        name: "Engineering Asana",
        connectorType: "asana",
        credentials: { apiToken: "pat-abc" },
      });
      expect(payload.config).toMatchObject({
        type: "asana",
        workspaceGid: "1234567890",
      });
      // Asana credentials must NOT include an email (email field is Jira/Confluence-only)
      expect(payload.credentials).not.toHaveProperty("email");
    });

    it("submits optional projectGids and tagsToSkip as arrays", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderAsanaConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Engineering Asana" },
      });
      fireEvent.change(screen.getByLabelText(/^Workspace GID$/), {
        target: { value: "1234567890" },
      });
      fireEvent.change(screen.getByLabelText(/^Personal Access Token$/), {
        target: { value: "pat-abc" },
      });

      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByLabelText(/Project GIDs/)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Project GIDs/), {
        target: { value: "111, 222" },
      });
      fireEvent.change(screen.getByLabelText(/Tags to Skip/), {
        target: { value: "internal, draft" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });

      const [call] = mockMutateAsync.mock.calls;
      expect(call[0].config).toMatchObject({
        type: "asana",
        workspaceGid: "1234567890",
        projectGids: ["111", "222"],
        tagsToSkip: ["internal", "draft"],
      });
    });
  });

  describe("Web Crawler-specific flow", () => {
    async function renderWebCrawlerConfigureStep() {
      const user = userEvent.setup();
      const result = renderDialog();
      await user.click(screen.getByText("Web Crawler"));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      });
      return { ...result, user };
    }

    it("shows crawl fields and hides credential fields", async () => {
      await renderWebCrawlerConfigureStep();

      expect(screen.getByLabelText(/^Start URL$/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Email$/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Token/)).not.toBeInTheDocument();
    });

    it("submits crawl config without credentials", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderWebCrawlerConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Product Docs" },
      });
      fireEvent.change(screen.getByLabelText(/^Start URL$/), {
        target: { value: "https://docs.example.com/docs/" },
      });

      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(
          screen.getByLabelText(/Include Path Prefixes/),
        ).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/Include Path Prefixes/), {
        target: { value: "/docs/, /guides/" },
      });
      fireEvent.change(screen.getByLabelText(/Exclude Selectors/), {
        target: { value: ".sidebar, .toc" },
      });
      fireEvent.change(screen.getByLabelText(/^Max Pages/), {
        target: { value: "100" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });

      const [call] = mockMutateAsync.mock.calls;
      expect(call[0]).toMatchObject({
        name: "Product Docs",
        connectorType: "web_crawler",
      });
      expect(call[0]).not.toHaveProperty("credentials");
      expect(call[0].config).toMatchObject({
        type: "web_crawler",
        startUrl: "https://docs.example.com/docs/",
        includePathPrefixes: ["/docs/", "/guides/"],
        excludeSelectors: [".sidebar", ".toc"],
        maxPages: 100,
        maxDepth: 3,
        batchSize: 25,
      });
    });
  });

  describe("Salesforce-specific flow", () => {
    async function renderSalesforceConfigureStep() {
      const user = userEvent.setup();
      const result = renderDialog();
      await user.click(screen.getByText("Salesforce"));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      });
      return { ...result, user };
    }

    it("shows login URL and email/token fields for salesforce", async () => {
      await renderSalesforceConfigureStep();

      expect(screen.getByLabelText(/^Login URL$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^Password \+ Security Token$/),
      ).toBeInTheDocument();
    });

    it("does not expose batch size in the salesforce UI", async () => {
      const { user } = await renderSalesforceConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByLabelText(/Objects/)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/Batch Size/i)).not.toBeInTheDocument();
    });

    it("submits salesforce payload with transformed objects array", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderSalesforceConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Salesforce Connector" },
      });
      fireEvent.change(screen.getByLabelText(/^Login URL$/), {
        target: { value: "https://login.salesforce.com" },
      });
      fireEvent.change(screen.getByLabelText(/^Email$/), {
        target: { value: "admin@example.com" },
      });
      fireEvent.change(screen.getByLabelText(/^Password \+ Security Token$/), {
        target: { value: "passwordAndToken" },
      });

      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByLabelText(/Objects/)).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/Objects/), {
        target: { value: "Account, Contact, Opportunity" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });

      const [call] = mockMutateAsync.mock.calls;
      expect(call[0]).toMatchObject({
        name: "Salesforce Connector",
        connectorType: "salesforce",
        credentials: {
          email: "admin@example.com",
          apiToken: "passwordAndToken",
        },
      });
      expect(call[0].config).toMatchObject({
        type: "salesforce",
        loginUrl: "https://login.salesforce.com",
        objects: ["Account", "Contact", "Opportunity"],
      });
    });
  });

  describe("Perforce-specific flow", () => {
    async function renderPerforceConfigureStep() {
      const user = userEvent.setup();
      const result = renderDialog();
      await user.click(screen.getByText("Perforce (Helix Core)"));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      });
      return { ...result, user };
    }

    it("shows server address, depot paths, username, and token fields", async () => {
      await renderPerforceConfigureStep();

      expect(screen.getByLabelText(/^Server URL$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Depot Paths$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Username$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Login Ticket$/)).toBeInTheDocument();
    });

    it("submits perforce payload with transformed depot paths and file types", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderPerforceConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Docs Depot" },
      });
      fireEvent.change(screen.getByLabelText(/^Server URL$/), {
        target: { value: "https://perforce.example.com:8080" },
      });
      fireEvent.change(screen.getByLabelText(/^Depot Paths$/), {
        target: { value: "//depot/docs, //stream/main/specs" },
      });
      fireEvent.change(screen.getByLabelText(/^Username$/), {
        target: { value: "svc-knowledge" },
      });
      fireEvent.change(screen.getByLabelText(/^Login Ticket$/), {
        target: { value: "perforce-ticket" },
      });

      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByLabelText(/File Types/)).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/File Types/), {
        target: { value: ".md, .yaml" },
      });
      fireEvent.change(screen.getByLabelText(/Exclude Paths/), {
        target: { value: "//depot/docs/generated, //depot/docs/vendor" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });

      const [call] = mockMutateAsync.mock.calls;
      expect(call[0]).toMatchObject({
        name: "Docs Depot",
        connectorType: "perforce",
        credentials: {
          email: "svc-knowledge",
          apiToken: "perforce-ticket",
        },
      });
      expect(call[0].config).toMatchObject({
        type: "perforce",
        serverUrl: "https://perforce.example.com:8080",
        depotPaths: ["//depot/docs", "//stream/main/specs"],
        excludePaths: ["//depot/docs/generated", "//depot/docs/vendor"],
        fileTypes: [".md", ".yaml"],
      });
    });
  });

  describe("M-Files-specific flow", () => {
    async function renderMFilesConfigureStep() {
      const user = userEvent.setup();
      const result = renderDialog();
      // The M-Files tile appears only after the beta flag arrives with the
      // config query, so the first lookup must await it.
      await user.click(await screen.findByText("M-Files"));
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      });
      return { ...result, user };
    }

    it("hides the M-Files type while the connector gate is off", async () => {
      mockUseFeature.mockImplementation(
        (key) => key !== "kbMfilesConnectorEnabled",
      );
      renderDialog();
      expect(await screen.findByText("Jira")).toBeInTheDocument();
      expect(screen.queryByText("M-Files")).toBeNull();
    });

    it("hides the Authentication Method selector while the OAuth gate is off", async () => {
      mockUseFeature.mockImplementation(
        (key) => key !== "kbMfilesOauthEnabled",
      );
      await renderMFilesConfigureStep();
      expect(screen.queryByText("Authentication Method")).toBeNull();
      // Only the Login Account path remains.
      expect(screen.getByLabelText(/^Username$/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^OAuth Token Endpoint$/)).toBeNull();
    });

    it("shows every required field without expanding Advanced", async () => {
      const { user } = await renderMFilesConfigureStep();

      expect(
        screen.getByLabelText(/^M-Files Web Service URL$/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/^Vault GUID$/)).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Authentication Method" }),
      ).toBeInTheDocument();
      // Login Account is the default; its credential fields are on the main
      // form.
      expect(screen.getByLabelText(/^Username$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Password$/)).toBeInTheDocument();

      // Switching to Application Account surfaces every OAuth field on the
      // main form — a collapsed Advanced section must never hide a field
      // that can fail validation.
      await user.click(
        screen.getByRole("combobox", { name: "Authentication Method" }),
      );
      await user.click(
        screen.getByRole("option", { name: "Application Account" }),
      );
      expect(
        screen.getByLabelText(/^OAuth Token Endpoint$/),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^Authentication Configuration Name$/),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^Authentication Configuration Scope$/),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^Application Account Username$/),
      ).toBeInTheDocument();
      // Entra ID client credentials effectively require a scope, so the
      // scope/resource pair must not hide in Advanced.
      expect(screen.getByLabelText(/^Token Audience$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Client ID$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Client Secret$/)).toBeInTheDocument();
      expect(connectorSupportsAutoSync("mfiles")).toBe(true);
    });

    it("shows the static parameterless VAF Add On install command", async () => {
      await renderMFilesConfigureStep();

      // The add-on is a hard prerequisite — the connection test and every
      // sync preflight it — so its install panel must be visible without
      // expanding Advanced. The command is one static line: the backend's
      // script route carries the server-resolved package source, and the
      // installer picks the vault interactively, so nothing from the form
      // ever rides in the command.
      expect(screen.getByText(/^Archestra VAF Add On$/)).toBeInTheDocument();
      const command = () =>
        screen.getByText(/mfiles-vaf-add-on\/script/).textContent ?? "";
      expect(command()).toBe(
        `irm '${window.location.origin}/api/mfiles-vaf-add-on/script' | iex`,
      );

      fireEvent.change(screen.getByLabelText(/^M-Files Web Service URL$/), {
        target: { value: "https://mfiles.example.com/m-files" },
      });
      fireEvent.change(screen.getByLabelText(/^Vault GUID$/), {
        target: { value: "C840BE1A-5B47-4AC0-8EF7-835C166C8E24" },
      });
      expect(command()).toBe(
        `irm '${window.location.origin}/api/mfiles-vaf-add-on/script' | iex`,
      );

      // Manual paths live in the docs — a single link, no duplicates. Other
      // fields carry their own "Learn more" links, so match on the target.
      const docsLinks = screen
        .getAllByRole("link", { name: /Learn more/ })
        .filter(
          (link) =>
            link.getAttribute("href") ===
            "https://archestra.ai/docs/platform-knowledge#m-files-vaf-add-on",
        );
      expect(docsLinks).toHaveLength(1);
      // The manual path is the mutually exclusive alternative tab: the
      // script tab is pre-selected, and selecting Manual installation swaps
      // in a download of the newest released package.
      expect(
        screen.queryByRole("link", { name: /Download \.mfappx/ }),
      ).not.toBeInTheDocument();
      const manualTab = screen.getByRole("tab", {
        name: /Manual installation/,
      });
      fireEvent.mouseDown(manualTab);
      fireEvent.click(manualTab);
      const downloadLink = screen.getByRole("link", {
        name: /Download \.mfappx/,
      });
      expect(downloadLink).toHaveAttribute(
        "href",
        MOCK_VAF_ADD_ON_DOWNLOAD_URL,
      );
    });

    it("copying the add-on command does not submit the form", async () => {
      const { user } = await renderMFilesConfigureStep();

      fireEvent.change(screen.getByLabelText(/^M-Files Web Service URL$/), {
        target: { value: "https://mfiles.example.com/m-files" },
      });
      fireEvent.change(screen.getByLabelText(/^Vault GUID$/), {
        target: { value: "{C840BE1A-5B47-4AC0-8EF7-835C166C8E24}" },
      });

      // A button inside a form defaults to type="submit"; the copy button
      // must not trigger validation of unrelated required fields.
      await user.click(
        screen.getByRole("button", { name: /Copy to clipboard/ }),
      );
      expect(mockMutateAsync).not.toHaveBeenCalled();
      expect(
        screen.queryByText("OAuth token endpoint is required"),
      ).not.toBeInTheDocument();
    });

    it("flows in workflow order: add-on prerequisite, then the vault it printed, then URL, then authentication", async () => {
      await renderMFilesConfigureStep();

      const addOn = screen.getByText(/^Archestra VAF Add On$/);
      const url = screen.getByLabelText(/^M-Files Web Service URL$/);
      const vaultGuid = screen.getByLabelText(/^Vault GUID$/);
      const auth = screen.getByRole("combobox", {
        name: "Authentication Method",
      });
      const secret = screen.getByLabelText(/^Password$/);
      const follows = (earlier: Element, later: Element) =>
        Boolean(
          earlier.compareDocumentPosition(later) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      expect(follows(addOn, vaultGuid)).toBe(true);
      expect(follows(vaultGuid, url)).toBe(true);
      expect(follows(url, auth)).toBe(true);
      expect(follows(auth, secret)).toBe(true);
    });

    it("submits typed M-Files config", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderMFilesConfigureStep();

      // Login Account is the default; this flow exercises the OAuth path.
      await user.click(
        screen.getByRole("combobox", { name: "Authentication Method" }),
      );
      await user.click(
        screen.getByRole("option", { name: "Application Account" }),
      );

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Engineering M-Files" },
      });
      fireEvent.change(screen.getByLabelText(/^M-Files Web Service URL$/), {
        target: { value: "https://mfiles.example.com/m-files" },
      });
      // Bare GUID paste — the submit transform must brace-wrap it into the
      // format the backend requires.
      fireEvent.change(screen.getByLabelText(/^Vault GUID$/), {
        target: { value: "C840BE1A-5B47-4AC0-8EF7-835C166C8E24" },
      });
      fireEvent.change(screen.getByLabelText(/^Client ID$/), {
        target: { value: "00000000-0000-0000-0000-000000000042" },
      });
      fireEvent.change(screen.getByLabelText(/^Client Secret$/), {
        target: { value: "oauth-client-secret" },
      });
      fireEvent.change(screen.getByLabelText(/^OAuth Token Endpoint$/), {
        target: {
          value: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        },
      });
      fireEvent.change(
        screen.getByLabelText(/^Authentication Configuration Name$/),
        { target: { value: "Entra ID" } },
      );
      fireEvent.change(
        screen.getByLabelText(/^Authentication Configuration Scope$/),
        { target: { value: "technical" } },
      );
      fireEvent.change(
        screen.getByLabelText(/^Application Account Username$/),
        {
          target: { value: String.raw`integration\archestra` },
        },
      );
      fireEvent.change(screen.getByLabelText(/^Token Audience$/), {
        target: { value: "api://m-files/.default" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Engineering M-Files",
          connectorType: "mfiles",
          visibility: "org-wide",
          credentials: {
            email: "00000000-0000-0000-0000-000000000042",
            apiToken: "oauth-client-secret",
          },
          config: {
            type: "mfiles",
            baseUrl: "https://mfiles.example.com/m-files",
            vaultGuid: "{C840BE1A-5B47-4AC0-8EF7-835C166C8E24}",
            authMethod: "oauth_client_credentials",
            oauthTokenEndpoint:
              "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
            oauthAuthConfig: "Entra ID",
            oauthAuthConfigScope: "technical",
            oauthAccountName: String.raw`integration\archestra`,
            oauthScope: "api://m-files/.default",
          },
        }),
      );
    });

    it("submits a Login Account connector with username/password credentials", async () => {
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      const { user } = await renderMFilesConfigureStep();

      fireEvent.change(screen.getByLabelText(/^Name$/), {
        target: { value: "Vault Docs" },
      });
      fireEvent.change(screen.getByLabelText(/^M-Files Web Service URL$/), {
        target: { value: "https://mfiles.example.com/m-files" },
      });
      fireEvent.change(screen.getByLabelText(/^Vault GUID$/), {
        target: { value: "{C840BE1A-5B47-4AC0-8EF7-835C166C8E24}" },
      });
      fireEvent.change(screen.getByLabelText(/^Username$/), {
        target: { value: "svc-archestra" },
      });
      fireEvent.change(screen.getByLabelText(/^Password$/), {
        target: { value: "vault-password" },
      });

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Vault Docs",
          connectorType: "mfiles",
          credentials: {
            email: "svc-archestra",
            apiToken: "vault-password",
          },
          // No authMethod and no OAuth fields: the default Login Account
          // submit strips the seeded OAuth presets.
          config: {
            type: "mfiles",
            baseUrl: "https://mfiles.example.com/m-files",
            vaultGuid: "{C840BE1A-5B47-4AC0-8EF7-835C166C8E24}",
          },
        }),
      );
    });

    it("switches to Application Account credentials", async () => {
      const { user } = await renderMFilesConfigureStep();

      // The optional Windows domain of the default Login Account path lives
      // in Advanced with the other tuning.
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(
          screen.getByLabelText(/^Windows Domain \(optional\)$/),
        ).toBeInTheDocument();
      });

      // The authentication method lives on the main form: switching it must
      // not require opening Advanced.
      await user.click(
        screen.getByRole("combobox", { name: "Authentication Method" }),
      );
      await user.click(
        screen.getByRole("option", {
          name: "Application Account",
        }),
      );

      expect(screen.getByLabelText(/^Client ID$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Client Secret$/)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/^OAuth Token Endpoint$/),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Password$/)).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText(/^Windows Domain \(optional\)$/),
      ).not.toBeInTheDocument();
    });
  });
});
