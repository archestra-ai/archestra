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
import { UserLimitsOverview } from "./user-limits-overview";

vi.mock("@/lib/auth/auth.query");
// SearchInput reads the router; the canonical mock's hooks are vi.fn()s.
vi.mock("next/navigation");

type UsageResponse = archestraApiTypes.ListUserLimitUsageResponses["200"];
type UsageRow = UsageResponse["data"][number];

describe("UserLimitsOverview", () => {
  let defaults: unknown[];
  let rows: UsageRow[];
  let resetUserIds: string[];

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
    archestraApiClient.setConfig({ baseUrl: API });
  });

  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    defaults = [orgDefault];
    rows = [
      row({ userId: "u-1", name: "Blocked Bea", spent: 52, status: "at" }),
      row({ userId: "u-2", name: "Close Cal", spent: 40, status: "near" }),
      row({
        userId: "u-3",
        name: "Custom Cy",
        spent: 10,
        status: "ok",
        source: "custom",
        limitValue: 200,
        customLimitId: "limit-1",
        customReason: "Runs the nightly eval suite",
      }),
    ];
    resetUserIds = [];
    server.use(
      http.get(`${API}/api/default-user-limits`, () =>
        HttpResponse.json(defaults),
      ),
      http.get(`${API}/api/llm-models/options`, () => HttpResponse.json([])),
      http.get(`${API}/api/environments`, () =>
        HttpResponse.json({ environments: [], resourceDefaults: {} }),
      ),
      http.get(`${API}/api/default-user-limits/users`, ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        return HttpResponse.json(usageResponse(rows, status));
      }),
      http.post(
        `${API}/api/default-user-limits/users/:userId/reset`,
        ({ params }) => {
          resetUserIds.push(String(params.userId));
          return HttpResponse.json({
            userId: params.userId,
            resetAt: new Date().toISOString(),
          });
        },
      ),
    );
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
    archestraApiClient.setConfig({ baseUrl: "" });
  });

  it("shows the default limit and who is at or near it", async () => {
    renderOverview();

    expect(await screen.findByText("Applies to 2 users")).toBeVisible();
    expect(screen.getByText("$50")).toBeVisible();
    expect(screen.getByText("per calendar month")).toBeVisible();
    expect(screen.getByRole("button", { name: /1\s*at limit/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /1\s*near/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "1 custom" })).toBeVisible();
  });

  it("resets a blocked user's usage from the at-limit list", async () => {
    const user = userEvent.setup();
    renderOverview();

    await user.click(
      await screen.findByRole("button", { name: /1\s*at limit/ }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Users and their limits",
    });
    await within(drawer).findByText("Blocked Bea");
    expect(within(drawer).queryByText("Close Cal")).not.toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "Reset" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Reset usage for Blocked Bea?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Reset usage" }),
    );

    await waitFor(() => expect(resetUserIds).toEqual(["u-1"]));
  });

  it("shows why a user has a custom limit", async () => {
    const user = userEvent.setup();
    renderOverview();

    await user.click(await screen.findByRole("button", { name: "1 custom" }));
    const drawer = await screen.findByRole("dialog", {
      name: "Users and their limits",
    });

    expect(
      await within(drawer).findByText("Runs the nightly eval suite"),
    ).toBeVisible();
  });

  it("offers to set a default when there is none", async () => {
    defaults = [];
    rows = rows.map((r) =>
      r.source === "custom"
        ? r
        : {
            ...r,
            source: "none",
            limitValue: null,
            percent: null,
            status: "ok",
          },
    );
    renderOverview();

    expect(await screen.findByText("No limit")).toBeVisible();
    expect(screen.getByRole("button", { name: "Set default" })).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: "2 users can spend without a cap",
      }),
    ).toBeVisible();
  });
});

// ===
// Helpers

const API = "http://localhost:9000";

const server = setupServer();

const orgDefault = {
  id: "dul-1",
  organizationId: "org-1",
  environmentId: null,
  limitValue: 50,
  model: null,
  cleanupInterval: "calendar_month",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function renderOverview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UserLimitsOverview limitsTable={<div>Explicit limits table</div>} />
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<UsageRow> & Pick<UsageRow, "userId" | "name">) {
  const limitValue =
    overrides.limitValue === undefined ? 50 : overrides.limitValue;
  const spent = overrides.spent ?? 0;
  return {
    email: `${overrides.userId}@example.com`,
    image: null,
    source: "organization_default",
    environmentId: null,
    environmentName: null,
    limitValue,
    cleanupInterval: "calendar_month",
    models: null,
    spent,
    percent: limitValue ? (spent / limitValue) * 100 : null,
    status: "ok",
    customLimitId: null,
    customReason: null,
    resetsAt: "2026-11-01T00:00:00.000Z",
    projectedSpend: null,
    fallbackSpent: null,
    lastResetAt: null,
    lastResetByName: null,
    ...overrides,
  } satisfies UsageRow;
}

function usageResponse(all: UsageRow[], status: string | null): UsageResponse {
  const matches = all.filter((r) => {
    if (status === "at" || status === "near") return r.status === status;
    if (status === "custom" || status === "none") return r.source === status;
    return true;
  });
  return {
    data: matches,
    pagination: {
      currentPage: 1,
      limit: 50,
      total: matches.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
    summary: {
      total: all.length,
      at: all.filter((r) => r.status === "at").length,
      near: all.filter((r) => r.status === "near").length,
      custom: all.filter((r) => r.source === "custom").length,
      none: all.filter((r) => r.source === "none").length,
      organizationDefault: all.filter(
        (r) => r.source === "organization_default",
      ).length,
      environmentDefault: 0,
      flaggedCustom: 0,
      spent: all.reduce((sum, r) => sum + r.spent, 0),
      resetsAt: "2026-11-01T00:00:00.000Z",
      environments: [],
    },
  };
}
