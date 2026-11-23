import { archestraApiClient } from "@archestra/shared";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
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
import type { AgentRuntimeAccount } from "@/lib/agent-runtime-account.query";
import { makeSession } from "@/mocks/data/auth";
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import { AgentRuntimeCredentialPrompt } from "./agent-run-credential-prompt";
import { AgentRuntimeAccountRow } from "./agent-runtime-account-row";
import { AgentRuntimeCredentialsDialog } from "./agent-runtime-credentials-dialog";

vi.mock("sonner");
vi.mock("next/navigation");
const origin = "http://localhost:9000";
const agentId = "agent-1";
const server = setupServer();
let account: AgentRuntimeAccount;
let permissions: Record<string, string[]>;
let writes: Array<{ method: string; body: unknown }>;
let queryClient: QueryClient;

const openAiRuntime = {
  command: ["archestra-opencode"],
  inferenceProtocol: "openai_chat" as const,
};

/**
 * The viewer's ChatGPT subscription as the account reports it: connected
 * means they have a key of their own for it.
 */
const chatgpt = (params: {
  connected: boolean;
}): NonNullable<AgentRuntimeAccount["subscription"]> => ({
  kind: "chatgpt",
  label: "ChatGPT",
  connected: params.connected,
  keyId: params.connected ? "my-chatgpt-key" : null,
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  server.resetHandlers();
  queryClient.clear();
});
beforeEach(() => {
  writes = [];
  mappedVirtualKeys = [];
  declarations = [];
  preflight = {
    ready: true,
    configured: [],
    missing: [],
    misconfigured: [],
    incompatible: null,
    accountError: null,
    accountErrorFromChoice: false,
    accountErrorFromModel: false,
    accountErrorFromConnection: false,
    missingSubscription: null,
  };
  permissions = { llmProviderApiKey: ["read"] };
  account = {
    agentAccount: {
      authentication: "provider",
      llmApiKeyId: "agent-key",
      modelId: "model-agent",
    },
    companyKey: true,
    companyAccount: setByAgent(),
    choice: null,
    choiceError: null,
    lock: null,
    subscription: chatgpt({ connected: true }),
  };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["auth", "session"], makeSession());
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get("http://localhost:3000/api/auth/get-session", () =>
      HttpResponse.json(makeSession()),
    ),
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(permissions),
    ),
    http.get(`${origin}/api/organization`, () => HttpResponse.json({})),
    http.get(`${origin}/api/agents/${agentId}/runtime/account`, () =>
      HttpResponse.json(account),
    ),
    http.put(
      `${origin}/api/agents/${agentId}/runtime/account`,
      async ({ request }) => {
        const body = (await request.json()) as {
          authentication: "provider" | "subscription";
          llmApiKeyId?: string | null;
          modelId?: string | null;
          claudeModel?: string;
        };
        writes.push({ method: "PUT", body });
        const company = account.companyAccount;
        const provider = body.authentication === "provider";
        // As the API does: a choice that names a part set above the person
        // is refused, even by the value that part already has.
        const namesFixedPart =
          provider &&
          ((!!body.llmApiKeyId && company.connection.fixedBy) ||
            (!!body.modelId && company.model.fixedBy));
        if (namesFixedPart) {
          return HttpResponse.json(
            {
              error: {
                message: `This agent sets the ${body.llmApiKeyId && company.connection.fixedBy ? "connection" : "model"} of its company API key, so you cannot choose another.`,
                type: "api_conflict_error",
              },
            },
            { status: 409 },
          );
        }
        // A choice is stored whole: what it leaves out is stored as none.
        const llmApiKeyId = body.llmApiKeyId ?? null;
        const modelId = body.modelId ?? null;
        account = {
          ...account,
          choice: {
            authentication: body.authentication,
            llmApiKeyId,
            modelId,
            claudeModel: body.claudeModel ?? null,
          },
          // With a pick of theirs, the parts left to them resolve to it.
          // With none, what resolved without one still does.
          ...(provider &&
            (llmApiKeyId || modelId) && {
              companyAccount: {
                ...company,
                connection: company.connection.fixedBy
                  ? company.connection
                  : {
                      ...company.connection,
                      id: llmApiKeyId,
                      name: llmApiKeyId ? "Company OpenAI" : null,
                      provider: llmApiKeyId ? "openai" : null,
                    },
                model: company.model.fixedBy
                  ? company.model
                  : {
                      ...company.model,
                      id: modelId,
                      name: modelId ? "GPT-5" : null,
                    },
                usesOrganizationDefault: false,
              },
            }),
        };
        return HttpResponse.json(account);
      },
    ),
    http.get(
      `${origin}/api/agents/${agentId}/runtime/claude-code/account`,
      () => HttpResponse.json({ state: "disconnected" }),
    ),
    http.get(`${origin}/api/agents/${agentId}/runtime/preflight`, () =>
      HttpResponse.json(preflight),
    ),
    http.get(`${origin}/api/agents/${agentId}`, () =>
      HttpResponse.json({ id: agentId, runtime: openAiRuntime }),
    ),
    http.get(`${origin}/api/credentials`, () => HttpResponse.json([])),
    http.get(`${origin}/api/config`, () => HttpResponse.json({ features: {} })),
    http.delete(`${origin}/api/agents/${agentId}/runtime/account`, () => {
      writes.push({ method: "DELETE", body: null });
      account = { ...account, choice: null };
      return HttpResponse.json(account);
    }),
    // What goes with the viewer's subscription key when it is disconnected.
    http.get(`${origin}/api/llm-virtual-keys`, () =>
      HttpResponse.json({ ...emptyPage, data: mappedVirtualKeys }),
    ),
    http.get(`${origin}/api/oauth-clients`, () => HttpResponse.json(emptyPage)),
    // The models of the viewer's own subscription key, for the card's picker.
    http.get(`${origin}/api/llm-models/available`, () =>
      HttpResponse.json(subscriptionModels),
    ),
    // The connections the viewer can list: none, unless a test gives some.
    http.get(`${origin}/api/llm-provider-api-keys/available`, () =>
      HttpResponse.json([]),
    ),
  );
});

const emptyPage = {
  data: [],
  pagination: {
    currentPage: 1,
    limit: 100,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};
/** Virtual keys that map the viewer's subscription key. */
let mappedVirtualKeys: unknown[] = [];

const subscriptionModels = [
  {
    dbId: "model-gpt-4o",
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openai",
    isFree: false,
  },
  {
    dbId: "model-codex",
    id: "gpt-5.3-codex",
    displayName: "Codex",
    provider: "openai",
    isFree: false,
  },
];

let declarations: Parameters<
  typeof AgentRuntimeCredentialsDialog
>[0]["declarations"] = [];
let preflight: Record<string, unknown>;

/** The real setup dialog, opened for the viewer's account. */
function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentRuntimeCredentialsDialog
        agentId={agentId}
        declarations={declarations}
        canEditAgent={false}
        forAccount
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

/**
 * An agent whose own setting is each person's subscription. It sets a company
 * connection and model too: while those work (`companyKey`), people may
 * choose them instead. Once they do not, no part of the company option is
 * left to the person, so there is none to choose.
 */
function subscriptionDefault(params: { companyKey: boolean }) {
  account.agentAccount = {
    authentication: "subscription",
    llmApiKeyId: params.companyKey ? "agent-key" : null,
    modelId: params.companyKey ? "model-agent" : null,
  };
  account.companyKey = params.companyKey;
  account.companyAccount = params.companyKey ? setByAgent() : setAndBroken();
}

/** The company option where the agent sets its connection and its model. */
function setByAgent(): AgentRuntimeAccount["companyAccount"] {
  return {
    connection: {
      id: "agent-key",
      name: "Agent key",
      provider: "openai",
      fixedBy: "agent",
    },
    model: { id: "model-agent", name: "Agent model", fixedBy: "agent" },
    usesOrganizationDefault: false,
  };
}

/** The same once what the agent sets is gone: nothing resolves for anyone. */
function setAndBroken(): AgentRuntimeAccount["companyAccount"] {
  return {
    connection: { id: null, name: null, provider: null, fixedBy: "agent" },
    model: { id: null, name: null, fixedBy: "agent" },
    usesOrganizationDefault: false,
  };
}

/**
 * The company option as the person's runs resolve it. Unless said, nothing
 * is fixed above them and nothing resolves: both parts are theirs to pick.
 */
function companyAccount(
  parts: Partial<AgentRuntimeAccount["companyAccount"]> = {},
): AgentRuntimeAccount["companyAccount"] {
  return {
    connection: { id: null, name: null, provider: null, fixedBy: null },
    model: { id: null, name: null, fixedBy: null },
    usesOrganizationDefault: false,
    ...parts,
  };
}

/**
 * An agent on the company API key that sets no connection or model for it:
 * both are each person's to pick. `companyKey` follows what resolves.
 */
function leftToPerson(parts: Parameters<typeof companyAccount>[0] = {}) {
  account.agentAccount = {
    authentication: "provider",
    llmApiKeyId: null,
    modelId: null,
  };
  account.companyAccount = companyAccount(parts);
  account.companyKey =
    !!account.companyAccount.connection.id && !!account.companyAccount.model.id;
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

const choices = () =>
  screen.findByRole("radiogroup", { name: "What your runs use" });
const okPreflight = {
  ready: true,
  configured: [],
  missing: [],
  misconfigured: [],
  incompatible: null,
  accountError: null,
  accountErrorFromChoice: false,
  accountErrorFromModel: false,
  accountErrorFromConnection: false,
  missingSubscription: null,
};

describe("a person's account for an agent", () => {
  it("starts on the agent's company key as its default, with nothing more to pick and no Save", async () => {
    show();
    const group = await choices();
    const company = within(group).getByRole("radio", {
      name: /^A company API key/,
    });
    expect(company).toBeChecked();
    expect(company.closest("label")).toHaveTextContent("Agent default");
    expect(company.closest("label")).toHaveTextContent(
      "The agent's connection and model. Billed to the company.",
    );
    expect(
      within(group)
        .getByRole("radio", { name: /My ChatGPT/ })
        .closest("label"),
    ).not.toHaveTextContent("Agent default");
    // The two options are the whole choice: no connection or model to pick.
    const region = screen.getByRole("region", { name: "Account" });
    expect(within(region).getAllByRole("radio")).toHaveLength(2);
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(within(region).queryAllByRole("combobox")).toHaveLength(0);
    expect(
      screen.getByText(
        "Your runs use this account. It is the agent's default.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("saves a subscription, then shows it as in effect", async () => {
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.click(saveButton());

    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "subscription" } },
      ]),
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Your account is saved",
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /My ChatGPT/ })).toHaveFocus(),
    );
    expect(screen.getByText("Your runs use this account.")).toBeInTheDocument();
  });

  it("stores the company key as the way alone, with no key or model, where the agent's default is the subscription", async () => {
    subscriptionDefault({ companyKey: true });
    const user = userEvent.setup();
    show();
    const group = await choices();
    const company = within(group).getByRole("radio", {
      name: /^A company API key/,
    });
    expect(company).not.toBeChecked();
    expect(company.closest("label")).not.toHaveTextContent("Agent default");
    await user.click(company);
    await user.click(saveButton());

    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "provider" } },
      ]),
    );
    expect(
      await screen.findByText("Your runs use this account."),
    ).toBeInTheDocument();
  });

  it("offers the Claude sign-in under a Claude subscription that is not connected", async () => {
    account.subscription = {
      kind: "claude",
      label: "Claude subscription",
      connected: false,
      // Claude keeps an account of its own, not a provider key.
      keyId: null,
    };
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(
      within(group).getByRole("radio", { name: /My Claude subscription/ }),
    );
    expect(
      await screen.findByRole("button", { name: /Sign in/ }),
    ).toBeInTheDocument();

    // The company key needs nothing from the person.
    await user.click(
      within(group).getByRole("radio", { name: /^A company API key/ }),
    );
    expect(
      screen.queryByRole("button", { name: /Sign in/ }),
    ).not.toBeInTheDocument();
  });

  it("returns to the agent's default with DELETE, never a PUT of the default", async () => {
    account.choice = {
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    const user = userEvent.setup();
    show();
    const group = await choices();
    expect(screen.getByText("Your runs use this account.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(group).getByRole("radio", { name: /^A company API key/ }),
    );
    await user.click(saveButton());

    await waitFor(() =>
      expect(writes).toEqual([{ method: "DELETE", body: null }]),
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Your runs use the agent's default",
    );
  });

  it("starts an agent on each person's subscription on that subscription", async () => {
    subscriptionDefault({ companyKey: true });
    const user = userEvent.setup();
    show();
    const group = await choices();
    const subscription = within(group).getByRole("radio", {
      name: /My ChatGPT/,
    });
    expect(subscription).toBeChecked();
    expect(subscription.closest("label")).toHaveTextContent("Agent default");
    expect(
      screen.getByText(
        "Your runs use this account. It is the agent's default.",
      ),
    ).toBeInTheDocument();

    // The other way is ready to save as soon as it is selected.
    await user.click(
      within(group).getByRole("radio", { name: /^A company API key/ }),
    );
    expect(saveButton()).toBeEnabled();
    await user.click(subscription);
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("shows the sign-in, not the in-effect status, until the default subscription is connected", async () => {
    subscriptionDefault({ companyKey: false });
    account.subscription = chatgpt({ connected: false });
    show();
    await choices();

    expect(screen.getByRole("link", { name: "Connect ChatGPT" })).toBeVisible();
    expect(
      screen.queryByText(/^Your runs use this account/),
    ).not.toBeInTheDocument();

    account.subscription = chatgpt({ connected: true });
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(
      await screen.findByText(
        "Your runs use this account. It is the agent's default.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Connect ChatGPT" }),
    ).not.toBeInTheDocument();
    focusManager.setFocused(undefined);
  });

  it("starts on the company API key where the agent sets none of its parts, and says where they are picked", async () => {
    // Nothing resolves until the person picks: the option is theirs all the
    // same, and it is what the agent's own setting gives them.
    leftToPerson();
    show();
    const group = await choices();

    const company = within(group).getByRole("radio", {
      name: /^A company API key/,
    });
    expect(company).toBeChecked();
    expect(company.closest("label")).toHaveTextContent("Agent default");
    expect(company.closest("label")).toHaveTextContent(
      "A connection and model you pick on the agent's page. Billed to the company.",
    );
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("offers nothing as in effect where what is set for the company API key no longer works", async () => {
    // Every part is set above the person, so none is theirs to pick.
    account.companyKey = false;
    account.companyAccount = setAndBroken();
    show();
    const group = await choices();

    expect(screen.queryByText("Agent default")).not.toBeInTheDocument();
    for (const radio of within(group).getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByText("Choose an account")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("shows the message and starts again from what is stored when saving fails", async () => {
    let reads = 0;
    server.use(
      http.get(`${origin}/api/agents/${agentId}/runtime/account`, () => {
        reads += 1;
        return HttpResponse.json(account);
      }),
      http.put(`${origin}/api/agents/${agentId}/runtime/account`, () =>
        HttpResponse.json(
          {
            error: {
              message:
                "This agent is locked to a company API key, so you cannot choose a personal subscription for it.",
              type: "api_conflict_error",
            },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.click(saveButton());

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "This agent is locked to a company API key, so you cannot choose a personal subscription for it.",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it("refreshes the subscription's sign-in when the window regains focus", async () => {
    account.subscription = chatgpt({ connected: false });
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    expect(screen.getByRole("link", { name: "Connect ChatGPT" })).toBeVisible();

    account.subscription = chatgpt({ connected: true });
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(
      await screen.findByText("Runs use your own plan. Nobody else uses it."),
    ).toBeInTheDocument();
    focusManager.setFocused(undefined);
  });

  it.each([
    {
      lock: "key",
      setAside: "subscription",
      line: "This agent runs only on a company API key.",
    },
    {
      lock: "subscription",
      setAside: "provider",
      line: "This agent runs only on each person's own subscription.",
    },
  ] as const)("replaces the form with one line under the $lock lock, whatever the person chose before", async ({
    lock,
    setAside,
    line,
  }) => {
    account.lock = lock;
    account.choice = {
      authentication: setAside,
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    account.choiceError =
      "This agent is locked, so your own choice is not used.";
    show();

    expect(await screen.findByText("Account locked")).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/so your own choice is not used/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("follows a lock that arrives while the choice is open", async () => {
    show();
    await choices();
    account.lock = "key";
    await queryClient.invalidateQueries({
      queryKey: ["agents", agentId, "runtime", "account"],
    });

    expect(
      await screen.findByText("This agent runs only on a company API key."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("keeps a stored company key that no longer works on offer, asks to choose again, and lets the default be saved", async () => {
    // The agent lost its company key after the person chose it.
    subscriptionDefault({ companyKey: false });
    account.choice = {
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    account.choiceError =
      "Your own account for this agent no longer works. The agent no longer has a company API key and model of its own. Choose your account again.";
    const user = userEvent.setup();
    show();

    const group = await choices();
    expect(screen.getByText("Choose again")).toBeInTheDocument();
    expect(
      screen.getByText(/no longer has a company API key and model of its own/),
    ).toBeInTheDocument();
    // The broken choice is what is shown, not as in effect.
    expect(
      within(group).getByRole("radio", { name: /^A company API key/ }),
    ).toBeChecked();
    expect(
      screen.queryByText(/^Your runs use this account/),
    ).not.toBeInTheDocument();

    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.click(saveButton());
    await waitFor(() =>
      expect(writes).toEqual([{ method: "DELETE", body: null }]),
    );
    expect(
      await screen.findByText(
        "Your runs use this account. It is the agent's default.",
      ),
    ).toBeInTheDocument();
    // Once it is no longer their choice, the company key is not offered.
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("offers the sign-in when the person's subscription is not connected", async () => {
    account.subscription = chatgpt({ connected: false });
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));

    expect(
      screen.getByRole("link", { name: "Connect ChatGPT" }),
    ).toHaveAttribute("href", "/llm/model-providers?connect=chatgpt");
  });

  it("offers no subscription where the runtime has none", async () => {
    account.subscription = null;
    show();
    const group = await choices();

    await within(group).findByRole("radio", { name: /^A company API key/ });
    expect(within(group).getAllByRole("radio")).toHaveLength(1);
    expect(
      within(group).queryByRole("radio", { name: /^My / }),
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      open: "both",
      description:
        "A connection and model you pick on the agent's page. Billed to the company.",
    },
    {
      open: "model",
      description:
        "The agent's connection, with a model you pick on its page. Billed to the company.",
    },
    {
      open: "nothing",
      description: "The agent's connection and model. Billed to the company.",
    },
  ] as const)("says what the company API key runs on where $open is left to the person", async ({
    open,
    description,
  }) => {
    account.companyAccount = companyAccount({
      connection: {
        id: open === "both" ? null : "agent-key",
        name: open === "both" ? null : "Agent key",
        provider: open === "both" ? null : "openai",
        fixedBy: open === "both" ? null : "agent",
      },
      model: {
        id: open === "nothing" ? "model-agent" : null,
        name: open === "nothing" ? "Agent model" : null,
        fixedBy: open === "nothing" ? "runtime" : null,
      },
    });
    show();

    expect(within(await choices()).getByText(description)).toBeInTheDocument();
  });

  it("offers the company API key where its parts are the person's to pick, and stores the way alone", async () => {
    // The agent runs on subscriptions and sets nothing for the company API
    // key. Nothing resolves for it yet: the person picks on the agent's page.
    subscriptionDefault({ companyKey: false });
    account.companyAccount = companyAccount();
    const user = userEvent.setup();
    show();

    const company = within(await choices()).getByRole("radio", {
      name: /A company API key/,
    });
    expect(company.closest("label")).toHaveTextContent(
      "A connection and model you pick on the agent's page. Billed to the company.",
    );
    await user.click(company);
    await user.click(saveButton());
    // A choice is stored whole, so the way is all that is named.
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "provider" } },
      ]),
    );
  });

  it("stores a company API key that no longer works again with nothing picked, so it resolves afresh", async () => {
    // Their own connection was deleted: the parts left to them read as none.
    subscriptionDefault({ companyKey: false });
    account.companyAccount = companyAccount();
    account.choice = {
      authentication: "provider",
      llmApiKeyId: "gone-key",
      modelId: "gone-model",
      claudeModel: null,
    };
    account.choiceError =
      "Your own account for this agent no longer works. The connection you chose no longer exists. Choose your account again.";
    const user = userEvent.setup();
    show();

    expect(await screen.findByText("Choose again")).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "provider" } },
      ]),
    );
  });

  it("offers only the subscription where what is set for the company API key no longer works and none is stored", async () => {
    subscriptionDefault({ companyKey: false });
    show();
    const group = await choices();

    expect(within(group).getAllByRole("radio")).toHaveLength(1);
    expect(
      within(group).getByRole("radio", { name: /My ChatGPT/ }),
    ).toBeChecked();
    expect(
      within(group).queryByRole("radio", { name: /^A company API key/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the setup dialog's one set of buttons", () => {
  // The company key, chosen on an agent whose default is the subscription.
  const storedKeyChoice = () => {
    subscriptionDefault({ companyKey: true });
    account.choice = {
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
  };

  it("offers only Done while the stored choice is unchanged", async () => {
    storedKeyChoice();
    show();
    await choices();

    expect(
      await screen.findByText("Your runs use this account."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save account" }),
    ).not.toBeInTheDocument();
  });

  it("offers Cancel and Save once the option changes, and only Done again once it is saved", async () => {
    storedKeyChoice();
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() =>
      expect(writes).toEqual([{ method: "DELETE", body: null }]),
    );
    expect(
      await screen.findByRole("button", { name: "Done" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save account" }),
    ).not.toBeInTheDocument();
  });

  it("saves an account change and a missing credential with one Save", async () => {
    const token = {
      key: "API_TOKEN",
      scope: "per_user" as const,
      label: "API token",
      required: true,
    };
    declarations = [token];
    preflight = { ...preflight, ready: false, missing: [token] };
    permissions = { ...permissions, credential: ["read"] };
    const credentialWrites: string[] = [];
    server.use(
      http.put(
        `${origin}/api/agents/${agentId}/runtime/credentials/:key`,
        ({ params }) => {
          credentialWrites.push(String(params.key));
          return HttpResponse.json({ configured: true });
        },
      ),
    );
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.type(await screen.findByLabelText("API token"), "secret");
    await user.click(saveButton());

    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "subscription" } },
      ]),
    );
    await waitFor(() => expect(credentialWrites).toEqual(["API_TOKEN"]));
  });

  it("keeps the selection and shows the message when the account save fails", async () => {
    server.use(
      http.put(`${origin}/api/agents/${agentId}/runtime/account`, () =>
        HttpResponse.json(
          {
            error: {
              message:
                "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
              type: "api_validation_error",
            },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.click(saveButton());

    const region = screen.getByRole("region", { name: "Account" });
    expect(
      await within(region).findByText(
        "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
      ),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("radio", { name: /My ChatGPT/ }),
    ).toBeChecked();
    expect(saveButton()).toBeInTheDocument();
  });

  it("asks before closing with an unsaved account change", async () => {
    const user = userEvent.setup();
    show();
    const group = await choices();
    await user.click(within(group).getByRole("radio", { name: /My ChatGPT/ }));
    await user.keyboard("{Escape}");

    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
  });
});

describe("the composer prompt for an account that cannot run", () => {
  const prompt = (props: {
    accountError: string;
    accountErrorFromChoice: boolean;
  }) => {
    server.use(
      http.get(`${origin}/api/agents/${agentId}/runtime/preflight`, () =>
        HttpResponse.json({ ...okPreflight, ready: false, ...props }),
      ),
      http.get(`${origin}/api/agents/${agentId}`, () =>
        HttpResponse.json({ id: agentId, runtime: openAiRuntime }),
      ),
      http.get(`${origin}/api/credentials`, () => HttpResponse.json([])),
      http.get(`${origin}/api/config`, () =>
        HttpResponse.json({ features: {} }),
      ),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <AgentRuntimeCredentialPrompt
          agentId={agentId}
          missing={[]}
          declarations={[]}
          {...props}
          onConnected={() => {}}
        />
      </QueryClientProvider>,
    );
  };

  it("names a broken choice and opens the account choice", async () => {
    const user = userEvent.setup();
    prompt({
      accountError:
        "Your own account for this agent no longer works. Its API key was removed. Choose your account again.",
      accountErrorFromChoice: true,
    });

    expect(
      screen.getByText("Your account for this agent no longer works"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Its API key was removed\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose account" }));

    expect(await choices()).toBeInTheDocument();
  });

  it("offers no choice for a problem with the agent's own account or lock", () => {
    prompt({
      accountError:
        "This agent is locked to each person's own subscription, but gemini-2.5-pro has none. Someone who can configure its runtime must change its model or its lock.",
      accountErrorFromChoice: false,
    });

    expect(
      screen.getByText("This agent's account cannot run"),
    ).toBeInTheDocument();
    expect(screen.getByText(/must change its model or its lock/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Choose account" }),
    ).not.toBeInTheDocument();
  });
});

describe("the composer prompt for a model their subscription does not offer", () => {
  it("leads to the agent's page, where they pick their own model", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AgentRuntimeCredentialPrompt
          agentId={agentId}
          missing={[]}
          declarations={[]}
          accountError="This agent's model is not available through your ChatGPT subscription. Choose a model on the agent's page."
          accountErrorFromModel
          onConnected={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Choose a model to run this agent")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open agent" })).toHaveAttribute(
      "href",
      `/agents/${agentId}`,
    );
    // Choosing the account again would not fix it, so it is not offered.
    expect(
      screen.queryByRole("button", { name: "Choose account" }),
    ).not.toBeInTheDocument();
  });
});

describe("the composer prompt for a connection that is left to the person", () => {
  it("leads to the agent's page, where they pick their connection", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AgentRuntimeCredentialPrompt
          agentId={agentId}
          missing={[]}
          declarations={[]}
          accountError="This agent leaves the connection to each person. Choose one on the agent's page."
          accountErrorFromConnection
          onConnected={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText("Choose a connection to run this agent"),
    ).toBeVisible();
    expect(screen.getByText(/Choose one on the agent's page\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open agent" })).toHaveAttribute(
      "href",
      `/agents/${agentId}`,
    );
    // Choosing the account again would not fix it, so it is not offered.
    expect(
      screen.queryByRole("button", { name: "Choose account" }),
    ).not.toBeInTheDocument();
  });
});

describe("the composer prompt for a subscription that is not signed in", () => {
  it("offers the sign-in in place, in a dialog on the same page", async () => {
    server.use(
      http.get(`${origin}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([]),
      ),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <AgentRuntimeCredentialPrompt
          agentId={agentId}
          missing={[]}
          declarations={[]}
          accountError="Connect your ChatGPT subscription to run this agent."
          accountErrorFromChoice={false}
          missingSubscription="chatgpt"
          onConnected={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Sign in to run this agent")).toBeVisible();
    expect(
      screen.getByText("Connect your ChatGPT subscription to run this agent."),
    ).toBeVisible();
    // Not a dead end, and not the wording for an agent that cannot run.
    expect(
      screen.queryByText("This agent's account cannot run"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("dialog", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();
  });
});

describe("the account row on an agent's page", () => {
  /** The buttons a person can press. */
  const enabledButtons = () =>
    screen
      .queryAllByRole("button")
      .filter((button) => !(button as HTMLButtonElement).disabled);
  const renderRow = (
    props: Partial<Parameters<typeof AgentRuntimeAccountRow>[0]> = {},
  ) =>
    render(
      <QueryClientProvider client={queryClient}>
        <AgentRuntimeAccountRow
          agentId={agentId}
          runtime={openAiRuntime}
          declarations={declarations}
          canEditAgent={false}
          {...props}
        />
      </QueryClientProvider>,
    );

  /** A stored choice that stopped working: the row offers "Choose account". */
  const brokenChoice = () => {
    subscriptionDefault({ companyKey: false });
    account.choice = {
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    account.choiceError =
      "Your own account for this agent no longer works. The agent no longer has a company API key and model of its own. Choose your account again.";
  };

  it("says the runs are on a company API key and switches to the personal subscription in one click", async () => {
    const user = userEvent.setup();
    renderRow();

    expect(
      await screen.findByText("Uses company's API key"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Use personal subscription instead" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "subscription" } },
      ]),
    );
    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    // Their choice is now the subscription, so the agent's key is the other way.
    expect(
      screen.getByRole("button", { name: "Use API key instead" }),
    ).toBeVisible();
  });

  it("goes back to the agent's own connection by dropping the person's choice", async () => {
    account.choice = {
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    const user = userEvent.setup();
    renderRow();

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Use API key instead" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([{ method: "DELETE", body: null }]),
    );
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
  });

  it("keeps a way back from a chosen subscription when the agent runs on the organization's default or its key stopped qualifying", async () => {
    // No connection of its own: the default is the organization's model.
    leftToPerson({
      connection: {
        id: "org-default-key",
        name: "Organization OpenAI",
        provider: "openai",
        fixedBy: null,
      },
      model: { id: "org-default-model", name: "GPT-5", fixedBy: null },
      usesOrganizationDefault: true,
    });
    account.choice = {
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    const user = userEvent.setup();
    const { unmount } = renderRow();

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Use API key instead" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([{ method: "DELETE", body: null }]),
    );
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    unmount();

    // Its own key, which no longer qualifies as a company key to choose.
    account.agentAccount = {
      authentication: "provider",
      llmApiKeyId: "agent-key",
      modelId: "model-agent",
    };
    account.companyKey = false;
    account.companyAccount = setAndBroken();
    account.choice = {
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    renderRow();
    expect(
      await screen.findByRole("button", { name: "Use API key instead" }),
    ).toBeVisible();
  });

  it("stores the company API key in one click where the agent's default is the subscription, and drops it to go back", async () => {
    subscriptionDefault({ companyKey: true });
    const user = userEvent.setup();
    renderRow();

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Use API key instead" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "provider" } },
      ]),
    );
    // Their runs are on the agent's connection now; nothing asked them more.
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Use personal subscription instead" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", body: { authentication: "provider" } },
        { method: "DELETE", body: null },
      ]),
    );
    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
  });

  it("offers no other way when the agent's own way is the only one open to the person", async () => {
    subscriptionDefault({ companyKey: false });
    renderRow();

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /instead$/ }),
    ).not.toBeInTheDocument();
  });

  /** The viewer's Claude account as the card's own controls read it. */
  const claudeAccount = (state: "connected" | "disconnected") => {
    account.subscription = {
      kind: "claude",
      label: "Claude subscription",
      connected: state === "connected",
      keyId: null,
    };
    server.use(
      http.get(
        `${origin}/api/agents/${agentId}/runtime/claude-code/account`,
        () => HttpResponse.json({ state }),
      ),
      http.get(
        `${origin}/api/agents/${agentId}/runtime/claude-code/models`,
        () =>
          HttpResponse.json({
            models: [
              { value: "opus", displayName: "Opus", description: "" },
              { value: "sonnet", displayName: "Sonnet", description: "" },
            ],
          }),
      ),
    );
  };

  it("offers the Claude sign-in while the subscription is not connected, and nothing of it on the company key", async () => {
    subscriptionDefault({ companyKey: true });
    claudeAccount("disconnected");
    const user = userEvent.setup();
    renderRow();

    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeVisible();
    // No model to pick, and nothing to disconnect, before the account that
    // offers them is connected.
    expect(
      screen.queryByRole("button", { name: /^Model / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
    // Switching away shows at once: the sign-in goes with the line.
    await user.click(
      screen.getByRole("button", { name: "Use API key instead" }),
    );
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
  });

  it("shows a connected Claude subscription with its model picker and disconnects it in one click", async () => {
    subscriptionDefault({ companyKey: false });
    claudeAccount("connected");
    const user = userEvent.setup();
    renderRow({
      runtime: {
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
      },
      agentClaudeModel: "sonnet",
    });

    // The agent's model until the person picks their own.
    await user.click(
      await screen.findByRole("button", { name: "Model Sonnet" }),
    );
    // Signed in already: the card only offers to disconnect.
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Opus/ }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: "PUT",
          body: { authentication: "subscription", claudeModel: "opus" },
        },
      ]),
    );
    expect(
      await screen.findByRole("button", { name: "Model Opus" }),
    ).toBeVisible();

    // One click disconnects: no dialog asks again.
    let disconnects = 0;
    server.use(
      http.delete(
        `${origin}/api/agents/${agentId}/runtime/claude-code/account`,
        () => {
          disconnects += 1;
          claudeAccount("disconnected");
          return HttpResponse.json({ state: "disconnected" });
        },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeVisible();
    expect(disconnects).toBe(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The models went with the account that offered them.
    expect(
      screen.queryByRole("button", { name: /^Model / }),
    ).not.toBeInTheDocument();
  });

  it("shows a connected subscription other than Claude's with the models of its key the runtime can run, and disconnects it in one click", async () => {
    subscriptionDefault({ companyKey: false });
    const modelRequests: Array<string | null> = [];
    const deletedKeys: string[] = [];
    server.use(
      http.get(`${origin}/api/llm-models/available`, ({ request }) => {
        modelRequests.push(new URL(request.url).searchParams.get("apiKeyId"));
        return HttpResponse.json(subscriptionModels);
      }),
      http.delete(`${origin}/api/llm-provider-api-keys/:id`, ({ params }) => {
        deletedKeys.push(String(params.id));
        account = { ...account, subscription: chatgpt({ connected: false }) };
        return HttpResponse.json({ success: true });
      }),
    );
    const user = userEvent.setup();
    renderRow({
      runtime: {
        command: ["archestra-codex"],
        inferenceProtocol: "openai_chat",
      },
    });

    // Nobody picked a model yet, and the agent sets none for subscriptions.
    await user.click(
      await screen.findByRole("button", { name: "Model Select a model" }),
    );
    expect(modelRequests).toContain("my-chatgpt-key");
    // A Chat Completions runtime cannot run a model that needs Responses.
    expect(await screen.findByRole("option", { name: /GPT-4o/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Codex/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /GPT-4o/ }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: "PUT",
          body: { authentication: "subscription", modelId: "model-gpt-4o" },
        },
      ]),
    );
    expect(
      await screen.findByRole("button", { name: "Model GPT-4o" }),
    ).toBeVisible();
    // Their sign-in is managed here: nothing sends them to another page.
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    // One click disconnects: the key is theirs alone, so no dialog asks.
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeVisible();
    expect(deletedKeys).toEqual(["my-chatgpt-key"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The models went with the key that offered them.
    expect(
      screen.queryByRole("button", { name: /^Model / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
  });

  it("signs a person in to a subscription that is not connected in a dialog on the agent's page", async () => {
    subscriptionDefault({ companyKey: true });
    account.subscription = chatgpt({ connected: false });
    server.use(
      http.get(`${origin}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([]),
      ),
    );
    const user = userEvent.setup();
    renderRow({
      runtime: {
        command: ["archestra-codex"],
        inferenceProtocol: "openai_chat",
      },
    });

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeVisible();
    // Nothing to pick or disconnect before they have a key of their own.
    expect(
      screen.queryByRole("button", { name: /^Model / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
    // A button, not a link to the model providers page.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("dialog", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();

    // Leaving the subscription takes its sign-in along.
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Use API key instead" }),
    );
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
  });

  describe("on a personal subscription, the controls follow the line in one order", () => {
    /** Each element comes after the one before it, as the card reads. */
    const expectInOrder = (...elements: HTMLElement[]) => {
      for (const [index, element] of elements.entries()) {
        if (index === 0) continue;
        expect(
          elements[index - 1].compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    };
    const line = () => screen.findByText("Uses your personal subscription");
    const switchWay = () =>
      screen.getByRole("button", { name: "Use API key instead" });

    it("the disconnect, then the model, then the way out of it, once signed in", async () => {
      subscriptionDefault({ companyKey: true });
      renderRow({
        runtime: {
          command: ["archestra-codex"],
          inferenceProtocol: "openai_chat",
        },
      });

      const model = await screen.findByRole("button", { name: /^Model / });
      expectInOrder(
        await line(),
        screen.getByRole("button", { name: "Disconnect" }),
        model,
        switchWay(),
      );
    });

    it("the sign-in, then the way out of it, until then", async () => {
      subscriptionDefault({ companyKey: true });
      account.subscription = chatgpt({ connected: false });
      renderRow({
        runtime: {
          command: ["archestra-codex"],
          inferenceProtocol: "openai_chat",
        },
      });

      expectInOrder(
        await line(),
        await screen.findByRole("button", { name: "Sign in" }),
        switchWay(),
      );
      expect(
        screen.queryByRole("button", { name: /^Model / }),
      ).not.toBeInTheDocument();
    });

    it("the same on a Claude subscription", async () => {
      subscriptionDefault({ companyKey: true });
      claudeAccount("connected");
      renderRow({
        runtime: {
          command: ["archestra-claude-code"],
          inferenceProtocol: "anthropic",
        },
        agentClaudeModel: "sonnet",
      });

      const model = await screen.findByRole("button", { name: "Model Sonnet" });
      expectInOrder(
        await line(),
        screen.getByRole("button", { name: "Disconnect" }),
        model,
        switchWay(),
      );
    });
  });

  describe("credentials beside the account", () => {
    let credentialReads: number;
    const openDialog = async (credentials: () => Response) => {
      credentialReads = 0;
      server.use(
        http.get(`${origin}/api/credentials`, () => {
          credentialReads += 1;
          return credentials();
        }),
      );
      brokenChoice();
      const user = userEvent.setup();
      renderRow();
      await user.click(
        await screen.findByRole("button", { name: "Choose account" }),
      );
      await choices();
    };
    const serverError = () =>
      HttpResponse.json(
        {
          error: { message: "Unavailable", type: "api_internal_server_error" },
        },
        { status: 500 },
      );

    it("leave the credentials out for a person who may not read them", async () => {
      await openDialog(serverError);

      // Opened on the choice that no longer works, which is still to be replaced.
      expect(
        await screen.findByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Could not load runtime credentials"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/All required credentials are configured/),
      ).not.toBeInTheDocument();
      expect(credentialReads).toBe(0);
    });

    it("keep the error with Retry when a person who may read them cannot load them", async () => {
      permissions = { ...permissions, credential: ["read"] };
      await openDialog(serverError);

      expect(
        await screen.findByText("Could not load runtime credentials"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    });
  });

  it("keeps the account reachable when the agent's only missing setup is one GitHub sign-in", async () => {
    const github = {
      key: "GITHUB_TOKEN",
      credentialId: "github",
      scope: "per_user" as const,
      label: "GitHub",
      required: true,
    };
    server.use(
      http.get(`${origin}/api/agents/${agentId}/runtime/preflight`, () =>
        HttpResponse.json({ ...okPreflight, ready: false, missing: [github] }),
      ),
      http.get(`${origin}/api/credentials`, () =>
        HttpResponse.json([
          {
            key: "github",
            name: "GitHub",
            description: "Repository access",
            kind: "github_app_user",
            allowPersonal: true,
          },
        ]),
      ),
    );
    declarations = [github];
    brokenChoice();
    const user = userEvent.setup();
    renderRow();
    await user.click(
      await screen.findByRole("button", { name: "Choose account" }),
    );

    expect(await choices()).toBeInTheDocument();
  });

  it("asks before disconnecting a subscription that a virtual key depends on, and deletes nothing until confirmed", async () => {
    subscriptionDefault({ companyKey: false });
    mappedVirtualKeys = [
      {
        id: "dependent-virtual-key",
        name: "Team proxy key",
        tokenStart: "arch_abc",
        includeFutureProviders: false,
        providerApiKeys: [
          {
            provider: "openai",
            providerApiKeyId: "my-chatgpt-key",
            providerApiKeyName: "ChatGPT",
          },
        ],
      },
    ];
    const deletedKeys: string[] = [];
    server.use(
      http.delete(`${origin}/api/llm-provider-api-keys/:id`, ({ params }) => {
        deletedKeys.push(String(params.id));
        account = { ...account, subscription: chatgpt({ connected: false }) };
        return HttpResponse.json({ success: true });
      }),
    );
    const user = userEvent.setup();
    renderRow({
      runtime: {
        command: ["archestra-codex"],
        inferenceProtocol: "openai_chat",
      },
    });

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    // The dialog Model Providers shows, naming what goes with the key.
    const dialogElement = await screen.findByRole("dialog", {
      name: "Disconnect subscription",
    });
    const dialog = within(dialogElement);
    expect(await dialog.findByText("Team proxy key")).toBeVisible();
    expect(dialogElement).toHaveTextContent(
      "The virtual key below will be deleted too.",
    );
    expect(deletedKeys).toEqual([]);

    const confirm = dialog.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeVisible();
    expect(deletedKeys).toEqual(["my-chatgpt-key"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("holds the card's place while the account loads, and offers Retry when it cannot be read", async () => {
    let fails = true;
    // Each request waits here until the test lets it answer.
    const waiting: Array<() => void> = [];
    server.use(
      http.get(`${origin}/api/agents/${agentId}/runtime/account`, async () => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
        return fails
          ? HttpResponse.json(
              {
                error: {
                  message: "Unavailable",
                  type: "api_internal_server_error",
                },
              },
              { status: 500 },
            )
          : HttpResponse.json(account);
      }),
    );
    const user = userEvent.setup();
    renderRow();

    // A placeholder, not an empty page: the card is there from the start.
    expect(
      await screen.findByRole("status", { name: "Loading your account" }),
    ).toBeVisible();
    await waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()?.();
    expect(
      await screen.findByText("Could not load the account for your runs."),
    ).toBeVisible();

    fails = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()?.();
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    expect(
      screen.queryByText("Could not load the account for your runs."),
    ).not.toBeInTheDocument();
  });

  it("says why a stored choice no longer runs, beside Choose account", async () => {
    brokenChoice();
    renderRow();

    expect(
      await screen.findByText(/The agent no longer has a company API key/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Choose account" }),
    ).toBeVisible();
  });

  it("puts the card back as it was when a switch is refused and the account cannot be read again", async () => {
    const user = userEvent.setup();
    renderRow();
    await screen.findByText("Uses company's API key");

    const unavailable = () =>
      HttpResponse.json(
        {
          error: { message: "Unavailable", type: "api_internal_server_error" },
        },
        { status: 500 },
      );
    server.use(
      http.put(`${origin}/api/agents/${agentId}/runtime/account`, unavailable),
      http.get(`${origin}/api/agents/${agentId}/runtime/account`, unavailable),
    );
    await user.click(
      screen.getByRole("button", { name: "Use personal subscription instead" }),
    );

    // Nothing was stored, so the card does not go on saying it was.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(await screen.findByText("Uses company's API key")).toBeVisible();
    expect(
      screen.queryByText("Uses your personal subscription"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use personal subscription instead" }),
    ).toBeVisible();
  });

  describe("the connection and model that are the person's to pick", () => {
    const connectionField = (value: string) =>
      screen.findByRole("button", { name: `Which connection pays ${value}` });
    const modelField = (value: string) =>
      screen.findByRole("button", { name: `Model ${value}` });
    /** What each connection offers, and which were asked for. */
    let modelRequests: Array<string | null>;

    beforeEach(() => {
      modelRequests = [];
      server.use(
        // The connections they may use for an agent of their own, and their
        // own subscription, which is not a company connection.
        http.get(`${origin}/api/llm-provider-api-keys/available`, () =>
          HttpResponse.json([
            makeLlmProviderApiKey({
              id: "key-openai",
              name: "Company OpenAI",
              provider: "openai",
              scope: "org",
              userId: null,
            }),
            {
              ...makeLlmProviderApiKey({
                id: "my-chatgpt-key",
                name: "My ChatGPT",
                provider: "openai",
                scope: "personal",
              }),
              subscriptionKind: "chatgpt",
            },
          ]),
        ),
        http.get(`${origin}/api/llm-models/available`, ({ request }) => {
          modelRequests.push(new URL(request.url).searchParams.get("apiKeyId"));
          return HttpResponse.json([
            {
              dbId: "model-gpt",
              id: "gpt-5",
              displayName: "GPT-5",
              provider: "openai",
              isFree: false,
            },
          ]);
        }),
      );
    });

    it("shows both fields where neither is fixed above, and saves each pick with the company API key", async () => {
      leftToPerson();
      const user = userEvent.setup();
      renderRow();

      expect(
        await screen.findByText("Uses company's API key"),
      ).toBeInTheDocument();
      // Nothing resolves yet: each field asks, and the model waits.
      await user.click(await connectionField("Choose a connection"));
      expect(await modelField("Choose a model")).toBeDisabled();
      expect(
        await screen.findByRole("option", { name: /Company OpenAI/ }),
      ).toBeVisible();
      // Their own subscription is not a company connection.
      expect(screen.queryByRole("option", { name: /My ChatGPT/ })).toBeNull();
      await user.click(screen.getByRole("option", { name: /Company OpenAI/ }));
      // A choice is stored whole: the connection alone leaves no model.
      await waitFor(() =>
        expect(writes).toEqual([
          {
            method: "PUT",
            body: { authentication: "provider", llmApiKeyId: "key-openai" },
          },
        ]),
      );
      expect(await connectionField("Company OpenAI")).toBeVisible();

      // The model is one of that connection's, and is saved with it: left
      // out, the connection would be stored as none.
      await user.click(await modelField("Choose a model"));
      await user.click(await screen.findByRole("option", { name: /GPT-5/ }));
      await waitFor(() =>
        expect(writes[1]).toEqual({
          method: "PUT",
          body: {
            authentication: "provider",
            llmApiKeyId: "key-openai",
            modelId: "model-gpt",
          },
        }),
      );
      expect(modelRequests).toContain("key-openai");
      expect(await modelField("GPT-5")).toBeVisible();
      // The switch stays where it was.
      expect(
        screen.getByRole("button", {
          name: "Use personal subscription instead",
        }),
      ).toBeVisible();
    });

    it("reads as the default while the organization default runs with nothing picked", async () => {
      leftToPerson({
        connection: {
          id: "org-default-key",
          name: "Organization OpenAI",
          provider: "openai",
          fixedBy: null,
        },
        model: { id: "org-default-model", name: "GPT-5", fixedBy: null },
        usesOrganizationDefault: true,
      });
      renderRow();

      expect(await connectionField("Default connection")).toBeEnabled();
      // A model of their own waits for a connection of their own.
      expect(await modelField("Default model")).toBeDisabled();
      expect(screen.queryByText("Organization OpenAI")).toBeNull();
    });

    it("reads the model as the default where their own connection serves the organization's default model", async () => {
      leftToPerson({
        connection: {
          id: "key-openai",
          name: "Company OpenAI",
          provider: "openai",
          fixedBy: null,
        },
        // Not a pick of theirs: what resolves on their connection.
        model: { id: "org-default-model", name: "GPT-5.5", fixedBy: null },
      });
      account.choice = {
        authentication: "provider",
        llmApiKeyId: "key-openai",
        modelId: null,
        claudeModel: null,
      };
      const user = userEvent.setup();
      renderRow();

      expect(await connectionField("Company OpenAI")).toBeVisible();
      await user.click(await modelField("Default model"));
      await user.click(await screen.findByRole("option", { name: /GPT-5/ }));
      await waitFor(() =>
        expect(writes).toEqual([
          {
            method: "PUT",
            body: {
              authentication: "provider",
              llmApiKeyId: "key-openai",
              modelId: "model-gpt",
            },
          },
        ]),
      );
      expect(await modelField("GPT-5")).toBeVisible();
    });

    it("asks for a part again while their own choice of it no longer works", async () => {
      // The API reports a part left to them as none while their choice of it
      // is stale, whatever the choice still names.
      leftToPerson();
      account.choice = {
        authentication: "provider",
        llmApiKeyId: "gone-key",
        modelId: "gone-model",
        claudeModel: null,
      };
      account.choiceError =
        "Your own account for this agent no longer works. The connection you chose no longer exists. Choose your account again.";
      const user = userEvent.setup();
      renderRow();

      expect(await modelField("Choose a model")).toBeDisabled();
      await user.click(await connectionField("Choose a connection"));
      await user.click(
        await screen.findByRole("option", { name: /Company OpenAI/ }),
      );
      await waitFor(() =>
        expect(writes).toEqual([
          {
            method: "PUT",
            body: { authentication: "provider", llmApiKeyId: "key-openai" },
          },
        ]),
      );
    });

    it("says why under a lock to the company API key when a part they picked no longer works, and takes a new pick in the fields", async () => {
      // A lock to the company API key still runs the parts each person picks.
      leftToPerson();
      account.lock = "key";
      account.choice = {
        authentication: "provider",
        llmApiKeyId: "gone-key",
        modelId: null,
        claudeModel: null,
      };
      account.choiceError =
        "Your own account for this agent no longer works. The connection you chose no longer exists. Choose your account again.";
      const user = userEvent.setup();
      renderRow();

      expect(
        await screen.findByText(/The connection you chose no longer exists/),
      ).toBeVisible();
      // No way to choose under a lock: nothing opens the account choice.
      expect(
        screen.queryByRole("button", { name: "Choose account" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /instead$/ })).toBeNull();
      await user.click(await connectionField("Choose a connection"));
      await user.click(
        await screen.findByRole("option", { name: /Company OpenAI/ }),
      );
      await waitFor(() =>
        expect(writes).toEqual([
          {
            method: "PUT",
            body: { authentication: "provider", llmApiKeyId: "key-openai" },
          },
        ]),
      );
    });

    it("offers only the model, among the fixed connection's models, where the connection is fixed above, and never sends that connection", async () => {
      account.agentAccount = {
        authentication: "provider",
        llmApiKeyId: "agent-key",
        modelId: null,
      };
      account.companyKey = false;
      account.companyAccount = companyAccount({
        connection: {
          id: "agent-key",
          name: "Agent key",
          provider: "openai",
          fixedBy: "agent",
        },
        // The connection is not one they can read: its models come with it.
        models: [
          {
            id: "fixed-model",
            modelId: "gpt-5",
            displayName: "GPT-5 of the agent's connection",
            provider: "openai",
          },
        ],
      });
      const user = userEvent.setup();
      renderRow();

      await user.click(await modelField("Choose a model"));
      await user.click(
        await screen.findByRole("option", {
          name: /GPT-5 of the agent's connection/,
        }),
      );
      // The API refuses a choice that names the fixed connection, even by
      // its own id: the model goes alone.
      await waitFor(() =>
        expect(writes).toEqual([
          {
            method: "PUT",
            body: { authentication: "provider", modelId: "fixed-model" },
          },
        ]),
      );
      // Accepted: a refusal would put the field back as it was.
      expect(await modelField("GPT-5")).toBeVisible();
      // The fixed connection has no field, and its models were not asked for.
      expect(
        screen.queryByRole("button", { name: /^Which connection pays/ }),
      ).toBeNull();
      expect(modelRequests).toEqual([]);
    });

    it.each([
      ["the agent", "agent", "Locked in this agent's settings."],
      ["the runtime", "runtime", "Locked in the runtime's settings."],
    ] as const)("shows both fields locked where %s fixes both, and where each is set", async (_level, fixedBy, lockedIn) => {
      // One of the connections the person can list.
      account.companyAccount = companyAccount({
        connection: {
          id: "key-openai",
          name: "Company OpenAI",
          provider: "openai",
          fixedBy,
        },
        model: { id: "model-agent", name: "Agent model", fixedBy },
      });
      renderRow();

      const connection = await connectionField("Company OpenAI");
      const model = await modelField("Agent model");
      for (const field of [connection, model]) {
        expect(field).toBeDisabled();
        expect(field).toHaveAccessibleDescription(lockedIn);
      }
      // Nothing to pick from: no list of models is asked for.
      expect(modelRequests).toEqual([]);
    });

    it("shows only the model, locked, where the connection fixed above is not one the person may see", async () => {
      account.companyAccount = companyAccount({
        connection: {
          id: "agent-key",
          name: "Agent key",
          provider: "openai",
          fixedBy: "agent",
        },
        model: { id: "model-agent", name: "Agent model", fixedBy: "agent" },
      });
      renderRow();

      expect(await modelField("Agent model")).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: /^Which connection pays/ }),
      ).toBeNull();
      expect(screen.queryByText(/Agent key/)).toBeNull();
    });

    it("does not ask for the connections of someone who may not read them, and shows the fixed model", async () => {
      permissions = {};
      let listed = 0;
      server.use(
        http.get(`${origin}/api/llm-provider-api-keys/available`, () => {
          listed += 1;
          return HttpResponse.json([]);
        }),
      );
      account.companyAccount = companyAccount({
        connection: {
          id: "key-openai",
          name: "Company OpenAI",
          provider: "openai",
          fixedBy: "agent",
        },
        model: { id: "model-agent", name: "Agent model", fixedBy: "agent" },
      });
      renderRow();

      expect(await modelField("Agent model")).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: /^Which connection pays/ }),
      ).toBeNull();
      expect(listed).toBe(0);
    });

    it("shows no company field while their runs are on their own subscription", async () => {
      leftToPerson();
      account.choice = {
        authentication: "subscription",
        llmApiKeyId: null,
        modelId: null,
        claudeModel: null,
      };
      renderRow();

      expect(
        await screen.findByText("Uses your personal subscription"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Which connection pays/ }),
      ).toBeNull();
    });

    it("puts the field back as it was when a pick is refused", async () => {
      leftToPerson();
      const user = userEvent.setup();
      renderRow();
      await user.click(await connectionField("Choose a connection"));
      server.use(
        http.put(`${origin}/api/agents/${agentId}/runtime/account`, () =>
          HttpResponse.json(
            {
              error: {
                message: "You may not use this connection.",
                type: "api_authorization_error",
              },
            },
            { status: 403 },
          ),
        ),
      );
      await user.click(
        await screen.findByRole("option", { name: /Company OpenAI/ }),
      );

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(await connectionField("Choose a connection")).toBeVisible();
      expect(
        screen.queryByRole("button", {
          name: "Which connection pays Company OpenAI",
        }),
      ).toBeNull();
    });

    it("names the way alone when they switch to the company API key, and reads what resolves with no pick of theirs", async () => {
      // On subscriptions by the agent's setting, which sets nothing for the
      // company API key: the organization default is what resolves there.
      subscriptionDefault({ companyKey: false });
      account.companyKey = true;
      account.companyAccount = companyAccount({
        connection: {
          id: "org-default-key",
          name: "Organization OpenAI",
          provider: "openai",
          fixedBy: null,
        },
        model: { id: "org-default-model", name: "GPT-5", fixedBy: null },
        usesOrganizationDefault: true,
      });
      const user = userEvent.setup();
      renderRow();

      await user.click(
        await screen.findByRole("button", { name: "Use API key instead" }),
      );
      await waitFor(() =>
        expect(writes).toEqual([
          { method: "PUT", body: { authentication: "provider" } },
        ]),
      );
      expect(await connectionField("Default connection")).toBeVisible();
      expect(await modelField("Default model")).toBeDisabled();
    });

    it("offers the company API key where nothing resolves for it yet, and asks for a connection once it is chosen", async () => {
      subscriptionDefault({ companyKey: false });
      account.companyAccount = companyAccount();
      const user = userEvent.setup();
      renderRow();

      await user.click(
        await screen.findByRole("button", { name: "Use API key instead" }),
      );
      await waitFor(() =>
        expect(writes).toEqual([
          { method: "PUT", body: { authentication: "provider" } },
        ]),
      );
      expect(await connectionField("Choose a connection")).toBeEnabled();
      expect(await modelField("Choose a model")).toBeDisabled();
    });
  });

  it("offers no other way under a lock", async () => {
    account.lock = "subscription";
    renderRow();

    expect(
      await screen.findByText("Uses your personal subscription"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /instead$/ }),
    ).not.toBeInTheDocument();
  });

  it("offers nothing to choose when a lock sets an earlier choice aside", async () => {
    // Chosen while both ways were open; the agent is locked to its key since.
    account.lock = "key";
    account.choice = {
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    account.choiceError =
      "This agent is locked to a company API key, so your own choice is not used.";
    renderRow();

    expect(
      await screen.findByText("Uses company's API key"),
    ).toBeInTheDocument();
    // The model the agent fixes shows, locked; nothing else is a control.
    expect(
      await screen.findByRole("button", { name: "Model Agent model" }),
    ).toBeDisabled();
    expect(enabledButtons()).toEqual([]);
  });

  it("shows the line and the fields the agent locks for a runtime without a subscription: nothing to switch to, sign in to or pick", async () => {
    account.subscription = null;
    renderRow();

    expect(
      await screen.findByText("Uses company's API key"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Model Agent model" }),
    ).toBeDisabled();
    expect(enabledButtons()).toEqual([]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
