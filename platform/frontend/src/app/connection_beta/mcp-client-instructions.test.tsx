import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { CONNECT_CLIENTS } from "./clients";
import { McpClientInstructions } from "./mcp-client-instructions";

const {
  userTokenMock,
  fetchUserTokenValueMock,
  tokensMock,
  fetchTeamTokenValueMock,
} = vi.hoisted(() => ({
  userTokenMock: vi.fn(),
  fetchUserTokenValueMock: vi.fn(),
  tokensMock: vi.fn(),
  fetchTeamTokenValueMock: vi.fn(),
}));

vi.mock("@/lib/user-token.query", () => ({
  useUserToken: () => userTokenMock(),
  useFetchUserTokenValue: () => ({
    mutateAsync: fetchUserTokenValueMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/teams/team-token.query", () => ({
  useTokens: () => tokensMock(),
  useFetchTeamTokenValue: () => ({
    mutateAsync: fetchTeamTokenValueMock,
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
      gatewayId="gw-1"
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
  tokensMock.mockReturnValue({
    data: {
      tokens: [],
      permissions: { canAccessOrgToken: false, canAccessTeamTokens: false },
    },
  });
  fetchUserTokenValueMock.mockResolvedValue({
    value: "archestra_personal_real",
  });
  fetchTeamTokenValueMock.mockResolvedValue({ value: "archestra_org_real" });
});

describe("static-token copy", () => {
  it("copies the real personal token, not the masked preview", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_abc***");

    await user.click(row.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Bearer archestra_personal_real"),
    );
    // Copying must not reveal the token on screen.
    expect(screen.getByText("Bearer archestra_abc***")).toBeInTheDocument();
  });

  it("copies the real team/org token when no personal token exists", async () => {
    userTokenMock.mockReturnValue({ data: undefined });
    tokensMock.mockReturnValue({
      data: {
        tokens: [
          {
            id: "tok-org",
            organizationId: "org-1",
            teamId: null,
            isOrganizationToken: true,
            name: "Org token",
            tokenStart: "archestra_org",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            team: null,
          },
        ],
        permissions: { canAccessOrgToken: true, canAccessTeamTokens: false },
      },
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_org***");

    await user.click(row.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() =>
      expect(fetchTeamTokenValueMock).toHaveBeenCalledWith("tok-org"),
    );
    expect(writeText).toHaveBeenCalledWith("Bearer archestra_org_real");
  });

  it("copies nothing when the token value cannot be fetched", async () => {
    fetchUserTokenValueMock.mockResolvedValue(null);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Static token" }));
    const row = getTokenRow("Bearer archestra_abc***");

    await user.click(row.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() => expect(fetchUserTokenValueMock).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
  });
});
