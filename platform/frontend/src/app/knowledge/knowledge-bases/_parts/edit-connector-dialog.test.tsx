import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

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
    config: {
      type: "asana",
      workspaceGid: "1234567890",
      projectGids: ["111", "222"],
      tagsToSkip: ["internal", "draft"],
      ...overrides,
    },
    schedule: "0 */6 * * *",
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
