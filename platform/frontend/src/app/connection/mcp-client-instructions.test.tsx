import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { CONNECT_CLIENTS } from "./clients";
import { McpClientInstructions } from "./mcp-client-instructions";

const { userTokenMock, fetchUserTokenValueMock } = vi.hoisted(() => ({
  userTokenMock: vi.fn(),
  fetchUserTokenValueMock: vi.fn(),
}));

vi.mock("@/lib/user-token.query", () => ({
  useUserToken: () => userTokenMock(),
  useFetchUserTokenValue: () => ({
    mutateAsync: fetchUserTokenValueMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/hooks/use-app-name");

vi.mock("sonner");

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

const genericClient = findClient("generic");

function renderInstructions() {
  return render(
    <McpClientInstructions
      client={genericClient}
      gatewaySlug="my-gateway"
      gatewayName="My Gateway"
      baseUrl="http://localhost:9000"
    />,
  );
}

/** The auth-header row: the container around the `Bearer …` preview. */
function getTokenRow(preview: string) {
  const row = screen.getByText(preview).closest("div");
  if (!row) throw new Error("Token row container not found");
  return within(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  userTokenMock.mockReturnValue({
    data: {
      id: "ut-1",
      name: "Personal",
      tokenStart: "archestra_abc",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    },
  });
  fetchUserTokenValueMock.mockResolvedValue({
    value: "archestra_personal_real",
  });
});

describe("static-token copy", () => {
  it("copies the real personal token only via the explicit menu action", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_abc***");

    await user.click(row.getByRole("button", { name: "Copy" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with real token" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Bearer archestra_personal_real"),
    );
    // Copying must not reveal the token on screen.
    expect(screen.getByText("Bearer archestra_abc***")).toBeInTheDocument();
  });

  it("copies an obviously-fake placeholder via the placeholder action", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_abc***");

    await user.click(row.getByRole("button", { name: "Copy" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with placeholder" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Bearer archestra_TOKEN"),
    );
    expect(fetchUserTokenValueMock).not.toHaveBeenCalled();
  });

  it("points automation at service accounts instead of offering shared tokens", async () => {
    const user = userEvent.setup();
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));

    expect(
      screen.queryByRole("button", { name: "Switch token" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "service account" }),
    ).toHaveAttribute("href", "/settings/service-accounts");
  });

  it("hides the service account pointer from users who cannot open it", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    const user = userEvent.setup();
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));

    expect(screen.getByText("Bearer archestra_abc***")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "service account" }),
    ).not.toBeInTheDocument();
  });

  it("copies nothing when the token value cannot be fetched", async () => {
    fetchUserTokenValueMock.mockResolvedValue(null);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_abc***");

    await user.click(row.getByRole("button", { name: "Copy" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with real token" }),
    );

    await waitFor(() => expect(fetchUserTokenValueMock).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
  });
});
