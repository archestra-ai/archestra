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
import { useHasPermissions } from "@/lib/auth/auth.query";
import AppaReviewPage from "./page.client";

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

type Approval = archestraApiTypes.ListAppaApprovalsResponses["200"][number];
type Quarantine = archestraApiTypes.ListAppaQuarantinesResponses["200"][number];

let approvals: Approval[];
let quarantines: Quarantine[];
let approvalListRequests: number;
let quarantineListRequests: number;
let decisionRequests: Array<{ id: string; body: unknown }>;
let acknowledgmentRequests: Array<{ id: string; body: unknown }>;
let deferApprovalList: boolean;
let releaseApprovalList: (() => void) | null;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  approvals = [];
  quarantines = [];
  approvalListRequests = 0;
  quarantineListRequests = 0;
  decisionRequests = [];
  acknowledgmentRequests = [];
  deferApprovalList = false;
  releaseApprovalList = null;
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  server.use(
    http.get(`${API_ORIGIN}/api/appa-approvals`, async () => {
      approvalListRequests += 1;
      if (deferApprovalList) {
        await new Promise<void>((resolve) => {
          releaseApprovalList = resolve;
        });
      }
      return HttpResponse.json(approvals);
    }),
    http.post(
      `${API_ORIGIN}/api/appa-approvals/:id/decision`,
      async ({ params, request }) => {
        const body = await request.json();
        const id = String(params.id);
        decisionRequests.push({ id, body });
        approvals = approvals.map((approval) =>
          approval.id === id
            ? {
                ...approval,
                status:
                  (body as { decision: "approve" | "deny" }).decision ===
                  "approve"
                    ? "approved"
                    : "denied",
              }
            : approval,
        );
        const approval = approvals.find((entry) => entry.id === id);
        return HttpResponse.json(approval);
      },
    ),
    http.get(`${API_ORIGIN}/api/appa-quarantines`, () => {
      quarantineListRequests += 1;
      return HttpResponse.json(quarantines);
    }),
    http.get(`${API_ORIGIN}/api/appa-quarantines/:id`, ({ params }) => {
      const quarantine = quarantines.find(
        (entry) => entry.id === String(params.id),
      );
      return quarantine
        ? HttpResponse.json({
            ...quarantine,
            actions: [
              {
                callRef: "00000000-0000-4000-8000-000000000001",
                tool: "billing__charge",
                state: "result_admitted",
                outcome: "success",
                createdAt: "2026-09-09T11:00:00.000Z",
                updatedAt: "2026-09-09T11:01:00.000Z",
              },
            ],
          })
        : HttpResponse.json(
            { error: { message: "Quarantine not found" } },
            { status: 404 },
          );
    }),
    http.post(
      `${API_ORIGIN}/api/appa-quarantines/:id/acknowledgment`,
      async ({ params, request }) => {
        acknowledgmentRequests.push({
          id: String(params.id),
          body: await request.json(),
        });
        const quarantine = quarantines.find(
          (entry) => entry.id === String(params.id),
        );
        return HttpResponse.json({
          quarantine,
          acknowledgment: "acknowledged",
          acknowledgedAt: new Date().toISOString(),
        });
      },
    ),
  );
});

afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppaReviewPage />
    </QueryClientProvider>,
  );
}

function makeApproval(params: {
  id: string;
  syntheticArgument: string;
  expiresAt?: string;
}): Approval {
  return {
    id: params.id,
    candidateCallId: `candidate-${params.id}`,
    tool: "deploy__release",
    args: { target: params.syntheticArgument },
    argumentsSha256: "synthetic-digest",
    status: "pending",
    expiresAt: params.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    approverId: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function makeQuarantine(): Quarantine {
  return {
    id: "quarantine-safe-id-01",
    profileId: "profile-safe-id-01",
    createdAt: "2026-09-09T11:00:00.000Z",
    updatedAt: "2026-09-09T11:01:00.000Z",
  };
}

describe("OpenAPPA review page", () => {
  it("discovers new approval requests while the operator page stays open", async () => {
    renderPage();
    await screen.findByText(
      "No approval requests are available for profiles you can review.",
    );
    approvals = [
      makeApproval({
        id: "new-approval",
        syntheticArgument: "synthetic-arrived-after-page-load",
      }),
    ];
    const card = await screen.findByTestId(
      "approval-new-approval",
      {},
      { timeout: 4_000 },
    );
    expect(card).toHaveTextContent("synthetic-arrived-after-page-load");
    expect(
      within(card).getByRole("button", { name: "Approve action" }),
    ).toBeEnabled();
  });

  it("renders a pending exact action after loading, approves it, and refreshes its state", async () => {
    approvals = [
      makeApproval({
        id: "approval-approve",
        syntheticArgument: "approval-approve-synthetic",
      }),
    ];
    deferApprovalList = true;
    const user = userEvent.setup();

    renderPage();

    expect(
      await screen.findByText("Loading review records..."),
    ).toBeInTheDocument();
    await waitFor(() => expect(releaseApprovalList).not.toBeNull());
    releaseApprovalList?.();
    deferApprovalList = false;

    const approvalCard = await screen.findByTestId("approval-approval-approve");
    expect(
      within(approvalCard).getByRole("region", {
        name: "Code sample, json",
      }),
    ).toHaveTextContent("approval-approve-synthetic");
    await user.click(
      within(approvalCard).getByRole("button", { name: "Approve action" }),
    );

    await waitFor(() =>
      expect(decisionRequests).toEqual([
        { id: "approval-approve", body: { decision: "approve" } },
      ]),
    );
    await waitFor(() =>
      expect(
        within(approvalCard).queryByRole("button", { name: "Approve action" }),
      ).not.toBeInTheDocument(),
    );
    expect(within(approvalCard).getByText("approved")).toBeInTheDocument();
    expect(approvalListRequests).toBeGreaterThanOrEqual(2);
  });

  it("sends the deny decision for the exact pending action and refreshes it", async () => {
    approvals = [
      makeApproval({
        id: "approval-deny",
        syntheticArgument: "approval-deny-synthetic",
      }),
    ];
    const user = userEvent.setup();

    renderPage();

    const approvalCard = await screen.findByTestId("approval-approval-deny");
    expect(
      within(approvalCard).getByRole("region", {
        name: "Code sample, json",
      }),
    ).toHaveTextContent("approval-deny-synthetic");
    await user.click(
      within(approvalCard).getByRole("button", { name: "Deny action" }),
    );

    await waitFor(() =>
      expect(decisionRequests).toEqual([
        { id: "approval-deny", body: { decision: "deny" } },
      ]),
    );
    await waitFor(() =>
      expect(within(approvalCard).getByText("denied")).toBeInTheDocument(),
    );
    expect(approvalListRequests).toBeGreaterThanOrEqual(2);
  });

  it("does not offer an action for a pending record already past its expiry", async () => {
    approvals = [
      makeApproval({
        id: "approval-expiring",
        syntheticArgument: "approval-expiring-synthetic",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ];

    renderPage();

    const approvalCard = await screen.findByTestId(
      "approval-approval-expiring",
    );
    expect(
      within(approvalCard).queryByRole("button", { name: "Approve action" }),
    ).not.toBeInTheDocument();
    expect(within(approvalCard).getByText("expired")).toBeInTheDocument();
  });

  it("selects a safe quarantine row and records acknowledgment without releasing it", async () => {
    const quarantine = makeQuarantine();
    quarantines = [quarantine];
    const user = userEvent.setup();

    renderPage();

    const row = await screen.findByTestId(
      "quarantine-row-quarantine-safe-id-01",
    );
    expect(
      within(row).getByText(/Quarantine ID: quarantine-safe-id-01/),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(/Profile ID: profile-safe-id-01/),
    ).toBeInTheDocument();
    const inspect = within(row).getByRole("button", {
      name: "Inspect quarantine quarantine-safe-id-01",
    });
    await user.click(inspect);

    expect(inspect).toHaveAttribute("aria-pressed", "true");
    const detail = await screen.findByTestId(
      "quarantine-detail-quarantine-safe-id-01",
    );
    expect(within(detail).getByText("Quarantined")).toBeInTheDocument();
    expect(
      within(detail).getByText("quarantine-safe-id-01"),
    ).toBeInTheDocument();
    expect(within(detail).getByText("profile-safe-id-01")).toBeInTheDocument();
    const action = within(detail).getByTestId(
      "quarantine-action-00000000-0000-4000-8000-000000000001",
    );
    expect(within(action).getByText("billing__charge")).toBeInTheDocument();
    expect(within(action).getByText("result_admitted")).toBeInTheDocument();
    expect(within(action).getByText("success")).toBeInTheDocument();

    await user.click(
      within(detail).getByRole("button", { name: "Record acknowledgment" }),
    );

    await waitFor(() =>
      expect(acknowledgmentRequests).toEqual([
        {
          id: "quarantine-safe-id-01",
          body: { acknowledgment: "acknowledged" },
        },
      ]),
    );
    await waitFor(() =>
      expect(quarantineListRequests).toBeGreaterThanOrEqual(2),
    );
    expect(within(detail).getByText("Quarantined")).toBeInTheDocument();
    expect(
      within(detail).getByRole("button", { name: "Record acknowledgment" }),
    ).toBeInTheDocument();
  });
});
