import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
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
  rotateLinkMock,
  marketplaceMock,
  getSkillsMock,
  fetchUserTokenMock,
} = vi.hoisted(() => ({
  listLinksMock: vi.fn(),
  createLinkMock: vi.fn(),
  revokeLinkMock: vi.fn(),
  rotateLinkMock: vi.fn(),
  marketplaceMock: vi.fn(),
  getSkillsMock: vi.fn(),
  fetchUserTokenMock: vi.fn(),
}));

vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("@archestra/shared");
  return {
    ...actual,
    archestraApiSdk: {
      getSkills: getSkillsMock,
    },
  };
});

vi.mock("@/lib/skills/skill-share.query", () => ({
  useSkillMarketplace: () => marketplaceMock(),
  useListSkillShareLinks: () => listLinksMock(),
  useCreateSkillShareLink: () => ({
    mutateAsync: createLinkMock,
    isPending: false,
  }),
  useRevokeSkillShareLink: () => ({
    mutateAsync: revokeLinkMock,
    isPending: false,
  }),
  useRotateSkillShareLink: () => ({
    mutateAsync: rotateLinkMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/user-token.query", () => ({
  useFetchUserTokenValue: () => ({
    mutateAsync: fetchUserTokenMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/hooks/use-app-name");

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

const anyClient = findClient("generic");
const claudeClient = findClient("claude-code");
const copilotClient = findClient("copilot-cli");

const MARKETPLACE = {
  cloneUrl: "https://archestra.example/skills/marketplace.git",
  marketplaceName: "org-12345678-skills",
  requiresAuthentication: true,
};

const ACTIVE_LINK = {
  id: "link-1",
  organizationId: "org-1",
  createdByUserId: "user-1",
  tokenStart: "archestra_skl_xxxx",
  name: null,
  marketplaceName: "org-12345678-skills",
  expiresAt: new Date("2026-06-26T12:00:00Z").toISOString(),
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

/** Grants `skill:read` but not `skill:admin` — the member's view. */
function permissionsForMember() {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !permissions.skill?.includes("admin"),
      }) as ReturnType<typeof useHasPermissions>,
  );
}

/** Open the admin-only share-link disclosure. */
async function openShareLinkSection() {
  await userEvent.click(
    await screen.findByTestId("skills-marketplace-share-link-toggle"),
  );
}

describe("SkillsMarketplaceStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockReturnValue(true);
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    marketplaceMock.mockReturnValue({
      data: MARKETPLACE,
      isPending: false,
    });
    listLinksMock.mockReturnValue({
      data: { links: [] },
      isPending: false,
    });
    getSkillsMock.mockResolvedValue({
      data: {
        data: [{ id: "skill-1" }, { id: "skill-2" }],
        pagination: { total: 2 },
      },
      error: null,
    });
  });

  it("returns null for users who cannot read skills", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    const { container } = render(<SkillsMarketplaceStep client={anyClient} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the picked client doesn't support skill marketplaces", () => {
    const unsupportedClient = findClient("n8n");
    const { container } = render(
      <SkillsMarketplaceStep client={unsupportedClient} />,
    );
    expect(container.textContent).toBe("");
  });

  describe("static marketplace", () => {
    it("leads a member with the install commands, not a credential ritual", async () => {
      permissionsForMember();
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      expect(panel).toHaveTextContent(
        `claude plugin marketplace add ${MARKETPLACE.cloneUrl}`,
      );
      expect(panel).toHaveTextContent(
        `claude plugin install ${MARKETPLACE.marketplaceName}@${MARKETPLACE.marketplaceName}`,
      );
      expect(panel).not.toHaveTextContent("archestra_skl_");

      // git prompts for the password on the first fetch, so the credential
      // heredoc is a footnote for clients that cannot prompt — collapsed, and
      // never the first thing a member is asked to do.
      expect(panel).not.toHaveTextContent("git credential approve");
      expect(
        screen.getByTestId("skills-marketplace-credential-toggle"),
      ).toBeInTheDocument();

      // members do not get the admin-only share-link section
      expect(
        screen.queryByTestId("skills-marketplace-share-link-toggle"),
      ).not.toBeInTheDocument();
    });

    it("reveals the credential command once the disclosure is opened", async () => {
      permissionsForMember();
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      await userEvent.click(
        screen.getByTestId("skills-marketplace-credential-toggle"),
      );
      expect(panel).toHaveTextContent("git credential approve");
      // the host comes from the clone URL, and the token is a placeholder
      expect(panel).toHaveTextContent("host=archestra.example");
    });

    it("copies the credential command with the caller's real token", async () => {
      permissionsForMember();
      fetchUserTokenMock.mockResolvedValue({ value: "arch_realtoken" });
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      await userEvent.click(
        screen.getByTestId("skills-marketplace-credential-toggle"),
      );
      // exactly one block in the panel carries a secret: the credential command
      await userEvent.click(
        within(panel).getByRole("button", { name: /^Copy$/ }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: /real token/i }),
      );

      await waitFor(() => expect(fetchUserTokenMock).toHaveBeenCalled());
    });

    it("drops the credential disclosure when the deployment allows anonymous clones", async () => {
      permissionsForMember();
      marketplaceMock.mockReturnValue({
        data: { ...MARKETPLACE, requiresAuthentication: false },
        isPending: false,
      });
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      expect(panel).toHaveTextContent("no sign-in is needed");
      expect(panel).not.toHaveTextContent("git credential approve");
      expect(
        screen.queryByTestId("skills-marketplace-credential-toggle"),
      ).not.toBeInTheDocument();
    });

    it("falls back to a generic clone command for 'Any client'", async () => {
      permissionsForMember();
      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      expect(panel).toHaveTextContent(
        `git clone ${MARKETPLACE.cloneUrl} ~/.archestra/skills/${MARKETPLACE.marketplaceName}`,
      );
      expect(panel).not.toHaveTextContent("claude plugin");
    });

    it("renders Copilot CLI install commands against the static URL", async () => {
      permissionsForMember();
      renderWithClient(<SkillsMarketplaceStep client={copilotClient} />);

      const panel = await screen.findByTestId("skills-marketplace-static");
      expect(panel).toHaveTextContent(
        `copilot plugin marketplace add ${MARKETPLACE.cloneUrl}`,
      );
      expect(panel).toHaveTextContent(
        `copilot plugin marketplace browse ${MARKETPLACE.marketplaceName}`,
      );
    });

    it("says so when the marketplace URL cannot be loaded", async () => {
      permissionsForMember();
      marketplaceMock.mockReturnValue({ data: undefined, isPending: false });
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      expect(
        await screen.findByText(/marketplace URL could not be loaded/i),
      ).toBeInTheDocument();
    });

    it("shows the empty state when the caller can see no skills", async () => {
      permissionsForMember();
      getSkillsMock.mockResolvedValue({
        data: { data: [], pagination: { total: 0 } },
        error: null,
      });
      renderWithClient(<SkillsMarketplaceStep client={claudeClient} />);

      expect(
        await screen.findByText(/No skills available to you yet/i),
      ).toBeInTheDocument();
    });
  });

  describe("share links (admins)", () => {
    it("renders the create panel behind the disclosure", async () => {
      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);
      await openShareLinkSection();

      await waitFor(() =>
        expect(screen.getByTestId("skills-marketplace-create")).toBeVisible(),
      );
      expect(
        screen.getByText(
          (_, el) =>
            el?.tagName === "P" &&
            /Snapshot 2 skills/i.test(el.textContent ?? ""),
        ),
      ).toBeInTheDocument();
    });

    it("creates a link with the full org skill set and shows snippets", async () => {
      createLinkMock.mockResolvedValue(CREATE_RESPONSE);

      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);
      await openShareLinkSection();
      await userEvent.click(
        await screen.findByTestId("skills-marketplace-create"),
      );

      await waitFor(() => expect(createLinkMock).toHaveBeenCalledTimes(1));
      const body = createLinkMock.mock.calls[0][0];
      expect(body.skillIds).toEqual(["skill-1", "skill-2"]);
      // default TTL is 30 days → expiresAt is a future ISO timestamp
      expect(body.expiresAt).toMatch(/^\d{4}-/);

      const snippets = await screen.findByTestId(
        "skills-marketplace-snippets-generic",
      );
      expect(snippets).toHaveTextContent(
        `git clone ${CREATE_RESPONSE.cloneUrl} ~/.archestra/skills/${CREATE_RESPONSE.marketplaceName}`,
      );
    });

    it("does not auto-rotate an existing active link on unfold (rotation kills already-distributed URLs)", async () => {
      listLinksMock.mockReturnValue({
        data: { links: [ACTIVE_LINK] },
        isPending: false,
      });
      rotateLinkMock.mockResolvedValue(CREATE_RESPONSE);

      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);
      await openShareLinkSection();

      expect(
        await screen.findByRole("button", { name: /Refresh to reveal URL/i }),
      ).toBeInTheDocument();
      expect(rotateLinkMock).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("skills-marketplace-snippets-generic"),
      ).not.toBeInTheDocument();
    });

    it("forwards the link's existing expiresAt when the admin clicks Refresh", async () => {
      listLinksMock.mockReturnValue({
        data: { links: [ACTIVE_LINK] },
        isPending: false,
      });
      rotateLinkMock.mockResolvedValue(CREATE_RESPONSE);

      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);
      await openShareLinkSection();
      await userEvent.click(
        await screen.findByRole("button", { name: /Refresh to reveal URL/i }),
      );

      await waitFor(() => expect(rotateLinkMock).toHaveBeenCalledTimes(1));
      const vars = rotateLinkMock.mock.calls[0][0];
      expect(vars.previousLinkId).toBe(ACTIVE_LINK.id);
      expect(vars.body.skillIds).toEqual(["skill-1", "skill-2"]);
      // expiresAt is preserved so refresh doesn't silently convert a TTL link
      // into a never-expiring one
      expect(vars.body.expiresAt).toBe(ACTIVE_LINK.expiresAt);

      await waitFor(() =>
        expect(
          screen.getByTestId("skills-marketplace-snippets-generic"),
        ).toBeInTheDocument(),
      );
    });

    it("revokes the link after confirmation", async () => {
      listLinksMock.mockReturnValue({
        data: { links: [ACTIVE_LINK] },
        isPending: false,
      });
      revokeLinkMock.mockResolvedValue({ success: true });

      renderWithClient(<SkillsMarketplaceStep client={anyClient} />);
      await openShareLinkSection();
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
});
