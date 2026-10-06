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
import { useFeature } from "@/lib/config/config.query";
import { PublicLinksSection } from "./public-links-section";

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

const API_ORIGIN = "http://localhost:9000";
const LINKS_URL = `${API_ORIGIN}/api/public-file-links`;

type Link =
  archestraApiTypes.GetPublicFileLinksResponses["200"]["data"][number];

const link: Link = {
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
};

const page = (data: Link[]) => ({
  data,
  pagination: {
    currentPage: 1,
    limit: 10,
    total: data.length,
    totalPages: data.length ? 1 : 0,
    hasNext: false,
    hasPrev: false,
  },
});

const server = setupServer();

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
  vi.mocked(useFeature).mockReturnValue(true as never);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PublicLinksSection />
    </QueryClientProvider>,
  );
}

describe("PublicLinksSection", () => {
  it("lists only your own links and lets you revoke one", async () => {
    const scopes = new Set<string | null>();
    let revoked = false;
    server.use(
      http.get(LINKS_URL, ({ request }) => {
        scopes.add(new URL(request.url).searchParams.get("scope"));
        return HttpResponse.json(
          page([
            {
              ...link,
              revokedAt: revoked ? "2026-10-02T00:00:00.000Z" : null,
            },
          ]),
        );
      }),
      http.delete(`${LINKS_URL}/:id`, () => {
        revoked = true;
        return HttpResponse.json({ success: true });
      }),
    );
    renderSection();

    const row = (await screen.findByText("launch-banner.png")).closest("li");
    if (!row) throw new Error("row missing");
    expect([...scopes]).toEqual(["mine"]);
    // Your own name would only repeat who you are.
    expect(row).toHaveTextContent("via Social Agent");
    expect(row).not.toHaveTextContent("Dana");

    await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.getByText("Revoked")).toBeInTheDocument(),
    );
  });

  it("stays hidden until you have shared something", async () => {
    let requested = false;
    server.use(
      http.get(LINKS_URL, () => {
        requested = true;
        return HttpResponse.json(page([]));
      }),
    );
    renderSection();

    await waitFor(() => expect(requested).toBe(true));
    expect(screen.queryByText("Public links")).not.toBeInTheDocument();
  });
});
