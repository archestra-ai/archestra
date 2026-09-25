import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { withSetupRule } from "./setup-rule";
import { OpenAppaSetupWizard } from "./setup-wizard";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("next/navigation");
vi.mock("sonner");

const origin = "http://localhost:9000";
const policyUrl = `${origin}/api/guardrails-policy`;
const deploymentUrl = `${origin}/api/guardrails-deployment`;
const serverId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";
const initialContent = "[policy]\nversion = 2\n";
const server = setupServer();
let content: string;
let revision: number;
let savedContents: string[];
let enableAttempts: number;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  content = initialContent;
  revision = 1;
  savedContents = [];
  enableAttempts = 0;
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(usePathname).mockReturnValue("/openappa/setup");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("scrollTo", vi.fn());
  server.use(
    http.get(policyUrl, () =>
      HttpResponse.json({
        organizationId: "org",
        revision,
        content,
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
    http.put(policyUrl, async ({ request }) => {
      const body = (await request.json()) as {
        content: string;
        expectedRevision: number;
      };
      if (body.expectedRevision !== revision)
        return new HttpResponse(null, { status: 409 });
      savedContents.push(body.content);
      content = body.content;
      revision += 1;
      return HttpResponse.json({
        organizationId: "org",
        revision,
        content,
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      });
    }),
    http.get(deploymentUrl, () =>
      HttpResponse.json({
        enabled: false,
        active: false,
        featureEnabled: true,
      }),
    ),
    http.put(deploymentUrl, () => {
      enableAttempts += 1;
      if (enableAttempts === 1) return new HttpResponse(null, { status: 500 });
      return HttpResponse.json({
        enabled: true,
        active: true,
        featureEnabled: true,
      });
    }),
    http.get(`${origin}/api/openappa/coverage/entities`, () =>
      HttpResponse.json({
        data: [
          {
            id: serverId,
            name: "GitHub",
            type: "mcp_server",
            scope: "org",
            icon: null,
            toolCount: 1,
            governedCount: 0,
            fallbackCount: 1,
            builtInCount: 0,
            autoMode: false,
          },
        ],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ),
    http.get(`${origin}/api/openappa/coverage/tools`, ({ request }) => {
      const catalogId = new URL(request.url).searchParams.get("catalogId");
      const data =
        catalogId === serverId
          ? [
              {
                toolId: "tool-1",
                catalogId: serverId,
                catalogName: "GitHub",
                catalogIcon: null,
                prefix: "github",
                name: "create_issue",
                fullName: "github__create_issue",
                kind: "unlisted",
                policySource: "fallback",
                rule: null,
                unlisted: true,
                enforced: false,
                agents: [],
              },
            ]
          : [];
      return HttpResponse.json({
        data,
        servers: [{ id: serverId, name: "GitHub", icon: null }],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: data.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
    http.post(`${policyUrl}/validate`, () =>
      HttpResponse.json({
        valid: true,
        errors: [],
        warnings: ['include "missing" resolves to no battery'],
      }),
    ),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({ enabled: false, source: null, hasPolicy: false }),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OpenAppaSetupWizard />
    </QueryClientProvider>,
  );
  return client;
}

async function openRuleStep() {
  const client = mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Your tools" }));
  await screen.findByText("GitHub");
  await user.click(screen.getByRole("button", { name: "First rule" }));
  return { user, client };
}

async function reviewToolRule() {
  const { user, client } = await openRuleStep();
  await user.click(
    screen.getByRole("radio", { name: /^Ask before using a toolExample:/ }),
  );
  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: pick a tool",
    }),
  );
  await user.click(await screen.findByRole("option", { name: /create_issue/ }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  return { user, client };
}

test("shows validation warnings and retries enabling without saving the rule again", async () => {
  await reviewToolRule();
  expect(
    await screen.findByText('include "missing" resolves to no battery'),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Save and turn on" }));
  await waitFor(() => expect(enableAttempts).toBe(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled(),
  );
  expect(
    screen.getByText(/Your rule was saved. OpenAPPA is still off/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "First rule" })).toBeDisabled();
  expect(savedContents).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await screen.findByRole("heading", { name: "OpenAPPA is on" });
  expect(enableAttempts).toBe(2);
  expect(savedContents).toHaveLength(1);
});

test("keeps Review open while saving, so a failed enable can be retried", async () => {
  let releaseSave = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveStarted = () => {};
  const started = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  server.use(
    http.put(policyUrl, async ({ request }) => {
      saveStarted();
      await saveGate;
      const body = (await request.json()) as { content: string };
      savedContents.push(body.content);
      content = body.content;
      revision += 1;
      return HttpResponse.json({
        organizationId: "org",
        revision,
        content,
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      });
    }),
  );
  const { user } = await reviewToolRule();
  await user.click(screen.getByRole("button", { name: "Save and turn on" }));
  await started;
  await user.click(
    screen.getByRole("button", { name: /Step 3 of 5: First rule, complete/ }),
  );
  expect(
    screen.getByRole("heading", { name: "Review before you turn it on" }),
  ).toBeVisible();
  releaseSave();
  await waitFor(() => expect(enableAttempts).toBe(1));
  expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
  expect(
    screen.getByRole("heading", { name: "Review before you turn it on" }),
  ).toBeVisible();
  expect(savedContents).toHaveLength(1);
});

test("validates the existing policy when skipping a rule and shows its warnings", async () => {
  const validated: string[] = [];
  server.use(
    http.post(`${policyUrl}/validate`, async ({ request }) => {
      validated.push(((await request.json()) as { content: string }).content);
      return HttpResponse.json({
        valid: true,
        errors: [],
        warnings: ['include "missing" resolves to no battery'],
      });
    }),
  );
  const { user } = await openRuleStep();
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(
    await screen.findByText('include "missing" resolves to no battery'),
  ).toBeVisible();
  expect(validated).toEqual([initialContent]);
  expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
  expect(savedContents).toHaveLength(0);
});

test("can add a rule after returning from a skipped Review", async () => {
  const { user } = await openRuleStep();
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  await screen.findByRole("heading", {
    name: "Review before you turn it on",
  });
  await user.click(screen.getByRole("button", { name: "First rule" }));
  await user.click(
    screen.getByRole("radio", { name: /^Ask before using a toolExample:/ }),
  );
  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: pick a tool",
    }),
  );
  await user.click(await screen.findByRole("option", { name: /create_issue/ }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(
    await screen.findByRole("button", { name: "Save and turn on" }),
  ).toBeEnabled();
});

test("skipping an invalid existing policy shows errors and blocks enabling", async () => {
  server.use(
    http.post(`${policyUrl}/validate`, () =>
      HttpResponse.json({
        valid: false,
        errors: ["Unknown trust rank"],
        warnings: [],
      }),
    ),
  );
  const { user } = await openRuleStep();
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Unknown trust rank")).toBeVisible();
  expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
});

test("an already present setup rule proceeds without a second policy save", async () => {
  content = withSetupRule(initialContent, {
    shape: "tool",
    guarded: "github__create_issue",
  }).content;
  server.use(
    http.put(deploymentUrl, () => {
      enableAttempts += 1;
      return HttpResponse.json({
        enabled: true,
        active: true,
        featureEnabled: true,
      });
    }),
  );
  await reviewToolRule();
  expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
  expect(
    screen.getByText("No new rule. Your policy stays as it is."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await screen.findByRole("heading", { name: "OpenAPPA is on" });
  expect(savedContents).toHaveLength(0);
  expect(enableAttempts).toBe(1);
});

test("an edit during validation cannot send an unvalidated rule to Review", async () => {
  let releaseValidation = () => {};
  const validationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  let validationStarted = () => {};
  const started = new Promise<void>((resolve) => {
    validationStarted = resolve;
  });
  server.use(
    http.post(`${policyUrl}/validate`, async () => {
      validationStarted();
      await validationGate;
      return HttpResponse.json({ valid: true, errors: [], warnings: [] });
    }),
  );
  const { user } = await openRuleStep();
  await user.click(
    screen.getByRole("radio", { name: /^Ask before using a toolExample:/ }),
  );
  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: pick a tool",
    }),
  );
  await user.click(await screen.findByRole("option", { name: /create_issue/ }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await started;
  await user.click(
    screen.getByRole("radio", {
      name: /^Ask before using a tool againExample:/,
    }),
  );
  releaseValidation();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled(),
  );
  expect(
    screen.getByRole("heading", { name: "Choose your first rule" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Review before you turn it on" }),
  ).not.toBeInTheDocument();
});

test("a policy change after validation blocks saving the stale Review", async () => {
  const { client } = await reviewToolRule();
  client.setQueryData(["guardrails-policy"], {
    organizationId: "org",
    revision: 2,
    content: `${initialContent}# another edit\n`,
    contentHash: "new-hash",
    updatedBy: null,
    updatedAt: null,
  });
  expect(
    await screen.findByText(/The policy changed since validation/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save and turn on" }),
  ).toBeDisabled();
  expect(savedContents).toHaveLength(0);
});
