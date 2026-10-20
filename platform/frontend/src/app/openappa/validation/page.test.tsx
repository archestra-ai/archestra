import { createHash } from "node:crypto";
import {
  archestraApiClient,
  type OpenAppaValidationProgressMessage,
} from "@archestra/shared";
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
import { PageBackLink } from "@/components/page-back-link";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { ListReturnUrlTracker } from "@/lib/hooks/use-list-return-url";
import { formatDate } from "@/lib/utils/date-time";
import {
  OpenAppaHeaderModeContext,
  OpenAppaPageActionSlotContext,
  OpenAppaPageHeaderSlotsContext,
} from "../_parts/openappa-page-action";
import { validationFileHref } from "./_parts/validation-context";
import FilePage from "./file/page";
import HistoryPage from "./history/page";
import ValidationLayout from "./layout";
import NewPage from "./new/page";
import ValidationPage from "./page";

const socket = vi.hoisted(() => ({
  subscribers: [] as {
    type: string;
    handler: (message: unknown) => void;
  }[],
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
vi.mock("next/navigation");
// The WebSocket is a process boundary: capture subscriptions and push
// progress messages by hand.
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: async () => undefined,
    subscribe: (type: string, handler: (message: unknown) => void) => {
      const entry = { type, handler };
      socket.subscribers.push(entry);
      return () => {
        socket.subscribers.splice(socket.subscribers.indexOf(entry), 1);
      };
    },
  },
}));
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
  files: [
    {
      path: scenario.path,
      assertionCount: 1,
      status: "passed",
      contentHash: createHash("sha256").update(scenario.content).digest("hex"),
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
  socket.subscribers.length = 0;
  // jsdom has no matchMedia; ask for reduced motion so terminal output is
  // printed at once instead of streamed on timers.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
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
    http.get(`${origin}/api/agents/chat-roster`, () => HttpResponse.json([])),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        githubWebUrl: "https://github.com",
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

test("list starts without editors and shows no parser columns", async () => {
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
  await waitFor(() =>
    expect(screen.getByRole("link", { name: scenario.path })).toHaveAttribute(
      "href",
      "/openappa/validation/file?path=scenario.appa",
    ),
  );
  expect(
    screen.queryByRole("textbox", { name: /Policy validation/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("columnheader", { name: "Tools exercised" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("columnheader", { name: "Assertions" }),
  ).not.toBeInTheDocument();
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
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "mcp/files/read {}\nexpect deny\n" } },
  );
  clickBack();
  fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("textbox", { name: "Policy validation scenario.appa" }),
  ).toHaveValue("mcp/files/read {}\nexpect deny\n");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(saved).toEqual({
      files: [{ ...scenario, content: "mcp/files/read {}\nexpect deny\n" }],
      expectedVersion: "tests-v1",
    }),
  );
  // Saved and clean: there is nothing left to save.
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument(),
  );
});

test("a source refresh preserves the active draft and prevents saving against the new version", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  showPage(client);
  await openValidationFile(scenario.path);
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
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test draft" })).toBeDisabled();
});

test("the draft can still be exported when the source changed under it", async () => {
  // jsdom has no object URLs; the download itself is the browser's job.
  const createObjectURL = vi.fn((_blob: Blob) => "blob:validation");
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = () => undefined;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  showPage(client);
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "draft to keep" } },
  );
  act(() =>
    client.setQueryData(["openappa-policy-tests", "active"], {
      ...collection,
      version: "new-version",
    }),
  );
  expect(await screen.findByText("Validation source changed")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "More file actions" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Export" }),
  );
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(await createObjectURL.mock.calls[0][0].text()).toBe("draft to keep");
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
  await openValidationFile(scenario.path);
  await renameFile("renamed.appa");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  clickBack();
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
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "renamed.appa" })).toBeVisible(),
  );
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
  await renameFile("renamed.appa");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  first.unmount();
  const returned = showPage(client);
  await renameFile("newer.appa");
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
    screen.getByRole("button", { name: /^File path newer\.appa\b/ }),
  ).toBeVisible();
  expect(await screen.findByText("Validation source changed")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
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
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "saved change" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  clickBack();
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await openValidationFile(scenario.path);
  const reopened = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  expect(reopened).toHaveValue(scenario.content);
  finish();
  await waitFor(() => expect(reopened).toHaveValue("saved change"));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.change(reopened, { target: { value: "newer change" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
  const changedSession = showPage(client);
  expect(await screen.findByRole("textbox", { name: label })).toHaveValue(
    kind === "file" ? scenario.content : "",
  );
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value: "discard this edit" },
  });
  clickBack();
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await screen.findByRole("link", { name: scenario.path });
  if (kind === "file") {
    fireEvent.click(screen.getByRole("link", { name: scenario.path }));
    expect(currentHref).toBe("/openappa/validation/file?path=scenario.appa");
  } else {
    // The list has no button into the new-validation editor; reopen its route.
    changedSession.unmount();
    currentHref = "/openappa/validation/new";
    showPage(client);
  }
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
      name: kind === "file" ? "Save" : "Create validation",
    }),
  ).toBeDisabled();
});

test("Git editor previews run without local save and are dropped after edits", async () => {
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
  await openValidationFile(scenario.path);
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {value:1}\nexpect allow\n" },
  });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
  await waitFor(() =>
    expect(payload).toEqual({
      files: [
        { ...scenario, content: "mcp/files/read {value:1}\nexpect allow\n" },
      ],
      sourceVersion: "tests-v1",
      directory: "traces",
    }),
  );
  await waitFor(() => expect(runOutput()).toHaveTextContent("PASS"));
  expect(screen.getByText("Passed")).toBeVisible();
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {}\nexpect deny\n" },
  });
  expect(screen.queryByText("Passed")).not.toBeInTheDocument();
  expect(screen.getByText("Not run")).toBeVisible();
  expect(runOutput()).toHaveTextContent("No result yet");
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
              {
                ...run.files[0].steps[0],
                expected: "deny",
                status: "failed",
              },
            ],
          },
        ],
      });
    }),
  );
  showPage();
  expect(
    await screen.findByRole("button", { name: "1 passing" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  // The recorded result shows until a draft test replaces it.
  await waitFor(() => expect(runOutput()).toHaveTextContent("PASS"));
  fireEvent.change(editor, {
    target: { value: "mcp/files/read {}\nexpect deny\n" },
  });
  const readsBeforePreview = historyReads;
  fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
  await waitFor(() => expect(runOutput()).toHaveTextContent("FAIL"));
  expect(runOutput()).toHaveTextContent("+ Received allow");
  expect(screen.getByText("Failed")).toBeVisible();
  expect(previewPayload).toEqual({
    files: [{ ...scenario, content: "mcp/files/read {}\nexpect deny\n" }],
    sourceVersion: collection.version,
    directory: "traces",
  });
  expect(savedRuns).toBe(0);
  expect(historyReads).toBe(readsBeforePreview);
  clickBack();
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(
    await screen.findByRole("button", { name: "1 passing" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /failing$/ }),
  ).not.toBeInTheDocument();
  await openRunHistory();
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Open run from / }),
    ).toHaveLength(1),
  );
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
  await openValidationFile(scenario.path);
  const editor = await screen.findByRole("textbox", {
    name: "Policy validation scenario.appa",
  });
  const draft = `${scenario.content}# editor draft\n`;
  fireEvent.change(editor, { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
  expect(await screen.findByText("File test could not run")).toBeVisible();
  expect(editor).toHaveValue(draft);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test draft" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
  await waitFor(() => expect(runOutput()).toHaveTextContent("PASS"));
  expect(screen.queryByText("File test could not run")).not.toBeInTheDocument();
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
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: draft.content } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
  await waitFor(() => expect(runOutput()).toHaveTextContent("PASS"));
  expect(submitted).toEqual({
    files: [draft],
    sourceVersion: collection.version,
    directory: "traces",
  });
  clickBack();
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(suiteSubmitted).toEqual({
      files,
      sourceVersion: collection.version,
      directory: "traces",
      progressToken: expect.any(String),
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
  await waitFor(() =>
    expect(row(scenario.path)).toHaveTextContent("Invalid tool at line 1"),
  );
  expect(row(scenario.path)).toHaveTextContent("Not run");
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  expect(await screen.findByText("Invalid validation syntax")).toBeVisible();
  expect(screen.getByText("Invalid tool at line 1")).toBeVisible();
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
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(inspections).toBe(0);
});

test("a pending setup pull request replaces the repository error with the merge request", async () => {
  server.use(
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        githubWebUrl: "https://github.example.com",
        source: {
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          lastSyncError: null,
          setupPullRequestNumber: 7,
        },
      }),
    ),
    http.get(endpoint, () =>
      HttpResponse.json({
        ...collection,
        source: "github",
        files: [],
        error: "No accepted commit to read validations from",
      }),
    ),
  );
  showPage();
  expect(
    await screen.findByRole("link", { name: /Review and merge PR/ }),
  ).toHaveAttribute(
    "href",
    "https://github.example.com/example/policies/pull/7",
  );
  expect(
    screen.queryByText("No accepted commit to read validations from"),
  ).not.toBeInTheDocument();
});

test("Git directory configuration lives in source settings; browser refresh still protects editor drafts", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...collection, source: "github" }),
    ),
  );
  showPage();
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "draft" } },
  );
  const beforeUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);
  clickBack();
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await screen.findByRole("link", { name: scenario.path });
  expect(screen.queryByText("Managed in GitHub")).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "More validation actions" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: /Managed in GitHub/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/tree/main/traces",
  );
  await userEvent.keyboard("{Escape}");
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
  await openValidationFile("other.appa");
  await renameFile(scenario.path);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(currentHref).toContain("other.appa");
  await renameFile("repaired.appa");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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

test("the summary counts every file while search narrows only the table", async () => {
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
    await screen.findByRole("button", { name: "6 passing" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "6 failing" })).toBeVisible();
  // Every file is listed: no page holds any of them back.
  for (const file of files)
    expect(screen.getByRole("link", { name: file.path })).toBeVisible();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search validations" }),
    {
      target: { value: "scenario-001" },
    },
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "scenario-012.appa" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("link", { name: "scenario-001.appa" })).toBeVisible();
  expect(screen.getByRole("button", { name: "6 passing" })).toBeVisible();
  expect(screen.getByRole("button", { name: "6 failing" })).toBeVisible();
});

test("status filters keep failures, execution failures and unrun files apart and preserve the URL into detail navigation", async () => {
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
  await waitFor(() => expect(row("not_run.appa")).toHaveTextContent("Not run"));
  // The run skipped not_run.appa: the summary counts it as not run rather
  // than reporting the run's own totals.
  expect(
    await screen.findByRole("button", { name: "1 passing" }),
  ).toBeVisible();
  for (const name of ["1 failing", "1 cannot run", "1 not run"])
    expect(screen.getByRole("button", { name })).toBeVisible();
  for (const [value, label] of [
    ["passed", "1 passing"],
    ["failed", "1 failing"],
    ["cannot_run", "1 cannot run"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(new URLSearchParams(currentHref.split("?")[1]).get("status")).toBe(
        value,
      ),
    );
    expect(screen.getByRole("button", { name: label })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: `${value}.appa` })).toBeVisible(),
    );
    for (const other of ["passed", "failed", "cannot_run", "not_run"])
      if (other !== value)
        expect(
          screen.queryByRole("link", { name: `${other}.appa` }),
        ).not.toBeInTheDocument();
  }
  // The row says why it cannot run instead of hiding it behind the status.
  const cannotRun = row("cannot_run.appa");
  expect(cannotRun).toHaveTextContent("Cannot run");
  expect(cannotRun).toHaveTextContent("Unknown tool in this policy");
  fireEvent.click(screen.getByRole("link", { name: "cannot_run.appa" }));
  // A saved file shows its recorded result without running it again.
  await screen.findByRole("textbox", {
    name: "Policy validation cannot_run.appa",
  });
  await waitFor(() =>
    expect(runOutput()).toHaveTextContent("Unknown tool in this policy"),
  );
  expect(runOutput()).toHaveTextContent(
    formatDate({ date: run.createdAt, dateFormat: "MMM d, HH:mm:ss" }),
  );
  expect(screen.getByText("Cannot run")).toBeVisible();
  expect(screen.queryByText("Not run")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run file" })).toBeEnabled();
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "Back to validations" }),
    ).toHaveAttribute("href", "/openappa/validation?status=cannot_run"),
  );
  clickBack();
  expect(new URLSearchParams(currentHref.split("?")[1]).get("status")).toBe(
    "cannot_run",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "passed.appa" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("link", { name: "cannot_run.appa" })).toBeVisible();
});

test("changed inputs retain the historical outcome and show its run time", async () => {
  currentHref = "/openappa/validation?status=passed";
  server.use(http.get(`${endpoint}/runs`, () => HttpResponse.json([run])));
  showPage();
  await waitFor(() => {
    const scenarioRow = row(scenario.path);
    expect(scenarioRow).toHaveTextContent("Passed");
    expect(
      within(scenarioRow).getByTitle(formatDate({ date: run.createdAt })),
    ).toBeVisible();
  });
  // The filter came from the URL.
  expect(screen.getByRole("button", { name: "1 passing" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
        // A newer single-file run replaced scenario.appa's result.
        { ...run, partial: true },
        {
          ...run,
          id: "older",
          createdAt,
          files: [
            { ...run.files[0], status: "failed" },
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
  await waitFor(() => {
    const olderRow = row(older.path);
    expect(olderRow).toHaveTextContent("Failed");
    expect(
      within(olderRow).getByTitle(formatDate({ date: createdAt })),
    ).toBeVisible();
    expect(olderRow).toHaveTextContent("Expected deny, received allow");
  });
  const newerRow = row(scenario.path);
  expect(
    within(newerRow).getByTitle(formatDate({ date: run.createdAt })),
  ).toBeVisible();
  expect(newerRow).toHaveTextContent("Passed");
  // The summary adds up both files' newest results, not either run's totals.
  expect(screen.getByRole("button", { name: "1 passing" })).toBeVisible();
  expect(screen.getByRole("button", { name: "1 failing" })).toBeVisible();
  // The file's last run opens the run that recorded its result.
  fireEvent.click(
    within(row(older.path)).getByRole("button", {
      name: /^older\.appa: last run .*\. Open run$/,
    }),
  );
  expect(await findRunPanel()).toHaveTextContent(
    formatDate({ date: createdAt, dateFormat: "MMM d, yyyy HH:mm:ss" }),
  );
});

test("Run all submits every file even while the table is searched", async () => {
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
  await userEvent.click(
    within(pageActions).getByRole("button", {
      name: "More validation actions",
    }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Write a validation" }),
  ).toBeVisible();
  expect(
    screen.getByRole("menuitem", { name: "Explain validations" }),
  ).toBeVisible();
  await userEvent.keyboard("{Escape}");
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search validations" }),
    {
      target: { value: "scenario-12" },
    },
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "scenario-1.appa" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: /Run selected/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      files,
      sourceVersion: collection.version,
      directory: "traces",
      progressToken: expect.any(String),
    }),
  );
});

test("row deletion persists only after confirmation", async () => {
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
  await screen.findByRole("link", { name: scenario.path });
  await chooseRowAction(scenario.path, "Delete");
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 1 validation file?",
  });
  expect(saved).toBeUndefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("link", { name: scenario.path })).toBeVisible();
  await chooseRowAction(scenario.path, "Delete");
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
])("row deletion is absent for $source with write permission $canWrite", async ({
  source,
  canWrite,
}) => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          canWrite || permissions.guardrailsPolicy?.includes("update") !== true,
      }) as ReturnType<typeof useHasPermissions>,
  );
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, source })),
  );
  showPage();
  await screen.findByRole("link", { name: scenario.path });
  expect(
    screen.queryByRole("button", {
      name: `More actions for ${scenario.path}`,
    }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run all" })).toHaveProperty(
    "disabled",
    !canWrite,
  );
});

test("last run opens the recorded run in the runner panel; history returns to the filtered collection", async () => {
  currentHref = "/openappa/validation?search=scenario";
  const runs = Array.from({ length: 20 }, (_, i) => ({
    ...run,
    id: `run-${i}`,
    policyRevision: 20 - i,
  }));
  server.use(http.get(`${endpoint}/runs`, () => HttpResponse.json(runs)));
  showPage();
  expect(
    await screen.findByRole("textbox", { name: "Search validations" }),
  ).toHaveValue("scenario");
  fireEvent.click(await findLastRun());
  // The newest run opens in place; the list stays where it was.
  const panel = await findRunPanel();
  expect(panel).toHaveTextContent("REPLAY");
  expect(panel).toHaveTextContent("policy rev 20");
  expect(currentHref).toBe("/openappa/validation?search=scenario");
  fireEvent.click(
    within(panel).getByRole("button", { name: "Open run history" }),
  );
  expect(currentHref).toBe("/openappa/validation/history");
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^Open run from / }),
    ).toHaveLength(20),
  );
  clickBack();
  await waitFor(() =>
    expect(screen.getByRole("link", { name: scenario.path })).toBeVisible(),
  );
  expect(new URLSearchParams(currentHref.split("?")[1]).get("search")).toBe(
    "scenario",
  );
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "Back to validations" }),
    ).toHaveAttribute("href", "/openappa/validation?search=scenario"),
  );
  clickBack();
  expect(currentHref).toBe("/openappa/validation?search=scenario");
});

test("empty history stays reachable from the page actions", async () => {
  showPage();
  await screen.findByRole("link", { name: scenario.path });
  expect(
    screen.queryByRole("button", { name: /^Last run/ }),
  ).not.toBeInTheDocument();
  await openRunHistory();
  expect(await screen.findByText("No runs yet")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /older runs/ }),
  ).not.toBeInTheDocument();
  clickBack();
  await waitFor(() =>
    expect(screen.getByRole("link", { name: scenario.path })).toBeVisible(),
  );
});

test("the summary adds up the per-file statuses, so a refused policy passes none", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        ...collection,
        files: [
          scenario,
          { ...scenario, path: "failed.appa" },
          { ...scenario, path: "unsupported.appa" },
        ],
      }),
    ),
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        {
          ...run,
          draft: true,
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
  // A refused policy decided nothing about any file, so the summary agrees
  // with the rows instead of repeating the run's raw counts.
  expect(
    await screen.findByRole("button", { name: "0 passing" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "3 cannot run" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /failing$/ }),
  ).not.toBeInTheDocument();
  const scenarioRow = row(scenario.path);
  expect(scenarioRow).toHaveTextContent("Cannot run");
  expect(scenarioRow).toHaveTextContent("Missing tool contract");
  expect(
    within(scenarioRow).getByTitle(formatDate({ date: run.createdAt })),
  ).toBeVisible();
});

test("an opened recorded run stays open when run history refreshes", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const failed = {
    ...run,
    files: [
      {
        ...run.files[0],
        status: "failed",
        error: "Expected deny, received allow",
      },
    ],
  };
  let history: unknown[] = [failed];
  server.use(http.get(`${endpoint}/runs`, () => HttpResponse.json(history)));
  showPage(client);
  fireEvent.click(await findLastRun());
  const panel = await findRunPanel();
  expect(panel).toHaveTextContent("REPLAY");
  // An unrelated older run arrives; this run is unchanged.
  history = [
    failed,
    { ...run, id: "older", createdAt: "2026-10-01T10:00:00Z" },
  ];
  await act(() =>
    client.invalidateQueries({ queryKey: ["openappa-policy-test-runs"] }),
  );
  await waitFor(() =>
    expect(
      client.getQueryData<unknown[]>(["openappa-policy-test-runs"]),
    ).toHaveLength(2),
  );
  expect(panel).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Validation run panel" }),
  ).toHaveTextContent(
    formatDate({ date: run.createdAt, dateFormat: "MMM d, yyyy HH:mm:ss" }),
  );
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
  expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  if (href.endsWith("/history"))
    expect(
      await screen.findByRole("button", { name: /^Open run from / }),
    ).toBeVisible();
  else
    expect(
      await screen.findByRole("button", { name: "1 passing" }),
    ).toBeVisible();
});

test("the new validation editor creates only after submission", async () => {
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
  currentHref = "/openappa/validation/new";
  showPage();
  expect(await screen.findByRole("textbox", { name: "Filename" })).toHaveValue(
    "scenario-2.appa",
  );
  expect(submitted).toBeUndefined();
  expect(
    screen.queryByRole("button", { name: "Save" }),
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
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  clickBack();
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "new.appa" })).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
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
  currentHref = "/openappa/validation/new";
  showPage();
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
  await waitFor(() =>
    expect(screen.getByRole("link", { name: scenario.path })).toBeVisible(),
  );
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
  currentHref = "/openappa/validation/new";
  showPage();
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
  await openValidationFile(scenario.path);
  fireEvent.change(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
    { target: { value: "saved change" } },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
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
  clickBack();
  await screen.findByRole("link", { name: scenario.path });
  await chooseRowAction(scenario.path, "Delete");
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
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
});

test("history opens the chosen saved run's explanations by column and keyboard", async () => {
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
  const column = await screen.findByRole("button", {
    name: new RegExp(
      `^Open run from ${escapeRegExp(formatDate({ date: historical.createdAt }))}, policy revision 1`,
    ),
  });
  column.focus();
  await userEvent.keyboard("{Enter}");
  const panel = await findRunPanel();
  expect(panel).toHaveTextContent("Unused policy rule");
  for (const path of ["passed.appa", "failed.appa", "cannot.appa"])
    expect(within(panel).getByRole("button", { name: path })).toBeVisible();
  expect(
    within(panel).queryByRole("button", { name: scenario.path }),
  ).not.toBeInTheDocument();
  expect(panel).toHaveTextContent("expected deny, got allow");
  fireEvent.click(within(panel).getByRole("tab", { name: /Problems/ }));
  const problems = within(panel).getByRole("tabpanel", { name: "Problems" });
  expect(problems).toHaveTextContent(
    "Expected a block but the policy allowed this tool",
  );
  expect(problems).toHaveTextContent("Unknown tool in this policy");
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Validation run panel" }),
    ).not.toBeInTheDocument(),
  );
  // Selecting one file's cell explains that result and opens its run. A file
  // no longer in the suite is named after its path.
  fireEvent.click(
    screen.getByRole("button", {
      name: `failed, ${formatDate({ date: historical.createdAt })}: Failed`,
    }),
  );
  const why = screen.getByText("Why").closest("div") as HTMLElement;
  expect(why).toHaveTextContent(
    "Expected a block but the policy allowed this tool",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open run" }));
  expect(await findRunPanel()).toHaveTextContent("Unused policy rule");
});

test("policy readers cannot select directories or edit files", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: permissions.guardrailsPolicy?.includes("update") !== true,
      }) as ReturnType<typeof useHasPermissions>,
  );
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...collection, source: "github" }),
    ),
  );
  showPage();
  await screen.findByRole("link", { name: scenario.path });
  await userEvent.click(
    screen.getByRole("button", { name: "More validation actions" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: /Managed in GitHub/ }),
  ).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(
    screen.queryByRole("button", { name: "Use directory" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: scenario.path }));
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toHaveAttribute("readonly");
  expect(screen.getByText("Managed in GitHub")).toBeVisible();
  expect(screen.getByRole("button", { name: "Run file" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /Rename file$/ }),
  ).not.toBeInTheDocument();
});

test("inventory rows open files while row actions stay independent", async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const files = [scenario, { ...scenario, path: "other.appa" }];
  const waitForInspection = () =>
    waitFor(
      () =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .some(
              (mutation) =>
                mutation.state.status === "success" &&
                JSON.stringify(mutation.state.variables) ===
                  JSON.stringify({ files }),
            ),
        ).toBe(true),
      { timeout: 5000 },
    );
  const submissions: unknown[] = [];
  let finishRun: () => void = () => undefined;
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.post(`${endpoint}/run`, async ({ request }) => {
      submissions.push(await request.json());
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return HttpResponse.json({ ...run, partial: true });
    }),
  );
  showPage(client);
  await screen.findByRole("link", { name: scenario.path });
  const statusCell = (
    await screen.findAllByRole("cell", { name: /Not run|Passed/ })
  )[0];
  fireEvent.click(statusCell, { ctrlKey: true });
  expect(currentHref).toBe("/openappa/validation");
  fireEvent.click(statusCell);
  expect(
    await screen.findByRole("textbox", {
      name: "Policy validation scenario.appa",
    }),
  ).toBeVisible();
  // Exercise the case where inspection finishes while the editor is open.
  await waitForInspection();
  clickBack();
  await screen.findByRole("link", { name: scenario.path });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: `Run ${scenario.path}` }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: `Run ${scenario.path}` }));
  expect(currentHref).toBe("/openappa/validation");
  await waitFor(() =>
    expect(submissions).toEqual([
      {
        files: [scenario],
        sourceVersion: collection.version,
        directory: "traces",
        partial: true,
        progressToken: expect.any(String),
      },
    ]),
  );
  // A single run is followed in the runner panel, like Run all.
  expect(await findRunPanel()).toHaveTextContent("RUN");
  expect(row(scenario.path)).toHaveTextContent("Running");
  expect(row("other.appa")).not.toHaveTextContent("Running");
  finishRun();
  await waitFor(() =>
    expect(row(scenario.path)).not.toHaveTextContent("Running"),
  );
  // Navigation keeps the suite provider mounted, so reuse its completed
  // inspection instead of expecting a new mutation after returning to the list.
  await waitForInspection();
  await chooseRowAction(scenario.path, "Delete");
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 1 validation file?",
  });
  expect(currentHref).toBe("/openappa/validation");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
});

test("an open runner panel comes back after a page refresh until it is closed", async () => {
  server.use(http.get(`${endpoint}/runs`, () => HttpResponse.json([run])));
  const first = showPage();
  fireEvent.click(await findLastRun());
  expect(await findRunPanel()).toHaveTextContent("REPLAY");
  first.unmount();

  const second = showPage();
  const panel = await findRunPanel();
  expect(panel).toHaveTextContent("REPLAY");
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() =>
    expect(sessionStorage.getItem("openappa-validation-runner")).toBeNull(),
  );
  second.unmount();

  showPage();
  await screen.findByRole("link", { name: scenario.path });
  expect(
    screen.queryByRole("region", { name: "Validation run panel" }),
  ).not.toBeInTheDocument();
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
  await screen.findByRole("link", { name: scenario.path });
  await chooseRowAction(scenario.path, "Delete");
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

test("policy change and single-file runs are identified in run history", async () => {
  const singleAt = "2026-10-05T10:00:00.000Z";
  server.use(
    http.get(`${endpoint}/runs`, () =>
      HttpResponse.json([
        { ...run, trigger: "policy_change", createdBy: null },
        {
          ...run,
          id: "single",
          createdAt: singleAt,
          policyRevision: 1,
          partial: true,
        },
      ]),
    ),
  );
  showPage();
  await screen.findByRole("link", { name: scenario.path });
  await openRunHistory();
  fireEvent.click(
    await screen.findByRole("button", {
      name: `scenario.appa, ${formatDate({ date: run.createdAt })}: Passed`,
    }),
  );
  expect(runFacts()).toHaveTextContent("Policy save");
  fireEvent.click(
    screen.getByRole("button", {
      name: `scenario.appa, ${formatDate({ date: singleAt })}: Passed`,
    }),
  );
  expect(runFacts()).toHaveTextContent("Manual · single file");
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
    expect(screen.getByRole("button", { name: "0 passing" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1 failing" })).toBeVisible();
    expect(row(scenario.path)).toHaveTextContent("Failed");
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
  expect(screen.getByText("Validation could not run")).toBeVisible();
  expect(screen.getByRole("button", { name: "0 passing" })).toBeVisible();
  // The run stopped before replaying any file, so no file has a result.
  expect(screen.getByRole("button", { name: "1 not run" })).toBeVisible();
  expect(row(scenario.path)).toHaveTextContent("Not run");
  fireEvent.click(await findLastRun());
  const panel = await findRunPanel();
  expect(panel).toHaveTextContent("ERROR");
  expect(within(panel).getByText(message)).toBeVisible();
});

test("Run all follows its own progress events before the run is recorded", async () => {
  const files = [scenario, { ...scenario, path: "other.appa" }];
  let submitted: { progressToken?: string } | undefined;
  let finishRun: () => void = () => undefined;
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.post(`${endpoint}/run`, async ({ request }) => {
      submitted = (await request.json()) as typeof submitted;
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return HttpResponse.json({
        ...run,
        files: files.map((file) => ({ ...run.files[0], path: file.path })),
      });
    }),
  );
  showPage();
  fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
  const panel = await findRunPanel();
  await waitFor(() =>
    expect(submitted?.progressToken).toEqual(expect.any(String)),
  );
  const token = submitted?.progressToken as string;
  expect(panel).toHaveTextContent("2 queued");
  // Another run's progress is not this run's.
  pushProgress({
    token: "someone-else",
    phase: "file_finished",
    path: "other.appa",
    status: "failed",
    assertionCount: 1,
    durationMs: 5,
    steps: [],
  });
  expect(
    within(panel).queryByRole("button", { name: "other.appa" }),
  ).not.toBeInTheDocument();
  pushProgress({ token, phase: "started", paths: files.map((f) => f.path) });
  pushProgress({ token, phase: "file_started", path: scenario.path });
  pushProgress({
    token,
    phase: "file_finished",
    path: scenario.path,
    status: "passed",
    assertionCount: 1,
    durationMs: 12,
    steps: [run.files[0].steps[0]] as OpenAppaValidationProgressStep[],
  });
  // The file finished while the HTTP request is still open.
  await waitFor(() =>
    expect(
      within(panel).getByRole("button", { name: scenario.path }),
    ).toBeVisible(),
  );
  expect(panel).toHaveTextContent("1 queued");
  expect(panel).not.toHaveTextContent("All validations match");
  finishRun();
  await waitFor(() =>
    expect(panel).toHaveTextContent(
      "All validations match the current policy.",
    ),
  );
  expect(
    within(panel).getByRole("button", { name: "other.appa" }),
  ).toBeVisible();
});

test("Run all completes from the recorded run when no progress events arrive", async () => {
  const files = [scenario, { ...scenario, path: "other.appa" }];
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...collection, files })),
    http.post(`${endpoint}/run`, () =>
      HttpResponse.json({
        ...run,
        files: [
          run.files[0],
          {
            ...run.files[0],
            path: "other.appa",
            status: "failed",
            steps: [
              {
                ...run.files[0].steps[0],
                expected: "deny",
                status: "failed",
              },
            ],
          },
        ],
      }),
    ),
  );
  showPage();
  fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
  const panel = await findRunPanel();
  await waitFor(() =>
    expect(panel).toHaveTextContent("1 problem — open the Problems tab"),
  );
  for (const path of [scenario.path, "other.appa"])
    expect(within(panel).getByRole("button", { name: path })).toBeVisible();
  expect(panel).toHaveTextContent("expected deny, got allow");
  expect(panel).not.toHaveTextContent("queued");
});

type OpenAppaValidationProgressStep = Extract<
  OpenAppaValidationProgressMessage["payload"],
  { phase: "file_finished" }
>["steps"][number];

/** Delivers a progress message to every live subscription. */
function pushProgress(payload: OpenAppaValidationProgressMessage["payload"]) {
  act(() => {
    for (const entry of [...socket.subscribers])
      if (entry.type === "openappa_validation_progress")
        entry.handler({ type: "openappa_validation_progress", payload });
  });
}

/** The inline last-run control in the summary strip; it opens that run. */
function findLastRun() {
  return screen.findByRole("button", { name: /^Last run/ });
}

/** The docked runner panel, once it has slid open. */
function findRunPanel() {
  return screen.findByRole("region", { name: "Validation run panel" });
}

/** The terminal pane under a file's editor. */
function runOutput() {
  return screen.getByRole("region", { name: "Run output" });
}

/** The selected run's facts in the history detail panel. */
function runFacts() {
  return screen.getByText("Trigger").closest("dl") as HTMLElement;
}

function row(path: string) {
  return screen.getByRole("link", { name: path }).closest("tr") as HTMLElement;
}

/** The header's back arrow on detail pages, or the new page's own back link. */
function clickBack() {
  fireEvent.click(screen.getByRole("link", { name: /^Back to validations?$/ }));
}

async function renameFile(next: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: /^File path .*Rename file$/ }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Rename file" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "File path" }), {
    target: { value: next },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rename file" }),
    ).not.toBeInTheDocument(),
  );
}

async function chooseRowAction(path: string, action: string) {
  // A late re-render can still swap the row's actions and close the menu
  // under load, so open it until the action is there to click.
  await waitFor(
    async () => {
      if (!screen.queryByRole("menu"))
        await userEvent.click(
          screen.getByRole("button", { name: `More actions for ${path}` }),
        );
      expect(screen.getByRole("menuitem", { name: action })).toBeVisible();
    },
    { timeout: 5000 },
  );
  await userEvent.click(screen.getByRole("menuitem", { name: action }));
}

async function openRunHistory() {
  await userEvent.click(
    screen.getByRole("button", { name: "More validation actions" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Run history" }),
  );
}

async function openValidationFile(path: string) {
  await screen.findByRole("link", { name: path });
  fireEvent.click(screen.getByRole("link", { name: path }));
  expect(currentHref).toBe(validationFileHref(path));
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    const [title, setTitle] = useState<HTMLSpanElement | null>(null);
    const [status, setStatus] = useState<HTMLSpanElement | null>(null);
    const [description, setDescription] = useState<HTMLSpanElement | null>(
      null,
    );
    const [mode, setMode] = useState<{ back: boolean } | null>(null);
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
    // Stands in for the Guardrails layout header: a file page, or a page that
    // asks for it, gets the back arrow to the list.
    const back = href.startsWith("/openappa/validation/file") || mode?.back;
    return (
      <>
        <ListReturnUrlTracker />
        <header>
          {back && (
            <PageBackLink href="/openappa/validation">
              Back to validations
            </PageBackLink>
          )}
          <h1>
            <span ref={setTitle} />
          </h1>
          <span ref={setStatus} />
          <span ref={setDescription} />
        </header>
        <section aria-label="Validation page actions">
          <div ref={setActionSlot} />
        </section>
        <OpenAppaPageHeaderSlotsContext.Provider
          value={{ title, status, description }}
        >
          <OpenAppaPageActionSlotContext.Provider value={actionSlot}>
            <OpenAppaHeaderModeContext.Provider value={setMode}>
              <ValidationLayout>
                {href.startsWith("/openappa/validation/file") ? (
                  <FilePage />
                ) : href.startsWith("/openappa/validation/new") ? (
                  <NewPage />
                ) : href.startsWith("/openappa/validation/history") ? (
                  <HistoryPage />
                ) : (
                  <ValidationPage />
                )}
              </ValidationLayout>
            </OpenAppaHeaderModeContext.Provider>
          </OpenAppaPageActionSlotContext.Provider>
        </OpenAppaPageHeaderSlotsContext.Provider>
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
