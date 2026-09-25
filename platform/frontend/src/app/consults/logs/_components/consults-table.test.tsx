import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ConsultsTable } from "./consults-table";

vi.mock("next/navigation");
vi.mock("sonner");

const origin = "http://localhost:9000";
const consultsUrl = `${origin}/api/openappa/external-consults`;
const server = setupServer();
const requests: URL[] = [];
// jsdom has no Blob URLs; the export needs one to hand the file to the browser.
const jsdomCreateObjectURL = URL.createObjectURL;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  requests.length = 0;
  URL.createObjectURL = () => "blob:consults";
  URL.revokeObjectURL = () => {};
  vi.mocked(usePathname).mockReturnValue("/consults/logs");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "outcome=answered&sessionId=ses-1",
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
  expect(requests[0].searchParams.get("outcome")).toBe("answered");
  expect(requests[0].searchParams.get("sessionId")).toBe("ses-1");
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
  expect(exportRequest?.searchParams.get("sessionId")).toBe("ses-1");
  expect(exportRequest?.searchParams.has("cursor")).toBe(false);
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
