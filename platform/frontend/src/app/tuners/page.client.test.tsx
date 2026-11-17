import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { authQueryKeys } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import type {
  TunerSuggestion,
  TunerSuggestionStatus,
  TunerSummary,
} from "@/lib/tuners.query";
import {
  adminPermissionsSeed,
  makeUserPermissions,
  sessionSeed,
} from "@/mocks/data/auth";
import { makeConfig } from "@/mocks/data/config";
import TunersLayout from "./layout";
import TunersPage from "./page.client";

vi.mock("sonner");
vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");

const origin = "http://localhost:9000";
const server = setupServer();

let tuners: TunerSummary[];
let suggestions: TunerSuggestion[];
let requests: { method: string; path: string; body: unknown }[];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/tuners");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  archestraApiClient.setConfig({ baseUrl: origin });
  tuners = [makeTuner("sre"), makeTuner("appa", { available: false })];
  suggestions = [
    makeSuggestion({ id: "s-1", title: "Raise memory for the ingest worker" }),
  ];
  requests = [];
  server.use(
    http.get(`${origin}/api/tuners`, () => HttpResponse.json(tuners)),
    http.put(`${origin}/api/tuners/:kind`, async ({ request, params }) => {
      const body = (await request.json()) as { enabled: boolean };
      requests.push({ method: "PUT", path: `tuners/${params.kind}`, body });
      tuners = tuners.map((tuner) =>
        tuner.kind === params.kind
          ? {
              ...tuner,
              trigger: tuner.trigger && {
                ...tuner.trigger,
                enabled: body.enabled,
              },
            }
          : tuner,
      );
      return HttpResponse.json(tuners);
    }),
    http.get(`${origin}/api/tuner-suggestions`, ({ request }) => {
      const status = new URL(request.url).searchParams.getAll("status");
      requests.push({ method: "GET", path: "tuner-suggestions", body: status });
      const data = suggestions.filter((s) => status.includes(s.status));
      return HttpResponse.json({
        data,
        pagination: {
          currentPage: 1,
          limit: 20,
          total: data.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
    http.post(
      `${origin}/api/tuner-suggestions/:id/:action`,
      async ({ request, params }) => {
        const body = await request.json();
        requests.push({
          method: "POST",
          path: `${params.id}/${params.action}`,
          body,
        });
        const next = ACTION_STATUS[params.action as string];
        suggestions = suggestions.map((s) =>
          s.id === params.id
            ? {
                ...s,
                status: next,
                comment: (body as { comment?: string }).comment ?? null,
              }
            : s,
        );
        return HttpResponse.json(suggestions.find((s) => s.id === params.id));
      },
    ),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("TunersPage", () => {
  it("shows the off notice and calls no tuner API while the flag is off", async () => {
    renderPage({ tunersEnabled: false });

    expect(
      await screen.findByRole("heading", { name: "Tuners" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it("lists open suggestions and opens one with its evidence", async () => {
    renderPage();

    const table = await screen.findByRole("table");
    fireEvent.click(
      await within(table).findByText("Raise memory for the ingest worker"),
    );
    expect(requests[0]).toEqual({
      method: "GET",
      path: "tuner-suggestions",
      body: ["open"],
    });

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("The worker was OOM-killed 4 times."),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Yell" })).toHaveAttribute(
      "href",
      "/openappa/yells/yell-1",
    );
  });

  it("marks a suggestion done with an optional comment and drops it from the open inbox", async () => {
    renderPage();
    await openSuggestion("Raise memory for the ingest worker");

    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Mark suggestion done",
    });
    fireEvent.change(within(dialog).getByLabelText("Comment"), {
      target: { value: "Bumped the limit" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark done" }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "POST",
        path: "s-1/done",
        body: { comment: "Bumped the limit" },
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("table")).queryByText(
          "Raise memory for the ingest worker",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("requires a reason to reject", async () => {
    renderPage();
    await openSuggestion("Raise memory for the ingest worker");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Reject suggestion",
    });
    const submit = within(dialog).getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Expected during the migration" },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "POST",
        path: "s-1/reject",
        body: { comment: "Expected during the migration" },
      }),
    );
  });

  it("closes the suggestion and reloads the inbox when it changed underneath", async () => {
    server.use(
      http.post(`${origin}/api/tuner-suggestions/:id/done`, () => {
        suggestions = [];
        return HttpResponse.json(
          {
            error: {
              message: "The suggestion is no longer open",
              type: "api_conflict_error",
            },
          },
          { status: 409 },
        );
      }),
    );
    renderPage();
    await openSuggestion("Raise memory for the ingest worker");

    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Mark suggestion done",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark done" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("table")).queryByText(
          "Raise memory for the ingest worker",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("enables a tuner from its card", async () => {
    renderPage();

    const toggle = await screen.findByRole("switch", {
      name: "Enable SRE tuner",
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        path: "tuners/sre",
        body: { enabled: true },
      }),
    );
    await waitFor(() => expect(toggle).toBeChecked());
    expect(
      screen.getByRole("switch", { name: "Enable APPA tuner" }),
    ).toBeDisabled();
  });

  it("leaves tuners and suggestions read-only without tuner:update", async () => {
    renderPage({
      permissions: makeUserPermissions({ tuner: ["read"] }),
    });

    expect(
      await screen.findByRole("switch", { name: "Enable SRE tuner" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Run now" }),
    ).not.toBeInTheDocument();

    await openSuggestion("Raise memory for the ingest worker");
    expect(
      screen.queryByRole("button", { name: "Mark done" }),
    ).not.toBeInTheDocument();
  });
});

// === Helpers

const ACTION_STATUS: Record<string, TunerSuggestionStatus> = {
  done: "done",
  reject: "rejected",
};

function renderPage({
  tunersEnabled = true,
  permissions = adminPermissionsSeed,
}: {
  tunersEnabled?: boolean;
  permissions?: typeof adminPermissionsSeed;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), sessionSeed);
  client.setQueryData(authQueryKeys.userPermissions(), permissions);
  client.setQueryData(authQueryKeys.scopedCapabilities(), []);
  client.setQueryData(["config"], makeConfig({ features: { tunersEnabled } }));
  return render(
    <QueryClientProvider client={client}>
      <TunersLayout>
        <TunersPage />
      </TunersLayout>
    </QueryClientProvider>,
  );
}

async function openSuggestion(title: string) {
  const table = await screen.findByRole("table");
  fireEvent.click(await within(table).findByText(title));
  await screen.findByRole("dialog");
}

function makeTuner(
  kind: TunerSummary["kind"],
  overrides: Partial<TunerSummary> = {},
): TunerSummary {
  return {
    kind,
    available: true,
    trigger: {
      id: `trigger-${kind}`,
      enabled: false,
      cronExpression: "0 6 * * *",
      timezone: "UTC",
      actor: null,
      lastExecutedAt: null,
    },
    lastRun: null,
    ...overrides,
  };
}

function makeSuggestion(
  overrides: Partial<TunerSuggestion> = {},
): TunerSuggestion {
  return {
    id: "suggestion",
    organizationId: "org-1",
    tunerKind: "sre",
    fingerprint: "fingerprint",
    source: "sre_oom_killed",
    severity: "warn",
    title: "Suggestion",
    rationale: "The worker was OOM-killed 4 times.",
    evidence: [
      { type: "k8s_pod", namespace: "jobs", name: "ingest-worker-0" },
      { type: "openappa_yell", id: "yell-1" },
    ],
    action: { type: "note" },
    status: "open",
    statusChangedAt: "2026-11-01T00:00:00.000Z",
    statusChangedBy: null,
    comment: null,
    scheduleTriggerRunId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}
