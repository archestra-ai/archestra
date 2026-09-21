import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useEffect, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useEnvironments } from "@/lib/environment.query";
import {
  EnvironmentSelector,
  GLOBAL_ENVIRONMENT_SCOPE,
} from "./environment-selector";

// Only the authentication client and HTTP boundaries are stubbed; the selector,
// query hooks, QueryClient, SDK, and Radix Select are real.
vi.mock("@/lib/clients/auth/auth-client");
vi.mock("sonner");

const origin = "http://localhost:9000";
const savedId = "10000000-0000-4000-8000-000000000001";
const savedEnvironment = {
  id: savedId,
  name: "Restricted test environment",
  restricted: true,
  // The listing answers deploy authority per environment; this one is closed
  // to the caller, which is what makes its option disabled below.
  canDeploy: false,
  description: null,
};
const otherEnvironment = {
  id: "10000000-0000-4000-8000-000000000002",
  name: "Other test environment",
  restricted: false,
  canDeploy: true,
  description: null,
};
const server = setupServer();
let client: QueryClient;
let environmentRequests: number;
let availableEnvironments: (typeof savedEnvironment)[];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  environmentRequests = 0;
  availableEnvironments = [savedEnvironment, otherEnvironment];
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: { user: { id: "test-user" }, session: { id: "test-session" } },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  server.use(
    http.get(`${origin}/api/environments`, () => {
      environmentRequests++;
      return HttpResponse.json({
        environments: availableEnvironments,
        defaultAssignedCatalogCount: 0,
        resourceDefaults: {
          mcpRegistry: null,
          app: null,
          agent: null,
          mcpGateway: null,
          knowledgeSource: null,
        },
        canDeployToDefault: true,
      });
    }),
    http.get(`${origin}/api/organization`, () =>
      HttpResponse.json({ defaultEnvironmentName: "Default" }),
    ),
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json({
        environment: ["read"],
        mcpGateway: ["read", "update"],
      }),
    ),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("EnvironmentSelector inside an initialized form", () => {
  test("cold opening fetches the list and displays a saved restricted environment", async () => {
    const onChange = openSelector();
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(savedEnvironment.name),
    );
    expect(environmentRequests).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a complete warm cache displays the environment without another request", async () => {
    await warmCache();
    const onChange = openSelector();
    await act(async () => {});
    expect(environmentRequests).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent(savedEnvironment.name);
  });
});

describe("EnvironmentSelector modes", () => {
  test("skills retain saved restricted assignments, allow removal, and prevent assigning them again", async () => {
    render(
      <QueryClientProvider client={client}>
        <SkillEnvironments />
      </QueryClientProvider>,
    );
    const selector = await screen.findByRole("combobox", {
      name: "Environments",
    });
    await waitFor(() =>
      expect(selector).toHaveTextContent(savedEnvironment.name),
    );
    const user = userEvent.setup();
    await user.click(selector);
    const restricted = screen.getByRole("option", {
      name: /^Restricted test environment/,
    });
    expect(restricted).toHaveAttribute("aria-disabled", "true");
    expect(restricted).toHaveTextContent(/This environment is restricted/);
    await user.click(
      screen.getByRole("option", { name: "Other test environment" }),
    );
    expect(selector).toHaveTextContent(otherEnvironment.name);
    await user.click(
      screen.getAllByRole("button", { name: "Remove selected option" })[0],
    );
    expect(selector).not.toHaveTextContent(savedEnvironment.name);
    await user.click(selector);
    expect(
      screen.getByRole("option", { name: /^Restricted test environment/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  test("cost scopes allow restricted environments without deployment permission and disable already-used scopes", async () => {
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <EnvironmentSelector
          mode="scope"
          value={GLOBAL_ENVIRONMENT_SCOPE}
          onChange={onChange}
          includeGlobalOption
          takenValues={new Set([otherEnvironment.id])}
        />
      </QueryClientProvider>,
    );
    await warmUntilLoaded();
    await userEvent.click(trigger());
    expect(
      screen.getByRole("option", { name: /Other test environment/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("option", { name: /Other test environment/ }),
    ).toHaveTextContent("Already has a limit");
    await userEvent.click(
      screen.getByRole("option", { name: savedEnvironment.name }),
    );
    expect(onChange).toHaveBeenCalledWith(savedId);
  });

  test("organization defaults allow restricted environments without deployment permission", async () => {
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <EnvironmentSelector
          mode="default"
          value={null}
          onChange={onChange}
          label="New agents"
        />
      </QueryClientProvider>,
    );
    await warmUntilLoaded();
    await userEvent.click(screen.getByRole("combobox", { name: "New agents" }));
    await userEvent.click(
      screen.getByRole("option", { name: savedEnvironment.name }),
    );
    expect(onChange).toHaveBeenCalledWith(savedId);
  });
});

function SkillEnvironments() {
  const [value, setValue] = useState([savedId]);
  return (
    <EnvironmentSelector
      mode="multiple"
      resource="skill"
      value={value}
      onChange={setValue}
    />
  );
}

async function warmUntilLoaded() {
  await waitFor(() =>
    expect(client.getQueryState(["environments", "list"])?.status).toBe(
      "success",
    ),
  );
}

function trigger() {
  return screen.getByRole("combobox", { name: "Environment" });
}

function openSelector() {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SeededForm onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

async function warmCache() {
  const view = render(
    <QueryClientProvider client={client}>
      <EnvironmentListReader />
    </QueryClientProvider>,
  );
  await screen.findByText("List loaded");
  view.unmount();
}

function EnvironmentListReader() {
  const query = useEnvironments();
  return <span>{query.isSuccess ? "List loaded" : "Loading"}</span>;
}

function SeededForm({
  onChange,
}: {
  onChange: (value: string | null) => void;
}) {
  // AgentForm initializes from its saved record in an effect after mounting.
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    setValue(savedId);
  }, []);
  return (
    <form>
      <EnvironmentSelector
        value={value}
        resource="mcpGateway"
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    </form>
  );
}
