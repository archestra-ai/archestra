import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/knowledge/knowledge-bases",
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useCreateConnector: () => ({
    mutateAsync: mockMutateAsync,
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

describe("CreateConnectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(screen.queryByText(/Project Key/)).not.toBeInTheDocument();
    });
  });

  describe("Advanced section", () => {
    it("shows Jira-specific fields when expanded with Jira selected", async () => {
      const { user } = await renderConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText(/Project Key/)).toBeInTheDocument();
      });
      expect(screen.getByText(/JQL Query/)).toBeInTheDocument();
    });

    it("hides advanced fields when collapsed", async () => {
      const { user } = await renderConfigureStep();

      // Expand
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByText(/Project Key/)).toBeInTheDocument();
      });

      // Collapse
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.queryByText(/Project Key/)).not.toBeInTheDocument();
      });
    });

    it("does not duplicate the URL field inside Advanced section", async () => {
      const { user } = await renderConfigureStep();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText(/Project Key/)).toBeInTheDocument();
      });
      // Only one URL label should exist (the main one, not inside Advanced)
      const urlLabels = screen.getAllByText("URL");
      expect(urlLabels).toHaveLength(1);
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
});
