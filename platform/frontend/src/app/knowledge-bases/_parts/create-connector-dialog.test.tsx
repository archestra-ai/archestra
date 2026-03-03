import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/connector.query", () => ({
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

describe("CreateConnectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders all required fields visible by default", () => {
      renderDialog();

      expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
      expect(screen.getByText("Connector Type")).toBeInTheDocument();
      expect(screen.getByLabelText(/^URL$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^API Token$/)).toBeInTheDocument();
      expect(screen.getByText("Schedule")).toBeInTheDocument();
    });

    it("renders as a single-step dialog without step indicators", () => {
      renderDialog();

      expect(screen.queryByText("Next")).not.toBeInTheDocument();
      expect(screen.queryByText("Back")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create Connector" }),
      ).toBeInTheDocument();
    });

    it("renders the Advanced section collapsed by default", () => {
      renderDialog();

      expect(
        screen.getByRole("button", { name: /Advanced/ }),
      ).toBeInTheDocument();
      // Advanced fields should not be visible when collapsed
      expect(screen.queryByText("Cloud Instance")).not.toBeInTheDocument();
    });
  });

  describe("Advanced section", () => {
    it("shows Jira-specific fields when expanded with Jira selected", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText("Cloud Instance")).toBeInTheDocument();
      });
      expect(screen.getByText(/Project Key/)).toBeInTheDocument();
      expect(screen.getByText(/JQL Query/)).toBeInTheDocument();
    });

    it("hides advanced fields when collapsed", async () => {
      const user = userEvent.setup();
      renderDialog();

      // Expand
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.getByText("Cloud Instance")).toBeInTheDocument();
      });

      // Collapse
      await user.click(screen.getByRole("button", { name: /Advanced/ }));
      await waitFor(() => {
        expect(screen.queryByText("Cloud Instance")).not.toBeInTheDocument();
      });
    });

    it("does not duplicate the URL field inside Advanced section", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole("button", { name: /Advanced/ }));

      await waitFor(() => {
        expect(screen.getByText("Cloud Instance")).toBeInTheDocument();
      });
      // Only one URL label should exist (the main one, not inside Advanced)
      const urlLabels = screen.getAllByText("URL");
      expect(urlLabels).toHaveLength(1);
    });
  });

  describe("form validation", () => {
    it("shows validation error when name is empty", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(
        screen.getByRole("button", { name: "Create Connector" }),
      );

      await waitFor(() => {
        expect(screen.getByText("Name is required")).toBeInTheDocument();
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it("shows validation error when URL is empty", async () => {
      const user = userEvent.setup();
      renderDialog();

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
      const user = userEvent.setup();
      renderDialog();

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
      const user = userEvent.setup();
      renderDialog();

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
      const user = userEvent.setup();
      mockMutateAsync.mockResolvedValue({ id: "connector-1" });
      renderDialog();

      await user.type(screen.getByLabelText(/^Name$/), "Test Connector");
      await user.type(
        screen.getByLabelText(/^URL$/),
        "https://example.atlassian.net",
      );
      await user.type(screen.getByLabelText(/^Email$/), "user@example.com");
      await user.type(screen.getByLabelText(/^API Token$/), "my-secret-token");
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
});
