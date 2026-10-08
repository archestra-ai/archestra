import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { ListReturnUrlTracker } from "@/lib/hooks/use-list-return-url";
import { formatDate } from "@/lib/utils/date-time";
import { OpenAppaPageActionSlotContext } from "../_parts/openappa-page-action";
import { ValidationProvider } from "./_parts/validation-context";
import FilePage from "./file/page";
import HistoryPage from "./history/page";
import NewPage from "./new/page";
import ValidationPage from "./page";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
vi.mock("next/navigation");
vi.mock("next/link", () => ({
  default: function MockLink({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) {
    const router = useRouter();
    return (
      <a
        href={href}
        {...props}
        onClick={(event) => {
          if (!event.defaultPrevented) {
            event.preventDefault();
            router.push(href);
          }
        }}
      >
        {children}
      </a>
    );
  },
}));
vi.mock("@/components/editor", () => ({
  Editor: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: { readOnly: boolean; ariaLabel: string };
  }) => (
    <textarea
      aria-label={options.ariaLabel}
      readOnly={options.readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
const origin = "http://localhost:9000";
const endpoint = `${origin}/api/openappa/policy-tests`;
const server = setupServer();
const scenario = {
  path: "scenario.appa",
  content: "mcp/files/read {}\nexpect allow\n",
};
const collection = {
  source: "local",
  files: [scenario],
  version: "tests-v1",
  sourceCommit: null,
  directory: "traces",
  activeDirectory: "traces",
  error: null,
};
const run = {
  id: "run-1",
  createdAt: "2026-10-06T10:00:00.000Z",
  createdBy: null,
  source: "local",
  sourceVersion: collection.version,
  sourceCommit: null,
  definitionHash: "definitions-v1",
  policyRevision: 2,
  policyHash: "policy-v2",
  effectivePolicyHash: "effective-v2",
  engineVersion: "engine-v1",
  draft: false,
  stale: false,
  files: [
    {
      path: scenario.path,
      assertionCount: 1,
      status: "passed",
      contentHash: "content-v1",
      steps: [
        {
          line: 1,
          tool: "mcp/files/read",
          expected: "allow",
          actual: "allow",
          status: "passed",
        },
      ],
    },
  ],
  validation: { valid: true, errors: [], warnings: [] },
};

let sessionNumber = 0;
let currentHref = "/openappa/validation";
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  currentHref = "/openappa/validation";
  sessionStorage.clear();
  vi.mocked(useSession).mockReturnValue({
    data: {
      session: {
        id: `session-${++sessionNumber}`,
        activeOrganizationId: "test-org",
      },
    },
  } as ReturnType<typeof useSession>);
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(usePathname).mockImplementation(() => currentHref.split("?")[0]);
  vi.mocked(useSearchParams).mockImplementation(
    () =>
      new URLSearchParams(currentHref.split("?")[1]) as ReturnType<
        typeof useSearchParams
      >,
  );
  server.use(
    http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        source: {
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          lastSyncError: null,
        },
      }),
    ),
    http.get(endpoint, () => HttpResponse.json(collection)),
    http.get(`${endpoint}/runs`, () => HttpResponse.json([])),
    http.get(`${origin}/api/guardrails-policy`, () =>
      HttpResponse.json({
        contentHash: run.policyHash,
        revision: run.policyRevision,
        content: "[policy]\nversion = 2\n",
      }),
    ),
    http.get(`${origin}/api/openappa/effective-policy`, () =>
      HttpResponse.json({
        contentHash: run.effectivePolicyHash,
        content: "[policy]\nversion = 2\n",
        lastError: null,
      }),
    ),
    http.post(`${endpoint}/inspect`, async ({ request }) => {
      const { files } = (await request.json()) as {
        files: typeof collection.files;
      };
      return HttpResponse.json({
        files: files.map((file) => ({
          path: file.path,
          tools: ["mcp/files/read"],
          assertionCount: 1,
          error: null,
        })),
      });
    }),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("list starts without editors and displays parser-derived tools", async () => {
  server.use(
    http.post(`${endpoint}/inspect`, () =>
      HttpResponse.json({
        files: [
          {
            path: scenario.path,
            tools: ["mcp/files/read", "mcp/mail/send", "mcp/calendar/create"],
            assertionCount: 3,
            error: null,
          },
        ],
      }),
    ),
  );
  showPage();
  expect(
    await screen.findByRole("link", { name: scenario.path }),
  ).toHaveAttribute("href", "/openappa/validation/file?path=scenario.appa");
  expect(
    screen.queryByRole("textbox", { name: /Policy validation/ }),
  ).not.toBeInTheDocument();
  expect(await screen.findByText("mcp/files/read")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: `Show all tools for ${scenario.path}` }),
  );
  expect(await screen.findByText("mcp/calendar/create")).toBeVisible();
});

test("file navigation protects unsaved changes and saves bind the loaded version", async () => {
  let saved: unknown;
  server.use(
    http.put(endpoint, async ({ request }) => {
      saved = await request.json();
      return HttpResponse.json({
        ...collection,
        files: [{ ...scenario, content: "mcp/files/read {}\nexpect deny\n" }],
        version: "v2",
      });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "mcp/files/read {}\nexpect deny\n" } },
  );
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("textbox", { name: "Policy validation scenario.appa" }),
  ).toHaveValue("mcp/files/read {}\nexpect deny\n");
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await waitFor(() =>
    expect(saved).toEqual({
      files: [{ ...scenario, content: "mcp/files/read {}\nexpect deny\n" }],
      expectedVersion: "tests-v1",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save validation" }),
    ).toBeDisabled(),
  );
});

test("a source refresh preserves the active draft and prevents saving against the new version", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  showPage(client);
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  fireEvent.change(editor, { target: { value: "unsaved change" } });
  act(() =>
    client.setQueryData(["openappa-policy-tests", "active"], {
      ...collection,
      version: "new-version",
      files: [{ ...scenario, content: "external change" }],
    }),
  );
  expect(await screen.findByText("Validation source changed")).toBeVisible();
  expect(editor).toHaveValue("unsaved change");
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run file" })).toBeDisabled();
});

test("a rename save completing after leaving the editor does not navigate back into it", async () => {
  let finish: () => void = () => undefined;
  let began: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const next = {
    ...collection,
    files: [{ ...scenario, path: "renamed.appa" }],
    version: "v2",
  };
  server.use(
    http.put(endpoint, async () => {
      began();
      await pending;
      return HttpResponse.json(next);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  showPage(client);
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Validation filename" }),
    { target: { value: "renamed.appa" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await started;
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
      next,
    ),
  );
  expect(
    await screen.findByRole("link", { name: "renamed.appa" }),
  ).toBeVisible();
  expect(currentHref).toBe("/openappa/validation");
});

test("an older rename completing while a newer history draft is hidden preserves that draft's original version", async () => {
  let finish: () => void = () => undefined;
  let began: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const next = {
    ...collection,
    files: [{ ...scenario, path: "renamed.appa" }],
    version: "v2",
  };
  server.use(
    http.put(endpoint, async () => {
      began();
      await pending;
      return HttpResponse.json(next);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  currentHref = "/openappa/validation/file?path=scenario.appa";
  const first = showPage(client);
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Validation filename" }),
    { target: { value: "renamed.appa" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await started;
  first.unmount();
  const returned = showPage(client);
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Validation filename" }),
    { target: { value: "newer.appa" } },
  );
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation newer.appa",
    }),
    { target: { value: "newer hidden edit" } },
  );
  returned.unmount();
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
      next,
    ),
  );
  showPage(client);
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation newer.appa",
    }),
  ).toHaveValue("newer hidden edit");
  expect(
    screen.getByRole("textbox", { name: "Validation filename" }),
  ).toHaveValue("newer.appa");
  expect(await screen.findByText("Validation source changed")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
});

test("a clean editor reopened during a pending save adopts its completed version before another edit", async () => {
  let finish: () => void = () => undefined;
  let began: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const submissions: {
    files: typeof collection.files;
    expectedVersion: string;
  }[] = [];
  const next = {
    ...collection,
    files: [{ ...scenario, content: "saved change" }],
    version: "v2",
  };
  server.use(
    http.put(endpoint, async ({ request }) => {
      const submitted = (await request.json()) as (typeof submissions)[number];
      submissions.push(submitted);
      if (submissions.length === 1) {
        began();
        await pending;
        return HttpResponse.json(next);
      }
      return HttpResponse.json({
        ...next,
        files: submitted.files,
        version: "v3",
      });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "saved change" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await started;
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  const reopened = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  expect(reopened).toHaveValue(scenario.content);
  finish();
  await waitFor(() => expect(reopened).toHaveValue("saved change"));
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
  fireEvent.change(reopened, { target: { value: "newer change" } });
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await waitFor(() =>
    expect(submissions[1]).toEqual({
      files: [{ ...scenario, content: "newer change" }],
      expectedVersion: "v2",
    }),
  );
});

test.each([
  "file",
  "new",
])("%s history draft restores safely and clears on discard or session change", async (kind) => {
  currentHref =
    kind === "file"
      ? "/openappa/validation/file?path=scenario.appa"
      : "/openappa/validation/new";
  const label =
    kind === "file"
      ? "Policy validation scenario.appa"
      : "New validation content";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const first = showPage(client);
  fireEvent.change(await screen.findByRole("textbox", { name: label }), {
    target: { value: "first edit" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value: "latest edit" },
  });
  first.unmount();
  const restored = showPage(client);
  expect(await screen.findByRole("textbox", { name: label })).toHaveValue(
    "latest edit",
  );
  expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
    collection,
  );
  restored.unmount();
  vi.mocked(useSession).mockReturnValue({
    data: {
      session: { id: "another-session", activeOrganizationId: "test-org" },
    },
  } as ReturnType<typeof useSession>);
  showPage(client);
  expect(await screen.findByRole("textbox", { name: label })).toHaveValue(
    kind === "file" ? scenario.content : "",
  );
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value: "discard this edit" },
  });
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  const role = kind === "file" ? "link" : "button";
  const name = kind === "file" ? scenario.path : "Add validation";
  await screen.findByRole(role, { name });
  fireEvent.click(screen.getByRole(role, { name }));
  expect(currentHref).toBe(
    kind === "file"
      ? "/openappa/validation/file?path=scenario.appa"
      : "/openappa/validation/new",
  );
  expect(await screen.findByRole("textbox", { name: label })).toHaveValue(
    kind === "file" ? scenario.content : "",
  );
});

test.each([
  "file",
  "new",
])("%s history draft keeps its old source version when authoritative inputs changed", async (kind) => {
  currentHref =
    kind === "file"
      ? "/openappa/validation/file?path=scenario.appa"
      : "/openappa/validation/new";
  const label =
    kind === "file"
      ? "Policy validation scenario.appa"
      : "New validation content";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const first = showPage(client);
  fireEvent.change(await screen.findByRole("textbox", { name: label }), {
    target: { value: "older-source edit" },
  });
  first.unmount();
  const next = {
    ...collection,
    version: "new-version",
    files: [{ ...scenario, content: "external edit" }],
  };
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  client.setQueryData(["openappa-policy-tests", "active"], next);
  showPage(client);
  expect(await screen.findByRole("textbox", { name: label })).toHaveValue(
    "older-source edit",
  );
  expect(await screen.findByText("Validation source changed")).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: kind === "file" ? "Save validation" : "Create validation",
    }),
  ).toBeDisabled();
});

test("Git editor previews run without local save and become stale after edits", async () => {
  let payload: unknown;
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        ...collection,
        source: "github",
        sourceCommit: "accepted",
      }),
    ),
    http.post(`${endpoint}/preview`, async ({ request }) => {
      payload = await request.json();
      return HttpResponse.json({ ...run, source: "github", draft: true });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  expect(
    screen.queryByRole("button", { name: "Save validation" }),
  ).not.toBeInTheDocument();
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {value:1}\nexpect allow\n" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  await waitFor(() =>
    expect(payload).toEqual({
      files: [
        { ...scenario, content: "mcp/files/read {value:1}\nexpect allow\n" },
      ],
      sourceVersion: "tests-v1",
      directory: "traces",
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Passed").length).toBeGreaterThan(0),
  );
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {}\nexpect deny\n" },
  });
  expect(screen.getByText("Stale result")).toBeVisible();
});

test("file previews show draft diagnostics without changing suite results or history", async () => {
  let savedRuns = 0;
  let historyReads = 0;
  let previewPayload: unknown;
  server.use(
    http.get(`${endpoint}/runs`, () => {
      historyReads += 1;
      return HttpResponse.json([run]);
    }),
    http.post(`${endpoint}/run`, () => {
      savedRuns += 1;
      return HttpResponse.json(run);
    }),
    http.post(`${endpoint}/preview`, async ({ request }) => {
      previewPayload = await request.json();
      return HttpResponse.json({
        ...run,
        files: [
          {
            ...run.files[0],
            status: "failed",
            steps: [
              { ...run.files[0].steps[0], expected: "deny", status: "failed" },
            ],
          },
        ],
      });
    }),
  );
  showPage();
  const summary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(await within(summary).findByText("1 passed")).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {}\nexpect deny\n" },
  });
  const readsBeforePreview = historyReads;
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  expect(await screen.findByText("Editor test")).toBeVisible();
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  expect(previewPayload).toEqual({
    files: [{ ...scenario, content: "mcp/files/read {}\nexpect deny\n" }],
    sourceVersion: collection.version,
    directory: "traces",
  });
  expect(savedRuns).toBe(0);
  expect(historyReads).toBe(readsBeforePreview);
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  const unchangedSummary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(within(unchangedSummary).getByText("1 passed")).toBeVisible();
  expect(within(unchangedSummary).getByText("0 failed")).toBeVisible();
  fireEvent.click(
    within(unchangedSummary).getByRole("link", { name: "Run history" }),
  );
  expect(await screen.findByText("Revision 2")).toBeVisible();
  expect(
    screen.getAllByRole("button", {
      name: formatDate({ date: run.createdAt }),
    }),
  ).toHaveLength(1);
});

test("file preview failures preserve editor text and can be retried", async () => {
  let previews = 0;
  server.use(
    http.post(`${endpoint}/preview`, () => {
      previews += 1;
      return previews === 1
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json(run);
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  const draft = `${scenario.content}# editor draft\n`;
  fireEvent.change(editor, { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  expect(await screen.findByText("File test could not run")).toBeVisible();
  expect(editor).toHaveValue(draft);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Run file" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  expect(await screen.findByText("Editor test")).toBeVisible();
  expect(screen.queryByText("File test could not run")).not.toBeInTheDocument();
});

test.each([
  "root",
  "effective",
])("file preview becomes stale when the %s policy changes", async (changed) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  server.use(http.post(`${endpoint}/preview`, () => HttpResponse.json(run)));
  showPage(client);
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  await screen.findByText("Editor test");
  const key =
    changed === "root" ? ["guardrails-policy"] : ["openappa-effective-policy"];
  await waitFor(() => expect(client.getQueryData(key)).toBeDefined());
  act(() => client.setQueryData(key, { contentHash: "changed-policy-hash" }));
  expect(await screen.findByText("Stale result")).toBeVisible();
  expect(screen.getByText("Stale inputs")).toBeVisible();
});

test("file preview uses the editor draft and Run all uses persisted files after discard", async () => {
  let submitted: unknown;
  let suiteSubmitted: unknown;
  const files = [scenario, { ...scenario, path: "other.appa" }];
  const draft = { ...scenario, content: "mcp/files/read {}\nexpect deny\n" };
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.post(`${endpoint}/run`, async ({ request }) => {
      suiteSubmitted = await request.json();
      return HttpResponse.json(run);
    }),
    http.post(`${endpoint}/preview`, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json(run);
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: draft.content } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Run file" }));
  await screen.findByText("Editor test");
  expect(submitted).toEqual({
    files: [draft],
    sourceVersion: collection.version,
    directory: "traces",
  });
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(suiteSubmitted).toEqual({
      files,
      sourceVersion: collection.version,
      directory: "traces",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toHaveValue(scenario.content);
});

test("invalid files have honest summary and syntax diagnostics before a run", async () => {
  server.use(
    http.post(`${endpoint}/inspect`, () =>
      HttpResponse.json({
        files: [
          {
            path: scenario.path,
            tools: [],
            assertionCount: null,
            error: "Invalid tool at line 1",
          },
        ],
      }),
    ),
  );
  showPage();
  expect(await screen.findByText("Unparseable")).toBeVisible();
  expect(screen.queryByText("mcp/files/read")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  expect(await screen.findByText("Invalid tool at line 1")).toBeVisible();
});

test("repository errors disable inspection and replay without local fallback", async () => {
  let inspections = 0;
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        ...collection,
        source: "github",
        files: [],
        error: "Could not load repository validation",
      }),
    ),
    http.post(`${endpoint}/inspect`, () => {
      inspections++;
      return HttpResponse.json({ files: [] });
    }),
  );
  showPage();
  expect(
    await screen.findByText("Could not load repository validation"),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save validation" }),
  ).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(inspections).toBe(0);
});

test("Git directory configuration lives in source settings; browser refresh still protects editor drafts", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...collection, source: "github" }),
    ),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "draft" } },
  );
  const beforeUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(
    await screen.findByRole("link", { name: /repository/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/tree/main/traces",
  );
  expect(
    screen.queryByRole("textbox", { name: "Repository validation directory" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Use directory" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload" }),
  ).not.toBeInTheDocument();
  const afterDiscard = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(afterDiscard);
  expect(afterDiscard.defaultPrevented).toBe(false);
});

test("Git sync with no validation directory disables runs and points to source settings", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        ...collection,
        source: "github",
        files: [],
        directory: "",
        activeDirectory: "",
      }),
    ),
  );
  showPage();
  expect(await screen.findByText(/Validations are disabled/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Add validation" }),
  ).not.toBeInTheDocument();
});

test("duplicate filenames block saving until repaired, and a saved rename updates the route", async () => {
  const files = [scenario, { path: "other.appa", content: "second contents" }];
  let submitted: unknown;
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.put(endpoint, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json({
        ...collection,
        files: [scenario, { ...files[1], path: "repaired.appa" }],
        version: "v2",
      });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: "other.appa" }));
  const filename = await screen.findByRole("textbox", {
    name: "Validation filename",
  });
  fireEvent.change(filename, { target: { value: scenario.path } });
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
  expect(currentHref).toContain("other.appa");
  fireEvent.change(filename, { target: { value: "repaired.appa" } });
  fireEvent.click(screen.getByRole("button", { name: "Save validation" }));
  await waitFor(() =>
    expect(currentHref).toBe("/openappa/validation/file?path=repaired.appa"),
  );
  expect(submitted).toEqual({
    files: [scenario, { ...files[1], path: "repaired.appa" }],
    expectedVersion: collection.version,
  });
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation repaired.appa",
    }),
  ).toHaveValue("second contents");
});

test("list retains full totals across search and pagination", async () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `scenario-${String(i + 1).padStart(3, "0")}.appa`,
    content: scenario.content,
  }));
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        {
          ...run,
          files: files.map((file, i) => ({
            ...run.files[0],
            path: file.path,
            status: i < 6 ? "passed" : "failed",
          })),
        },
      ]),
    ),
  );
  showPage();
  expect(
    await screen.findByRole("link", { name: "scenario-001.appa" }),
  ).toBeVisible();
  expect(screen.getAllByText("Page 1 of 2")[0]).toBeVisible();
  const summary = screen.getByRole("status", { name: "Last validation run" });
  expect(await within(summary).findByText("6 failed")).toBeVisible();
  expect(within(summary).getByText("6 passed")).toBeVisible();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  );
  expect(
    await screen.findByRole("link", { name: "scenario-011.appa" }),
  ).toBeVisible();
  fireEvent.change(
    screen.getByPlaceholderText("Search validation filenames…"),
    { target: { value: "scenario-001" } },
  );
  expect(
    await screen.findByRole("link", { name: "scenario-001.appa" }),
  ).toBeVisible();
  expect(within(summary).getByText("6 failed")).toBeVisible();
  expect(within(summary).getByText("6 passed")).toBeVisible();
  expect(screen.getAllByText("Page 1 of 1")[0]).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  ).toBeDisabled();
});

test("pass and fail filters include execution failures and preserve the URL into detail navigation", async () => {
  const files = ["passed", "failed", "cannot_run", "not_run"].map((status) => ({
    ...scenario,
    path: `${status}.appa`,
  }));
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        {
          ...run,
          files: files.slice(0, 3).map((file, index) => ({
            ...run.files[0],
            path: file.path,
            status: ["passed", "failed", "cannot_run"][index],
            error: index === 2 ? "Unknown tool in this policy" : null,
          })),
        },
      ]),
    ),
  );
  showPage();
  await within(
    await screen.findByRole("status", { name: "Last validation run" }),
  ).findByText("1 passed");
  expect(
    screen.getByRole("link", { name: "not_run.appa" }).closest("tr"),
  ).toHaveTextContent("Never");
  for (const [value, label] of [
    ["passed", "Passed"],
    ["failed", "Failed"],
  ]) {
    fireEvent.click(
      screen.getByRole("combobox", { name: "Filter by validation status" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: label }));
    await waitFor(() =>
      expect(new URLSearchParams(currentHref.split("?")[1]).get("status")).toBe(
        value,
      ),
    );
    expect(
      await screen.findByRole("link", { name: `${value}.appa` }),
    ).toBeVisible();
    if (value === "failed") {
      const cannotRun = screen
        .getByRole("link", { name: "cannot_run.appa" })
        .closest("tr");
      expect(cannotRun).toHaveTextContent("Failed");
      expect(cannotRun).toHaveTextContent("Unknown tool in this policy");
      expect(
        screen.queryByRole("link", { name: "passed.appa" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "not_run.appa" }),
      ).not.toBeInTheDocument();
    }
  }
  fireEvent.click(screen.getByRole("link", { name: "cannot_run.appa" }));
  fireEvent.click(
    await screen.findByRole("link", { name: "Back to validation" }),
  );
  expect(new URLSearchParams(currentHref.split("?")[1]).get("status")).toBe(
    "failed",
  );
});

test("changed inputs retain the historical outcome and show its run time without stale statuses", async () => {
  currentHref = "/openappa/validation?status=passed";
  server.use(
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([{ ...run, stale: true }]),
    ),
  );
  showPage();
  const row = (
    await screen.findByRole("link", { name: scenario.path })
  ).closest("tr");
  expect(row).toHaveTextContent("Passed");
  expect(row).toHaveTextContent(formatDate({ date: run.createdAt }));
  expect(screen.queryByText("Stale inputs")).not.toBeInTheDocument();
  expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("combobox", { name: "Filter by validation status" }),
  );
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["All statuses", "Passed", "Failed"]);
});

test("each file shows its own most recent run when it is absent from the latest suite", async () => {
  const older = { ...scenario, path: "older.appa" };
  const createdAt = "2026-10-05T10:00:00.000Z";
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...collection, files: [scenario, older] }),
    ),
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        run,
        {
          ...run,
          id: "older",
          createdAt,
          files: [
            {
              ...run.files[0],
              path: older.path,
              status: "failed",
              error: "Expected deny, received allow",
            },
          ],
        },
      ]),
    ),
  );
  showPage();
  const olderRow = (
    await screen.findByRole("link", { name: older.path })
  ).closest("tr");
  await waitFor(() => expect(olderRow).toHaveTextContent("Failed"));
  expect(olderRow).toHaveTextContent(formatDate({ date: createdAt }));
  expect(olderRow).toHaveTextContent("Expected deny, received allow");
  expect(
    screen.getByRole("link", { name: scenario.path }).closest("tr"),
  ).toHaveTextContent(formatDate({ date: run.createdAt }));
});

test("page selection can expand across pages and remains stable across filters", async () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    ...scenario,
    path: `scenario-${i + 1}.appa`,
  }));
  let submitted: unknown;
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.post(`${endpoint}/run`, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json(run);
    }),
  );
  showPage();
  await screen.findByRole("link", { name: files[0].path });
  const pageActions = screen.getByRole("region", {
    name: "Validation page actions",
  });
  expect(
    within(pageActions).getByRole("button", { name: "Run all" }),
  ).toBeEnabled();
  expect(
    within(pageActions).queryByRole("button", { name: "Add validation" }),
  ).not.toBeInTheDocument();
  expect(
    within(pageActions).queryByRole("button", {
      name: "Ask About Validations",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Ask About Validations" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Write validations" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Select all validations on this page",
    }),
  );
  expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Select all 12 validations that match the current filters.",
    }),
  );
  expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  );
  expect(
    await screen.findByRole("checkbox", { name: "Select scenario-11.appa" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      files,
      sourceVersion: collection.version,
      directory: "traces",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select scenario-12.appa" }),
  );
  fireEvent.change(
    screen.getByPlaceholderText("Search validation filenames…"),
    { target: { value: "scenario-1.appa" } },
  );
  await screen.findByRole("link", { name: "scenario-1.appa" });
  expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  fireEvent.change(
    screen.getByPlaceholderText("Search validation filenames…"),
    { target: { value: "scenario-12" } },
  );
  expect(
    await screen.findByRole("checkbox", { name: "Select scenario-12.appa" }),
  ).toBeChecked();
  submitted = undefined;
  expect(
    screen.queryByRole("button", { name: /Run selected/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      files,
      sourceVersion: collection.version,
      directory: "traces",
    }),
  );
});

test("bulk local deletion persists immediately after confirmation", async () => {
  const files = [scenario, { ...scenario, path: "keep.appa" }];
  let saved: unknown;
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.put(endpoint, async ({ request }) => {
      saved = await request.json();
      return HttpResponse.json({
        ...collection,
        files: [files[1]],
        version: "tests-v2",
      });
    }),
  );
  showPage();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: `Select ${scenario.path}` }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 1 validation file?",
  });
  expect(saved).toBeUndefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("link", { name: scenario.path })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: scenario.path }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("link", { name: "keep.appa" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Save validation" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(saved).toEqual({
      files: [files[1]],
      expectedVersion: collection.version,
    }),
  );
});

test.each([
  { source: "github", canWrite: true },
  { source: "local", canWrite: false },
])("bulk deletion is absent for $source with write permission $canWrite", async ({
  source,
  canWrite,
}) => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          canWrite || permissions.openappaPolicy?.includes("update") !== true,
      }) as ReturnType<typeof useHasPermissions>,
  );
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, source })),
  );
  showPage();
  await screen.findByRole("link", { name: scenario.path });
  expect(
    screen.queryByRole("checkbox", { name: `Select ${scenario.path}` }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run all" })).toHaveProperty(
    "disabled",
    !canWrite,
  );
});

test("last-run summary links to paginated history and returns to the filtered collection", async () => {
  currentHref = "/openappa/validation?search=scenario";
  const runs = Array.from({ length: 20 }, (_, i) => ({
    ...run,
    id: `run-${i}`,
    policyRevision: 20 - i,
  }));
  server.use(http.get(`${endpoint}/runs`, () => HttpResponse.json(runs)));
  showPage();
  const summary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(await within(summary).findByText("1 passed")).toBeVisible();
  expect(summary).toHaveTextContent(formatDate({ date: run.createdAt }));
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.queryByText("Revision 20")).not.toBeInTheDocument();
  fireEvent.click(within(summary).getByRole("link", { name: "Run history" }));
  expect(currentHref).toBe("/openappa/validation/history");
  expect(await screen.findByText("Revision 20")).toBeVisible();
  expect(screen.getByText("Revision 11")).toBeVisible();
  expect(screen.queryByText("Revision 10")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: scenario.path }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  );
  expect(await screen.findByText("Revision 10")).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  expect(
    await screen.findByRole("link", { name: scenario.path }),
  ).toBeVisible();
  expect(new URLSearchParams(currentHref.split("?")[1]).get("search")).toBe(
    "scenario",
  );
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  fireEvent.click(
    await screen.findByRole("link", { name: "Back to validation" }),
  );
  expect(currentHref).toBe("/openappa/validation?search=scenario");
  fireEvent.click(
    await screen.findByRole("button", { name: "Add validation" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(currentHref).toBe("/openappa/validation?search=scenario");
});

test("empty history remains accessible from the summary", async () => {
  showPage();
  const summary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(await within(summary).findByText("No runs yet.")).toBeVisible();
  fireEvent.click(within(summary).getByRole("link", { name: "Run history" }));
  expect(await screen.findByText("No runs yet.")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Go to next page" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  expect(
    await screen.findByRole("link", { name: scenario.path }),
  ).toBeVisible();
});

test("last-run summary combines failures and retains draft markers and policy diagnostics", async () => {
  server.use(
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        {
          ...run,
          draft: true,
          stale: true,
          files: [
            run.files[0],
            { ...run.files[0], path: "failed.appa", status: "failed" },
            { ...run.files[0], path: "unsupported.appa", status: "cannot_run" },
          ],
          validation: {
            valid: false,
            errors: ["Missing tool contract"],
            warnings: ["Unused rule"],
          },
        },
      ]),
    ),
  );
  showPage();
  const summary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(await within(summary).findByText("1 passed")).toBeVisible();
  expect(within(summary).getByText("2 failed")).toBeVisible();
  expect(within(summary).queryByText("1 cannot run")).not.toBeInTheDocument();
  expect(within(summary).getByText("Draft run")).toBeVisible();
  expect(within(summary).queryByText("Stale inputs")).not.toBeInTheDocument();
  expect(screen.getAllByText("Missing tool contract").length).toBeGreaterThan(
    0,
  );
  expect(screen.getByText("Unused rule")).toBeVisible();
  const row = screen.getByRole("link", { name: scenario.path }).closest("tr");
  expect(row).toHaveTextContent("Failed");
  expect(row).toHaveTextContent(formatDate({ date: run.createdAt }));
});

test.each([
  "/openappa/validation",
  "/openappa/validation/history",
])("%s history failures are retryable and never presented as empty", async (href) => {
  currentHref = href;
  let failed = true;
  server.use(
    http.get(`${endpoint}/runs`, () =>
      failed
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json([run]),
    ),
  );
  showPage();
  expect(await screen.findByText("Could not load run history")).toBeVisible();
  expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  if (href.endsWith("/history"))
    expect(await screen.findByText("Revision 2")).toBeVisible();
  else
    expect(
      await within(
        screen.getByRole("status", { name: "Last validation run" }),
      ).findByText("1 passed"),
    ).toBeVisible();
});

test("Add opens an independent form and creates only after submission", async () => {
  let submitted:
    | { files: typeof collection.files; expectedVersion: string }
    | undefined;
  server.use(
    http.put(endpoint, async ({ request }) => {
      submitted = (await request.json()) as typeof submitted;
      return HttpResponse.json({
        ...collection,
        files: submitted?.files,
        version: "v2",
      });
    }),
  );
  showPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add validation" }),
  );
  expect(currentHref).toBe("/openappa/validation/new");
  expect(await screen.findByRole("textbox", { name: "Filename" })).toHaveValue(
    "scenario-2.appa",
  );
  expect(submitted).toBeUndefined();
  expect(
    screen.queryByRole("button", { name: "Save validation" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Filename" }), {
    target: { value: "new.appa" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "New validation content" }),
    { target: { value: scenario.content } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create validation" }));
  expect(
    await screen.findByRole("textbox", { name: "Policy validation new.appa" }),
  ).toHaveValue(scenario.content);
  expect(submitted).toEqual({
    files: [scenario, { path: "new.appa", content: scenario.content }],
    expectedVersion: collection.version,
  });
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  expect(await screen.findByRole("link", { name: "new.appa" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Save validation" }),
  ).not.toBeInTheDocument();
});

test("canceling creation discards its form without adding or saving a file", async () => {
  let writes = 0;
  server.use(
    http.put(endpoint, () => {
      writes += 1;
      return HttpResponse.json(collection);
    }),
  );
  showPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add validation" }),
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "New validation content" }),
    { target: { value: "unfinished draft" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("textbox", { name: "New validation content" }),
  ).toHaveValue("unfinished draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(
    await screen.findByRole("link", { name: scenario.path }),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "scenario-2.appa" }),
  ).not.toBeInTheDocument();
  expect(writes).toBe(0);
});

test("a failed create preserves form values for retry", async () => {
  server.use(
    http.put(endpoint, () =>
      HttpResponse.json(
        { error: { message: "The source changed" } },
        { status: 409 },
      ),
    ),
  );
  showPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add validation" }),
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "New validation content" }),
    { target: { value: "retry draft" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create validation" }));
  expect(await screen.findByText("Could not create validation")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "New validation content" }),
  ).toHaveValue("retry draft");
  expect(screen.getByRole("textbox", { name: "Filename" })).toHaveValue(
    "scenario-2.appa",
  );
  expect(currentHref).toBe("/openappa/validation/new");
});

test("file save and deletion preserve the other persisted files", async () => {
  const files = [scenario, { ...scenario, path: "keep.appa" }];
  const submissions: unknown[] = [];
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.put(endpoint, async ({ request }) => {
      const submitted = (await request.json()) as { files: typeof files };
      submissions.push(submitted);
      return HttpResponse.json({
        ...collection,
        files: submitted.files,
        version: `v${submissions.length + 1}`,
      });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("link", { name: scenario.path }));
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "saved change" } },
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Save validation" }),
  );
  await waitFor(() =>
    expect(submissions).toEqual([
      {
        files: [{ ...scenario, content: "saved change" }, files[1]],
        expectedVersion: collection.version,
      },
    ]),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Policy validation scenario.appa" }),
    ).not.toHaveAttribute("readonly"),
  );
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: `Select ${scenario.path}` }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() =>
    expect(submissions[1]).toEqual({
      files: [files[1]],
      expectedVersion: "v2",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("link", { name: "keep.appa" }));
  expect(
    await screen.findByRole("textbox", { name: "Policy validation keep.appa" }),
  ).toHaveValue(files[1].content);
  expect(
    screen.getByRole("button", { name: "Save validation" }),
  ).toBeDisabled();
});

test("history opens the chosen saved run's explanations by row and keyboard", async () => {
  currentHref = "/openappa/validation/history";
  const historical = {
    ...run,
    id: "older",
    createdAt: "2026-10-05T10:00:00.000Z",
    policyRevision: 1,
    files: [
      { ...run.files[0], path: "passed.appa" },
      {
        ...run.files[0],
        path: "failed.appa",
        status: "failed",
        steps: [
          {
            ...run.files[0].steps[0],
            expected: "deny",
            actual: "allow",
            status: "failed",
            error: "Expected a block but the policy allowed this tool",
          },
        ],
      },
      {
        ...run.files[0],
        path: "cannot.appa",
        status: "cannot_run",
        assertionCount: 0,
        steps: [],
        error: "Unknown tool in this policy",
      },
    ],
    validation: { valid: true, errors: [], warnings: ["Unused policy rule"] },
  };
  server.use(
    http.get(`${endpoint}/runs`, () => HttpResponse.json([run, historical])),
  );
  showPage();
  const historicalRow = (await screen.findByText("Revision 1")).closest("tr");
  if (!historicalRow) throw new Error("Historical run row missing");
  fireEvent.click(historicalRow);
  const dialog = await screen.findByRole("dialog", {
    name: "Validation run details",
  });
  expect(within(dialog).getByText("Unused policy rule")).toBeVisible();
  const passed = within(dialog).getByRole("region", { name: "passed.appa" });
  expect(passed).toHaveTextContent("All evaluated assertions matched");
  const failed = within(dialog).getByRole("region", { name: "failed.appa" });
  expect(within(failed).getByRole("cell", { name: "deny" })).toBeVisible();
  expect(within(failed).getByRole("cell", { name: "allow" })).toBeVisible();
  expect(failed).toHaveTextContent(
    "Expected a block but the policy allowed this tool",
  );
  expect(
    within(dialog).getByRole("region", { name: "cannot.appa" }),
  ).toHaveTextContent("Unknown tool in this policy");
  expect(
    within(dialog).queryByRole("region", { name: scenario.path }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  const dateButton = screen.getByRole("button", {
    name: formatDate({ date: historical.createdAt }),
  });
  dateButton.focus();
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Validation run details" }),
  ).toBeVisible();
});

test("policy readers cannot select directories or edit files", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: permissions.openappaPolicy?.includes("update") !== true,
      }) as ReturnType<typeof useHasPermissions>,
  );
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...collection, source: "github" }),
    ),
  );
  showPage();
  expect(await screen.findByText("Managed in GitHub")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Use directory" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Run file" })).toBeDisabled();
});

test("inventory rows open files while selection and compact actions stay independent", async () => {
  showPage();
  const row = (
    await screen.findByRole("link", { name: scenario.path })
  ).closest("tr");
  if (!row) throw new Error("Validation row missing");
  const checkbox = within(row).getByRole("checkbox", {
    name: `Select ${scenario.path}`,
  });
  fireEvent.click(checkbox);
  expect(currentHref).toBe("/openappa/validation");
  fireEvent.click(checkbox);
  fireEvent.click(within(row).getByRole("cell", { name: "Never" }), {
    ctrlKey: true,
  });
  expect(currentHref).toBe("/openappa/validation");
  fireEvent.click(within(row).getByRole("cell", { name: "Never" }));
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "Back to validation" }));
  await screen.findByRole("link", { name: scenario.path });
  expect(
    screen.queryByRole("button", { name: `Run ${scenario.path}` }),
  ).not.toBeInTheDocument();
  expect(currentHref).toBe("/openappa/validation");
  await screen.findByText("mcp/files/read");
  await userEvent.click(
    screen.getByRole("button", { name: `More actions ${scenario.path}` }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Delete" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 1 validation file?",
  });
  expect(currentHref).toBe("/openappa/validation");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("link", { name: `Edit ${scenario.path}` }));
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toBeVisible();
});

test("failed confirmed deletion retains the file and allows retry", async () => {
  let writes = 0;
  server.use(
    http.put(endpoint, () => {
      writes += 1;
      return writes === 1
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ ...collection, files: [], version: "tests-v2" });
    }),
  );
  showPage();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: `Select ${scenario.path}` }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 1 validation file?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    expect(writes).toBe(1);
    expect(
      within(dialog).getByRole("button", { name: "Delete" }),
    ).toBeEnabled();
  });
  expect(
    screen.getByText(scenario.path, { selector: "a" }),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    expect(writes).toBe(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: scenario.path }),
    ).not.toBeInTheDocument();
  });
});

function showPage(
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  }),
) {
  function Routes() {
    const [href, setHref] = useState(currentHref);
    const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
    function navigate(next: string) {
      currentHref = next;
      setHref(next);
    }
    vi.mocked(useRouter).mockReturnValue({
      push: navigate,
      replace: navigate,
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      bfcacheId: "validation-test",
    } as ReturnType<typeof useRouter>);
    return (
      <>
        <ListReturnUrlTracker />
        <section aria-label="Validation page actions">
          <div ref={setActionSlot} />
        </section>
        <OpenAppaPageActionSlotContext.Provider value={actionSlot}>
          <ValidationProvider>
            {href.startsWith("/openappa/validation/file") ? (
              <FilePage />
            ) : href.startsWith("/openappa/validation/new") ? (
              <NewPage />
            ) : href.startsWith("/openappa/validation/history") ? (
              <HistoryPage />
            ) : (
              <ValidationPage />
            )}
          </ValidationProvider>
        </OpenAppaPageActionSlotContext.Provider>
      </>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Routes />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

test("policy change results are identified in the last run and history", async () => {
  server.use(
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        { ...run, trigger: "policy_change", createdBy: null },
      ]),
    ),
  );
  showPage();
  const summary = await screen.findByRole("status", {
    name: "Last validation run",
  });
  expect(await within(summary).findByText("Policy change run")).toBeVisible();
  fireEvent.click(within(summary).getByRole("link", { name: "Run history" }));
  expect(await screen.findByText("Policy change run")).toBeVisible();
});

test("a refreshed automatic result replaces an older manual run in the inventory", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let history = [run];
  server.use(
    http.get(`${endpoint}/runs`, () => HttpResponse.json(history)),
    http.post(`${endpoint}/run`, () => HttpResponse.json(run)),
  );
  showPage(client);
  fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled(),
  );
  history = [
    {
      ...run,
      id: "automatic-newer",
      createdAt: "2026-10-06T11:00:00.000Z",
      trigger: "github_sync",
      files: [{ ...run.files[0], status: "failed" }],
    } as typeof run,
    run,
  ];
  await act(() =>
    client.invalidateQueries({ queryKey: ["openappa-policy-test-runs"] }),
  );
  await waitFor(() => {
    const summary = screen.getByRole("status", { name: "Last validation run" });
    expect(within(summary).getByText("Git sync run")).toBeVisible();
    expect(within(summary).getByText("1 failed")).toBeVisible();
    expect(
      screen.getByRole("link", { name: scenario.path }).closest("tr"),
    ).toHaveTextContent("Failed");
  });
});

test("unavailable automatic runs explain the problem in the summary and saved details", async () => {
  const message = "GitHub denied access to the validation directory";
  server.use(
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        { ...run, trigger: "github_sync", executionError: message, files: [] },
      ]),
    ),
  );
  showPage();
  await waitFor(() =>
    expect(screen.getAllByText(message).length).toBeGreaterThan(0),
  );
  const summary = screen.getByRole("status", { name: "Last validation run" });
  expect(within(summary).getByText("Failed")).toBeVisible();
  const row = screen.getByRole("link", { name: scenario.path }).closest("tr");
  expect(row).toHaveTextContent("Failed");
  expect(row).toHaveTextContent(message);
  expect(row).toHaveTextContent(formatDate({ date: run.createdAt }));
  expect(within(summary).queryByText("0 passed")).not.toBeInTheDocument();
  fireEvent.click(within(summary).getByRole("link", { name: "Run history" }));
  fireEvent.click(await screen.findByText("Revision 2"));
  const dialog = await screen.findByRole("dialog", {
    name: "Validation run details",
  });
  expect(within(dialog).getByText(message)).toBeVisible();
  expect(within(dialog).getByText("Cannot run")).toBeVisible();
});
