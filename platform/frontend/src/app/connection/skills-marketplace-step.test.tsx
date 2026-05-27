import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { SkillsMarketplaceStep } from "./skills-marketplace-step";

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const {
  listLinksMock,
  createLinkMock,
  revokeLinkMock,
  getSkillsMock,
  hasPermissionsMock,
} = vi.hoisted(() => ({
  listLinksMock: vi.fn(),
  createLinkMock: vi.fn(),
  revokeLinkMock: vi.fn(),
  getSkillsMock: vi.fn(),
  hasPermissionsMock: vi.fn(),
}));

vi.mock("@shared", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      getSkills: getSkillsMock,
    },
  };
});

vi.mock("@/lib/skills/skill-share.query", () => ({
  useListSkillShareLinks: () => listLinksMock(),
  useCreateSkillShareLink: () => ({
    mutateAsync: createLinkMock,
    isPending: false,
  }),
  useRevokeSkillShareLink: () => ({
    mutateAsync: revokeLinkMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => hasPermissionsMock(),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => true,
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

const anyClient = findClient("generic");
const claudeClient = findClient("claude-code");

const ACTIVE_LINK = {
  id: "link-1",
  organizationId: "org-1",
  createdByUserId: "user-1",
  tokenStart: "archestra_skl_xxxx",
  name: null,
  marketplaceName: "org-12345678-skills",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date("2026-05-27T12:00:00Z").toISOString(),
  updatedAt: new Date("2026-05-27T12:00:00Z").toISOString(),
  status: "active" as const,
  skills: [
    { id: "skill-1", name: "warehouse-postgres", description: "" },
    { id: "skill-2", name: "billing-pipeline", description: "" },
  ],
};

const CREATE_RESPONSE = {
  link: ACTIVE_LINK,
  rawToken: "archestra_skl_rawtoken",
  cloneUrl:
    "https://archestra.example/skills/m/archestra_skl_rawtoken/repo.git",
  marketplaceName: "org-12345678-skills",
};

describe("SkillsMarketplaceStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPermissionsMock.mockReturnValue({ data: true });
    getSkillsMock.mockResolvedValue({
      data: {
        data: [{ id: "skill-1" }, { id: "skill-2" }],
        pagination: { total: 2 },
      },
      error: null,
    });
  });

  it("returns null for non-admin users", () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    const { container } = render(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the create panel when no active link exists", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    renderWithClient(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("skills-marketplace-create")).toBeVisible(),
    );
    expect(screen.getByText(/Snapshot 2 skills/i)).toBeInTheDocument();
  });

  it("creates a link with the full org skill set and shows snippets", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    createLinkMock.mockResolvedValue(CREATE_RESPONSE);

    renderWithClient(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("skills-marketplace-create")).toBeVisible(),
    );
    await userEvent.click(screen.getByTestId("skills-marketplace-create"));

    await waitFor(() => expect(createLinkMock).toHaveBeenCalledTimes(1));
    const body = createLinkMock.mock.calls[0][0];
    expect(body.skillIds).toEqual(["skill-1", "skill-2"]);
    // default TTL is 30 days → expiresAt is a future ISO timestamp
    expect(body.expiresAt).toMatch(/^\d{4}-/);
  });

  it("shows both Claude Code and Codex snippets when 'Any client' is picked", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    createLinkMock.mockResolvedValue(CREATE_RESPONSE);

    renderWithClient(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );

    await userEvent.click(
      await screen.findByTestId("skills-marketplace-create"),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("skills-marketplace-snippets-claude-code"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("skills-marketplace-snippets-codex"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `claude plugin marketplace add ${CREATE_RESPONSE.cloneUrl}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `codex plugin marketplace add ${CREATE_RESPONSE.cloneUrl}`,
      ),
    ).toBeInTheDocument();
  });

  it("filters snippets to the chosen client", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    createLinkMock.mockResolvedValue(CREATE_RESPONSE);

    renderWithClient(
      <SkillsMarketplaceStep
        client={claudeClient}
        expanded
        onToggle={() => {}}
      />,
    );

    await userEvent.click(
      await screen.findByTestId("skills-marketplace-create"),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("skills-marketplace-snippets-claude-code"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("skills-marketplace-snippets-codex"),
    ).not.toBeInTheDocument();
  });

  it("renders an existing active link with hidden URL until refreshed", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [ACTIVE_LINK] },
      isPending: false,
    });

    renderWithClient(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(/The clone URL is only shown once/i),
      ).toBeVisible(),
    );
    // refresh button is visible but install snippets are not
    expect(screen.getByTestId("skills-marketplace-rotate")).toBeVisible();
    expect(
      screen.queryByTestId("skills-marketplace-snippets-claude-code"),
    ).not.toBeInTheDocument();
  });

  it("revokes the link after confirmation", async () => {
    listLinksMock.mockReturnValue({
      data: { links: [ACTIVE_LINK] },
      isPending: false,
    });
    revokeLinkMock.mockResolvedValue({ success: true });

    renderWithClient(
      <SkillsMarketplaceStep client={anyClient} expanded onToggle={() => {}} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /^Revoke$/i }),
    );
    await userEvent.click(
      screen.getByTestId("skills-marketplace-confirm-revoke"),
    );

    await waitFor(() =>
      expect(revokeLinkMock).toHaveBeenCalledWith(ACTIVE_LINK.id),
    );
  });
});
