import {
  archestraApiClient,
  type BatteryCredentialRequest,
} from "@archestra/shared";
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
  expect,
  it,
  vi,
} from "vitest";
import { clearPersistedQueryCache } from "@/lib/query-persistence";
import {
  BatteryCredentialsTool,
  parseBatteryCredentialRequest,
} from "./battery-credentials-tool";

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

type Definition = {
  id: string;
  key: string;
  name: string;
  kind: "secret" | "github_app";
  description: string;
  icon: string | null;
  builtIn: boolean;
  allowPersonal: boolean;
  allowOrganization: boolean;
  personalConfigured: boolean;
  organizationConfigured: boolean;
};

let definitions: Definition[] = [];
let connected: { key: string; value: string }[] = [];

const request: BatteryCredentialRequest = {
  batteries: [
    {
      name: "slack",
      title: "Slack",
      benefit: "Slack benefit.",
      setup: ["Open https://api.slack.com/apps."],
      credentials: ["APPA_PROVIDER_SLACK_TOKEN"],
    },
    {
      name: "github",
      title: "GitHub",
      benefit: null,
      setup: [],
      credentials: ["APPA_PROVIDER_GITHUB_TOKEN"],
    },
  ],
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  clearPersistedQueryCache();
  sessionStorage.clear();
  definitions = [
    definition({ id: "slack", key: "slack-token", name: "Slack token" }),
    definition({
      id: "personal",
      key: "my-token",
      name: "My token",
      allowOrganization: false,
      organizationConfigured: false,
    }),
  ];
  connected = [];
  server.use(
    http.get(`${API_ORIGIN}/api/credentials`, () =>
      HttpResponse.json(definitions),
    ),
    http.post(`${API_ORIGIN}/api/credentials`, async ({ request }) => {
      const body = (await request.json()) as { key: string; name: string };
      const created = definition({
        id: `created-${definitions.length}`,
        key: body.key,
        name: body.name,
        organizationConfigured: false,
      });
      definitions = [...definitions, created];
      return HttpResponse.json(created);
    }),
    http.put(
      `${API_ORIGIN}/api/credentials/:key/organization`,
      async ({ params, request }) => {
        const key = String(params.key);
        const { value } = (await request.json()) as { value: string };
        connected.push({ key, value });
        definitions = definitions.map((entry) =>
          entry.key === key
            ? { ...entry, organizationConfigured: true }
            : entry,
        );
        return HttpResponse.json({ success: true });
      },
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("steps through batteries and sends the picked key or skip per variable on Done", async () => {
  const user = userEvent.setup();
  const onSendMessage = vi.fn();
  renderCard({ request, onSendMessage });
  const card = screen.getByTestId("battery-credentials-card");
  expect(card).toHaveTextContent("1 of 2");
  expect(screen.getByRole("region", { name: "Slack" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

  await waitFor(() => expect(definitionsLoaded()).toBe(true));
  await user.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("option", { name: "My token" })).toBeNull();
  await user.click(screen.getByRole("option", { name: "Slack token" }));
  await user.click(screen.getByRole("button", { name: "Next" }));

  expect(card).toHaveTextContent("2 of 2");
  expect(screen.getByRole("region", { name: "GitHub" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Skip APPA_PROVIDER_GITHUB_TOKEN" }),
  );

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("region", { name: "Slack" })).toHaveTextContent(
    "Slack token",
  );
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: Slack APPA_PROVIDER_SLACK_TOKEN → slack-token; GitHub APPA_PROVIDER_GITHUB_TOKEN → skipped.",
  );
  expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
});

it("creates and connects a new token through the credential dialogs, then selects it", async () => {
  const user = userEvent.setup();
  const onSendMessage = vi.fn();
  renderCard({ request: { batteries: [request.batteries[1]] }, onSendMessage });
  expect(screen.getByTestId("battery-credentials-card")).not.toHaveTextContent(
    "1 of 1",
  );

  await addToken(user, "Add new token", "ghp_secret");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(
    definitions.filter((entry) => entry.name === "GitHub token"),
  ).toHaveLength(1);
  expect(connected).toEqual([
    { key: "credential-github-token", value: "ghp_secret" },
  ]);
  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: GitHub APPA_PROVIDER_GITHUB_TOKEN → credential-github-token.",
  );
});

it("connects the secret an earlier attempt made instead of creating another", async () => {
  const user = userEvent.setup();
  definitions = [
    ...definitions,
    definition({
      id: "earlier",
      key: "credential-github-token",
      name: "GitHub token",
      organizationConfigured: false,
    }),
  ];
  const onSendMessage = vi.fn();
  renderCard({ request: { batteries: [request.batteries[1]] }, onSendMessage });

  await addToken(user, "Connect GitHub token", "ghp_secret");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(
    definitions.filter((entry) => entry.name === "GitHub token"),
  ).toHaveLength(1);
  expect(connected).toEqual([
    { key: "credential-github-token", value: "ghp_secret" },
  ]);
  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: GitHub APPA_PROVIDER_GITHUB_TOKEN → credential-github-token.",
  );
});

it("gives each variable of a two-token battery its own secret", async () => {
  const user = userEvent.setup();
  definitions = [
    ...definitions,
    // A same-named GitHub App is not a token this card can reuse.
    definition({
      id: "app",
      key: "credential-databricks-appa-provider-databricks-host-token",
      name: "Databricks APPA_PROVIDER_DATABRICKS_HOST token",
      kind: "github_app",
    }),
  ];
  const onSendMessage = vi.fn();
  renderCard({
    request: {
      batteries: [
        {
          name: "databricks",
          title: "Databricks",
          benefit: null,
          setup: [],
          credentials: [
            "APPA_PROVIDER_DATABRICKS_TOKEN",
            "APPA_PROVIDER_DATABRICKS_HOST",
          ],
        },
      ],
    },
    onSendMessage,
  });

  await waitFor(() => expect(definitionsLoaded()).toBe(true));
  const [first, second] = screen.getAllByRole("button", {
    name: "Add new token",
  });
  await addTokenFrom(user, first, "token-value");
  await addTokenFrom(user, second, "host-value");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(definitions.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([
      "Databricks APPA_PROVIDER_DATABRICKS_TOKEN token",
      "Databricks APPA_PROVIDER_DATABRICKS_HOST token",
    ]),
  );
  expect(connected.map(({ value }) => value)).toEqual([
    "token-value",
    "host-value",
  ]);
  const [tokenKey, hostKey] = connected.map(({ key }) => key);
  expect(tokenKey).not.toBe(hostKey);
  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    `Battery credentials: Databricks APPA_PROVIDER_DATABRICKS_TOKEN → ${tokenKey}; Databricks APPA_PROVIDER_DATABRICKS_HOST → ${hostKey}.`,
  );
});

it("asks for a Vault reference instead of a secret when the secrets manager is external", async () => {
  const user = userEvent.setup();
  definitions = [
    ...definitions,
    definition({
      id: "earlier",
      key: "credential-github-token",
      name: "GitHub token",
      organizationConfigured: false,
    }),
  ];
  renderCard({
    request: { batteries: [request.batteries[1]] },
    onSendMessage: vi.fn(),
    byosEnabled: true,
  });

  await user.click(
    await screen.findByRole("button", { name: "Connect GitHub token" }),
  );

  expect(
    await screen.findByRole("dialog", { name: /Set external secret/ }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: /^Connect/ })).toBeNull();
});

it("reads the card's batteries from the tool result only when they are well formed", () => {
  expect(parseBatteryCredentialRequest({ structuredContent: request })).toEqual(
    request,
  );
  expect(
    parseBatteryCredentialRequest({ structuredContent: { batteries: [] } }),
  ).toBeNull();
  expect(parseBatteryCredentialRequest("Opened the card.")).toBeNull();
});

let latestClient: QueryClient | null = null;

function definitionsLoaded() {
  return (
    latestClient?.getQueryState(["runtime-credentials"])?.status === "success"
  );
}

function renderCard(params: {
  request: BatteryCredentialRequest;
  onSendMessage: (text: string) => void;
  byosEnabled?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  latestClient = queryClient;
  // The config query waits for a session; the cache stands in for its answer.
  queryClient.setQueryData(["config"], {
    features: { byosEnabled: params.byosEnabled ?? false },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BatteryCredentialsTool
        request={params.request}
        toolCallId="call-1"
        onSendMessage={params.onSendMessage}
      />
    </QueryClientProvider>,
  );
}

async function addToken(
  user: ReturnType<typeof userEvent.setup>,
  button: string,
  value: string,
) {
  await addTokenFrom(
    user,
    await screen.findByRole("button", { name: button }),
    value,
  );
}

async function addTokenFrom(
  user: ReturnType<typeof userEvent.setup>,
  button: HTMLElement,
  value: string,
) {
  await user.click(button);
  const define = screen.queryByRole("dialog", { name: /credential/i });
  if (define)
    await user.click(
      within(define).getByRole("button", { name: /^(Create|Add|Save)/ }),
    );
  const dialog = await screen.findByRole("dialog", { name: /^Connect/ });
  await user.type(within(dialog).getByLabelText(/Value/i), value);
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

function definition(
  overrides: Partial<Definition> & Pick<Definition, "id" | "key" | "name">,
): Definition {
  return {
    kind: "secret",
    description: "",
    icon: null,
    builtIn: false,
    allowPersonal: false,
    allowOrganization: true,
    personalConfigured: false,
    organizationConfigured: true,
    ...overrides,
  };
}
