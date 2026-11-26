import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
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
import appConfig from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import {
  GUARDRAILS_MODE_TOAST,
  type GuardrailsMode,
  type PersonApproval,
} from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  OpenAppaClientCoverageSetting,
  OpenAppaEnforcedMarksSetting,
  OpenAppaEnforcementSetting,
  OpenAppaPersonApprovalSetting,
} from "./openappa-settings-sections";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer();
type Update = archestraApiTypes.UpdateGuardrailsDeploymentData["body"];
let mode: GuardrailsMode;
let personApproval: PersonApproval;
let enforcedMarks: string[];
let environmentOverrides: archestraApiTypes.GetGuardrailsDeploymentResponses[200]["environmentOverrides"];
let featureEnabled: boolean;
let clientAction: "bypass" | "block";
let revision: number;
let updates: Update[];
let warnings: string[];
function deployment() {
  return {
    mode,
    personApproval,
    enforcedMarks,
    enabled: mode !== "off",
    featureEnabled,
    active: mode !== "off",
    unsupportedClientAction: clientAction,
    // Fields the deployment still carries for older clients; no control here.
    humanApprovalMode: "block",
    unapprovableBlockMode: "refuse",
    breakTheGlassEnabled: true,
    environmentOverrides,
    annotatorModelId: null,
    annotatorLlmApiKeyId: null,
  };
}
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  // The Guardrails status is read only while OpenAPPA is on.
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "openappaEnabled",
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  mode = "off";
  personApproval = "ask";
  enforcedMarks = [];
  environmentOverrides = [];
  featureEnabled = true;
  clientAction = "bypass";
  revision = 1;
  updates = [];
  warnings = [];
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json(deployment()),
    ),
    http.put(`${api}/guardrails-deployment`, async ({ request }) => {
      const update = (await request.json()) as Update;
      updates.push(update);
      mode = update.mode ?? mode;
      personApproval = update.personApproval ?? personApproval;
      enforcedMarks = update.enforcedMarks ?? enforcedMarks;
      clientAction = update.unsupportedClientAction ?? clientAction;
      return HttpResponse.json({ ...deployment(), warnings });
    }),
    http.get(`${api}/guardrails-policy`, () =>
      HttpResponse.json({
        organizationId: "org",
        revision,
        content: "",
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(content: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>{content}</QueryClientProvider>,
    ),
  };
}
/** Every permission but changing organization settings. */
function readOnly() {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !permissions.organizationSettings?.includes("update"),
      }) as ReturnType<typeof useHasPermissions>,
  );
}

async function choose(name: string, option: RegExp) {
  const selector = await screen.findByRole("combobox", { name });
  await waitFor(() => expect(selector).toBeEnabled());
  fireEvent.click(selector);
  fireEvent.click(screen.getByRole("option", { name: option }));
  return selector;
}

test("choosing Observe saves it and says so", async () => {
  mode = "enforce";
  vi.mocked(toast.success).mockClear();
  show(<OpenAppaEnforcementSetting />);
  const selector = await choose("Guardrails mode", /^Observe/);
  await waitFor(() => expect(selector).toHaveTextContent("Observe"));
  expect(updates).toEqual([{ mode: "observe" }]);
  expect(vi.mocked(toast.success).mock.calls).toEqual([
    [GUARDRAILS_MODE_TOAST.observe],
  ]);
});

test("a save's warnings show as toasts", async () => {
  mode = "enforce";
  warnings = ["first warning", "second warning"];
  vi.mocked(toast.warning).mockClear();
  show(<OpenAppaPersonApprovalSetting />);
  await choose("Approvals", /^Always automatic/);
  await waitFor(() =>
    expect(vi.mocked(toast.warning).mock.calls).toEqual([
      ["first warning"],
      ["second warning"],
    ]),
  );
});

test("the mode cannot be chosen before a policy exists", async () => {
  revision = 0;
  show(<OpenAppaEnforcementSetting />);
  expect(
    await screen.findByRole("link", { name: "Create your policy" }),
  ).toHaveAttribute("href", "/openappa");
  expect(
    screen.getByRole("combobox", { name: "Guardrails mode" }),
  ).toBeDisabled();
});

test.each([
  ["Guardrails mode", <OpenAppaEnforcementSetting key="mode" />],
  ["Approvals", <OpenAppaPersonApprovalSetting key="approvals" />],
])("members who cannot manage it see %s disabled", async (name, block) => {
  mode = "enforce";
  readOnly();
  const { client } = show(block);
  const selector = await screen.findByRole("combobox", { name });
  // Until the policy loads, the mode is disabled for everyone.
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(selector).toBeDisabled();
});

test("approvals can be set before switching to Enforce", async () => {
  mode = "observe";
  show(<OpenAppaPersonApprovalSetting />);
  const selector = await choose("Approvals", /^Automatic in Agent Runtime/);
  await waitFor(() =>
    expect(selector).toHaveTextContent("Automatic in Agent Runtime"),
  );
  expect(updates).toEqual([{ personApproval: "auto_unattended" }]);
});

test("without reading the policy, an administrator still changes an active mode", async () => {
  mode = "enforce";
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({ data: !permissions.guardrailsPolicy }) as ReturnType<
        typeof useHasPermissions
      >,
  );
  show(<OpenAppaEnforcementSetting />);
  await choose("Guardrails mode", /^Observe/);
  await waitFor(() => expect(updates).toEqual([{ mode: "observe" }]));
});

test("approvals an environment variable sets cannot be changed", async () => {
  mode = "enforce";
  environmentOverrides = [
    { setting: "humanApprovalMode", variable: "APPROVAL_VARIABLE" },
    { setting: "personApproval", variable: "APPROVAL_VARIABLE" },
  ];
  show(<OpenAppaPersonApprovalSetting />);
  expect(
    await screen.findByRole("combobox", { name: "Approvals" }),
  ).toBeDisabled();
  expect(screen.getByText("APPROVAL_VARIABLE")).toBeInTheDocument();
});

test("adding and removing a mark keeps marks saved elsewhere meanwhile", async () => {
  enforcedMarks = ["pii"];
  show(<OpenAppaEnforcedMarksSetting />);
  const input = await screen.findByRole("textbox", {
    name: "New enforced mark",
  });
  await waitFor(() => expect(input).toBeEnabled());
  enforcedMarks = ["pii", "payment"];
  fireEvent.change(input, { target: { value: "  secrets " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input).toHaveValue(""));
  expect(await screen.findByText("secrets")).toBeInTheDocument();
  enforcedMarks = [...enforcedMarks, "audit"];
  fireEvent.click(screen.getByRole("button", { name: "Remove pii" }));
  await waitFor(() =>
    expect(screen.queryByText("pii")).not.toBeInTheDocument(),
  );
  expect(updates).toEqual([
    { enforcedMarks: ["pii", "payment", "secrets"] },
    { enforcedMarks: ["payment", "secrets", "audit"] },
  ]);
});

test.each([
  ["a blank mark", "   "],
  ["a mark over 128 characters", "m".repeat(129)],
  ["a mark with NUL", "p\u0000ii"],
])("%s is not saved", async (_name, value) => {
  enforcedMarks = ["pii"];
  const { client } = show(<OpenAppaEnforcedMarksSetting />);
  const input = await screen.findByRole("textbox", {
    name: "New enforced mark",
  });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  // A save starts synchronously on Enter, so none is pending means none was sent.
  expect(client.isMutating()).toBe(0);
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
});

test.each([
  ["a mark already saved", ["pii"], 0],
  [
    "a mark past the 64 limit",
    Array.from({ length: 64 }, (_, i) => `m${i}`),
    1,
  ],
])("%s is not sent", async (_name, saved, errors) => {
  enforcedMarks = saved;
  vi.mocked(toast.error).mockClear();
  const { client } = show(<OpenAppaEnforcedMarksSetting />);
  const input = await screen.findByRole("textbox", {
    name: "New enforced mark",
  });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "pii" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(client.isMutating()).toBe(1);
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(updates).toEqual([]);
  expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(errors);
});

test("an administrator blocks requests from other clients", async () => {
  show(<OpenAppaClientCoverageSetting />);
  const selector = await screen.findByRole("combobox", {
    name: "Requests from other clients",
  });
  expect(selector).toHaveTextContent("Allowed");
  fireEvent.click(selector);
  fireEvent.click(screen.getByRole("option", { name: /Blocked/ }));
  await waitFor(() =>
    expect(updates).toEqual([{ unsupportedClientAction: "block" }]),
  );
  await waitFor(() => expect(selector).toHaveTextContent("Blocked"));
});

test("a rejected change keeps other clients allowed", async () => {
  const rejected = vi.fn(() => new HttpResponse(null, { status: 403 }));
  server.use(http.put(`${api}/guardrails-deployment`, rejected));
  show(<OpenAppaClientCoverageSetting />);
  const selector = await screen.findByRole("combobox", {
    name: "Requests from other clients",
  });
  fireEvent.click(selector);
  fireEvent.click(screen.getByRole("option", { name: /Blocked/ }));
  await waitFor(() => expect(rejected).toHaveBeenCalledOnce());
  await waitFor(() => expect(selector).toBeEnabled());
  expect(selector).toHaveTextContent("Allowed");
});

test.each([
  ["members who cannot manage it", readOnly],
  [
    "without the feature flag",
    () => {
      featureEnabled = false;
    },
  ],
])("the other-clients setting is disabled for %s", async (_name, arrange) => {
  arrange();
  show(<OpenAppaClientCoverageSetting />);
  expect(
    await screen.findByRole("combobox", {
      name: "Requests from other clients",
    }),
  ).toBeDisabled();
});

test("links 'more' to the clients page and 'OpenAPPA session headers' to session-headers", async () => {
  show(<OpenAppaClientCoverageSetting />);
  const moreLink = await screen.findByRole("link", { name: /^more/ });
  expect(moreLink).toHaveAttribute(
    "href",
    expect.stringMatching(/\/agents\/guardrails\/clients$/),
  );
  expect(
    screen.getByRole("link", { name: /^OpenAPPA session headers/ }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("agents/guardrails/clients#session-headers"),
  );
});

test("hidden docs links keep the branded client coverage explanation", async () => {
  vi.spyOn(
    appConfig.enterpriseFeatures,
    "fullWhiteLabeling",
    "get",
  ).mockReturnValue(true);
  vi.mocked(useAppName).mockReturnValue("Workspace");
  const { container } = show(<OpenAppaClientCoverageSetting />);
  await screen.findByRole("combobox", { name: "Requests from other clients" });
  expect(container).toHaveTextContent(
    "Guardrails follow Workspace chat, Claude Code, Codex, and more, plus any client that sends OpenAPPA session headers.",
  );
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
