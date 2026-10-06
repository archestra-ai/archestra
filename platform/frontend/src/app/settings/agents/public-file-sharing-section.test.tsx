import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { PublicFileSharingSection } from "./public-file-sharing-section";

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");

const API_ORIGIN = "http://localhost:9000";
const LINKS_URL = `${API_ORIGIN}/api/public-file-links`;

type Link =
  archestraApiTypes.GetPublicFileLinksResponses["200"]["data"][number];

const link = (overrides: Partial<Link>): Link => ({
  id: "link-1",
  organizationId: "org-1",
  token: "t".repeat(32),
  fileId: "file-1",
  createdByUserId: "user-1",
  agentId: "agent-1",
  conversationId: null,
  filename: "launch-banner.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  createdAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null,
  url: `https://files.example.com/public-files/${"t".repeat(32)}/launch-banner.png`,
  createdBy: { id: "user-1", name: "Dana", email: "dana@example.com" },
  agent: { id: "agent-1", name: "Social Agent" },
  ...overrides,
});

const server = setupServer();
const mutateSecurity = vi.fn();

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  vi.mocked(useOrganization).mockReturnValue({
    data: { allowPublicFileSharing: false },
  } as ReturnType<typeof useOrganization>);
  mutateSecurity.mockReset();
  vi.mocked(useUpdateSecuritySettings).mockReturnValue({
    mutate: mutateSecurity,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSecuritySettings>);
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PublicFileSharingSection />
    </QueryClientProvider>,
  );
}

describe("PublicFileSharingSection", () => {
  it("turns the organization switch on", async () => {
    server.use(
      http.get(LINKS_URL, () =>
        HttpResponse.json({
          data: [],
          pagination: {
            currentPage: 1,
            limit: 10,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }),
      ),
    );
    renderSection();

    await userEvent.click(
      screen.getByRole("switch", {
        name: "Allow agents to share files publicly",
      }),
    );

    expect(mutateSecurity).toHaveBeenCalledWith({
      allowPublicFileSharing: true,
    });
    expect(
      await screen.findByText("No files have been shared publicly yet."),
    ).toBeInTheDocument();
  });

  it("lists shared files and revokes a live one", async () => {
    let revokedId: string | null = null;
    const page = () => ({
      data: [
        link({ revokedAt: revokedId ? "2026-10-02T00:00:00.000Z" : null }),
        link({
          id: "link-2",
          filename: "old-teaser.mp4",
          mimeType: "video/mp4",
          revokedAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    });
    server.use(
      http.get(LINKS_URL, () => HttpResponse.json(page())),
      http.delete(`${LINKS_URL}/:id`, ({ params }) => {
        revokedId = String(params.id);
        return HttpResponse.json({ success: true });
      }),
    );
    renderSection();

    const live = (await screen.findByText("launch-banner.png")).closest("li");
    const revoked = screen.getByText("old-teaser.mp4").closest("li");
    if (!live || !revoked) throw new Error("rows missing");
    expect(within(live).getByText(/Dana via Social Agent/)).toBeInTheDocument();
    // An already-revoked link has nothing left to revoke.
    expect(within(revoked).getByText("Revoked")).toBeInTheDocument();
    expect(
      within(revoked).queryByRole("button", { name: "Revoke" }),
    ).not.toBeInTheDocument();

    await userEvent.click(within(live).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokedId).toBe("link-1"));
    await waitFor(() => expect(screen.getAllByText("Revoked")).toHaveLength(2));
  });
});
