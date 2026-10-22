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
  expect,
  it,
  vi,
} from "vitest";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import { ConsultPayloads } from "./consult-detail-sheet";
import { toConsultView } from "./consult-details";
import { ConsultsTable } from "./consults-table";

vi.mock("next/navigation");
vi.mock("sonner");

const origin = "http://localhost:9000";
const consultsUrl = `${origin}/api/openappa/external-consults`;
const server = setupServer();
const requests: URL[] = [];
const push = vi.fn();
// jsdom has no Blob URLs; the export needs one to hand the file to the browser.
const jsdomCreateObjectURL = URL.createObjectURL;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  requests.length = 0;
  URL.createObjectURL = () => "blob:consults";
  URL.revokeObjectURL = () => {};
  push.mockReset();
  vi.mocked(useRouter).mockReturnValue({
    push,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/consults/logs");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "outcome=answered&search=ses-1",
    ) as unknown as ReturnType<typeof useSearchParams>,
  );
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(consultsUrl, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      if (url.searchParams.get("format") === "jsonl") {
        return new HttpResponse(`${JSON.stringify(CONSULT)}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }
      return HttpResponse.json({
        data: [CONSULT],
        pagination: { limit: 20, nextCursor: null, hasNext: false },
      });
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  URL.createObjectURL = jsdomCreateObjectURL;
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("lists consults for the URL filters with the tool name", async () => {
  renderTable();

  expect(await screen.findByText("fetch")).toBeInTheDocument();
  expect(screen.getByText("jev.tool-call")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "jev.tool-call: Answered" }),
  ).toBeInTheDocument();
  expect(screen.getByText("812ms")).toBeInTheDocument();
  expect(requests[0].searchParams.get("outcome")).toBe("answered");
  expect(requests[0].searchParams.get("search")).toBe("ses-1");
  expect(requests[0].searchParams.has("sessionId")).toBe(false);
});

it("shows every consult's outcome in the Status column", async () => {
  server.use(
    http.get(consultsUrl, () =>
      HttpResponse.json({
        data: [
          CONSULT,
          {
            ...CONSULT,
            id: "01999999-0000-7000-8000-000000000002",
            externalName: "egress-policy",
            outcome: "timeout",
            answer: null,
            httpStatus: null,
          },
        ],
        pagination: { limit: 20, nextCursor: null, hasNext: false },
      }),
    ),
  );
  renderTable();

  expect(await screen.findByText("Timed out")).toBeInTheDocument();
  const table = screen.getByRole("table");
  expect(within(table).getByText("Answered")).toBeInTheDocument();
});

it("exports JSONL with the current filters", async () => {
  renderTable();
  await screen.findByText("fetch");

  fireEvent.click(screen.getByRole("button", { name: /export jsonl/i }));

  await waitFor(() =>
    expect(
      requests.find((url) => url.searchParams.get("format") === "jsonl"),
    ).toBeDefined(),
  );
  const exportRequest = requests.find(
    (url) => url.searchParams.get("format") === "jsonl",
  );
  expect(exportRequest?.searchParams.get("outcome")).toBe("answered");
  expect(exportRequest?.searchParams.get("search")).toBe("ses-1");
  expect(exportRequest?.searchParams.has("cursor")).toBe(false);
});

it("opens a consult on its own page, which leads on to its session", async () => {
  server.use(
    http.get(consultsUrl, () =>
      HttpResponse.json({
        data: [CONSULT],
        pagination: { limit: 20, nextCursor: null, hasNext: false },
      }),
    ),
  );
  renderTable();

  fireEvent.click(await screen.findByText(CONSULT.externalName));

  expect(push).toHaveBeenCalledWith(`/consults/logs/${CONSULT.id}`);
});

it("shows a metadata-only consult without its withheld content", () => {
  const notStored = { __redacted: "log_content_policy" };
  render(
    <ConsultPayloads
      view={toConsultView({
        ...CONSULT,
        request: {
          ...notStored,
          kind: "annotation",
          artifact: { args: { name: "fetch", arguments: notStored } },
        },
        answer: null,
        diagnostics: null,
      } as ExternalConsult)}
    />,
  );

  expect(screen.getByText("Content not stored")).toBeInTheDocument();
  expect(screen.getByText("Tool: fetch")).toBeInTheDocument();
  expect(screen.queryByText(/log_content_policy/)).not.toBeInTheDocument();
  expect(screen.queryByText("No answer.")).not.toBeInTheDocument();
});

function renderTable() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConsultsTable />
    </QueryClientProvider>,
  );
}

const CONSULT = {
  id: "01999999-0000-7000-8000-000000000001",
  organizationId: "org",
  sessionId: "ses-1",
  callerId: "user:u1",
  createdAt: "2026-09-25T10:00:00.000Z",
  startedAt: "2026-09-25T10:00:00.000Z",
  durationMs: 812,
  role: "annotator",
  externalName: "jev.tool-call",
  backend: "jev",
  request: {
    kind: "annotation",
    artifact: {
      args: { name: "fetch", arguments: { url: "https://a.example" } },
    },
  },
  outcome: "answered",
  answer: { audience: "public" },
  rawResponse: null,
  httpStatus: 200,
  diagnostics: btoa(
    JSON.stringify({
      jev_diagnostics: {
        version: 1,
        model: "jev-1",
        attempts: ["ok"],
        labels: {
          delta_audience: {
            probabilities: { self: 0.05, internal: 0.4, public: 0.55 },
            decision: "public",
          },
        },
        elapsed_ms: 812,
      },
    }),
  ),
  diagnosticsTruncated: false,
  root: "root",
  trajectory: "t",
  callId: null,
  offerId: null,
  callDigest: null,
};
