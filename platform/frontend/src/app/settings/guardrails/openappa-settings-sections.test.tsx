import { archestraApiClient } from "@archestra/shared";
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
import { GUARDRAILS_SWITCH_TOAST } from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  OpenAppaClientCoverageSetting,
  OpenAppaEnforcementSetting,
} from "./openappa-settings-sections";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer();
let enabled: boolean;
let mode: "observe" | "enforce";
let featureEnabled: boolean;
let clientAction: "bypass" | "block";
// Fields the deployment still carries for older clients; no control here.
const compatibilityFields = {
  humanApprovalMode: "unattended",
  unapprovableBlockMode: "refuse",
  breakTheGlassEnabled: true,
  environmentOverrides: [],
};
let revision: number;
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
  enabled = false;
  mode = "enforce";
  featureEnabled = true;
  clientAction = "bypass";
  revision = 1;
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({
        enabled,
        mode: enabled ? mode : "off",
        featureEnabled,
        active: enabled,
        unsupportedClientAction: clientAction,
        ...compatibilityFields,
      }),
    ),
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
  return render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
}
function readOnly() {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          permissions.organizationSettings?.every(
            (action) => action === "read",
          ) ?? false,
      }) as ReturnType<typeof useHasPermissions>,
  );
}

test("the enforcement switch turns enforcement on and off", async () => {
  const sent: boolean[] = [];
  server.use(
    http.put(`${api}/guardrails-deployment`, async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      sent.push(body.enabled);
      enabled = body.enabled;
      return HttpResponse.json({
        enabled,
        mode: enabled ? mode : "off",
        featureEnabled: true,
        active: enabled,
        unsupportedClientAction: clientAction,
      });
    }),
  );
  show(<OpenAppaEnforcementSetting />);
  const toggle = await screen.findByRole("switch", {
    name: "Enforce the policy",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(await screen.findByText(/Guardrails are on/)).toBeInTheDocument();
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(sent).toEqual([true, false]);
});

test("under Observe the switch says so, and turning it back on enforces", async () => {
  vi.mocked(toast.success).mockClear();
  enabled = true;
  mode = "observe";
  server.use(
    http.put(`${api}/guardrails-deployment`, async ({ request }) => {
      enabled = ((await request.json()) as { enabled: boolean }).enabled;
      // The backend turns the switch back on in Enforce.
      if (enabled) mode = "enforce";
      return HttpResponse.json({
        enabled,
        mode: enabled ? mode : "off",
        featureEnabled: true,
        active: enabled,
        unsupportedClientAction: clientAction,
      });
    }),
  );
  show(<OpenAppaEnforcementSetting />);
  const observing = await screen.findByRole("switch", {
    name: "Observe the policy",
  });
  expect(observing).toBeChecked();
  expect(
    screen.queryByRole("switch", { name: "Enforce the policy" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(observing).toBeEnabled());
  fireEvent.click(observing);
  const off = await screen.findByRole("switch", { name: "Enforce the policy" });
  await waitFor(() => expect(off).not.toBeChecked());
  await waitFor(() => expect(off).toBeEnabled());
  fireEvent.click(off);
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Enforce the policy" }),
    ).toBeChecked(),
  );
  // Each save names the mode its response runs in.
  expect(vi.mocked(toast.success).mock.calls).toEqual([
    [GUARDRAILS_SWITCH_TOAST.off],
    [GUARDRAILS_SWITCH_TOAST.enforce],
  ]);
});

test("enforcement cannot be turned on before a policy exists", async () => {
  revision = 0;
  show(<OpenAppaEnforcementSetting />);
  expect(
    await screen.findByRole("link", { name: "Create your policy" }),
  ).toHaveAttribute("href", "/openappa");
  expect(
    screen.getByRole("switch", { name: "Enforce the policy" }),
  ).toBeDisabled();
});

test("members who cannot manage enforcement see the switch disabled", async () => {
  readOnly();
  show(<OpenAppaEnforcementSetting />);
  const toggle = await screen.findByRole("switch", {
    name: "Enforce the policy",
  });
  // Let the policy load: until it does, the switch is disabled for everyone.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(toggle).toBeDisabled();
});

test("an administrator blocks requests from other clients", async () => {
  const updates: unknown[] = [];
  server.use(
    http.put(`${api}/guardrails-deployment`, async ({ request }) => {
      const body = (await request.json()) as {
        unsupportedClientAction: "bypass" | "block";
      };
      updates.push(body);
      clientAction = body.unsupportedClientAction;
      return HttpResponse.json({
        enabled,
        featureEnabled,
        active: enabled,
        unsupportedClientAction: clientAction,
      });
    }),
  );
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
