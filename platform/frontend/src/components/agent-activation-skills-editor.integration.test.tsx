import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRef, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AgentActivationSkillsEditor,
  type AgentActivationSkillsEditorRef,
} from "./agent-activation-skills-editor";

const API_ORIGIN = "http://localhost:9000";
const AGENT_ID = "agent-1";
const POLICY_URL = `${API_ORIGIN}/api/agents/${AGENT_ID}/activation-skill-policy`;
const CATALOG_URL = `${API_ORIGIN}/api/agents/activation-skills`;

const nativeSkill = {
  reference: { source: "native" as const, skillId: "skill-1" },
  name: "incident-response",
  activationName: "incident-response",
  description: "Respond to incidents",
  scope: "org" as const,
  providerName: null,
};
const externalSkill = {
  reference: {
    source: "external_mcp" as const,
    mcpServerId: "server-1",
    uri: "skill://research",
  },
  name: "research",
  activationName: "research",
  description: "Research a topic",
  scope: "team" as const,
  providerName: "Research Server",
};

const server = setupServer();

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/agent-1",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AgentActivationSkillsEditor", () => {
  it("preserves independent All and Manual sets and saves revisioned operations", async () => {
    let patchBody: unknown;
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "all",
          revision: 7,
          allowedReferences: [externalSkill.reference],
          excludedReferences: [nativeSkill.reference],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [externalSkill],
          excludedSkills: [nativeSkill],
        }),
      ),
      http.get(CATALOG_URL, ({ request }) => {
        expect(new URL(request.url).searchParams.get("view")).toBe("eligible");
        return HttpResponse.json(catalog([nativeSkill, externalSkill]));
      }),
      http.patch(POLICY_URL, async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({
          mode: "manual",
          revision: 8,
          allowedReferences: [externalSkill.reference, nativeSkill.reference],
          excludedReferences: [nativeSkill.reference],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [externalSkill, nativeSkill],
          excludedSkills: [nativeSkill],
        });
      }),
    );

    const user = userEvent.setup();
    renderEditor();

    expect(
      await screen.findByRole("button", { name: /^Remove incident-response/ }),
    ).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Manual" }));
    expect(
      screen.getByRole("button", { name: /^Remove research/ }),
    ).toBeVisible();
    expect(screen.queryByText("MCP")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByText("incident-response"));
    expect(
      screen.getByRole("button", { name: /^Remove incident-response/ }),
    ).toBeVisible();
    expect(screen.queryByText("Organization · skill-1")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(
      screen.getByRole("button", { name: /^Remove incident-response/ }),
    ).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Manual" }));
    await user.click(screen.getByRole("button", { name: "Save skills" }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        expectedRevision: 7,
        mode: "manual",
        operations: [
          {
            op: "add",
            disposition: "allow",
            reference: nativeSkill.reference,
          },
        ],
      }),
    );
  });

  it("opens the shared read-only skills view from All mode", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "all",
          revision: 0,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, () =>
        HttpResponse.json(catalog([nativeSkill, externalSkill])),
      ),
    );

    const user = userEvent.setup();
    renderEditor();

    await user.click(
      await screen.findByRole("button", { name: "Disable Skill" }),
    );
    await user.click(await screen.findByText("incident-response"));
    await user.click(
      await screen.findByRole("button", { name: "View 1 Skill" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Skills available in All mode",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("columnheader", { name: "Visibility" }),
    ).toBeVisible();
    expect(within(dialog).queryByText("incident-response")).toBeNull();
    expect(within(dialog).getByText("Research Server")).toBeVisible();
  });

  it("distinguishes same-named skill-library choices by scope and exact identity", async () => {
    const personalSkill = {
      ...nativeSkill,
      reference: { source: "native" as const, skillId: "aaaa1111-personal" },
      name: "duplicate-playbook",
      activationName: "duplicate-playbook",
      scope: "personal" as const,
    };
    const otherPersonalSkill = {
      ...personalSkill,
      reference: { source: "native" as const, skillId: "bbbb2222-personal" },
    };
    const organizationSkill = {
      ...nativeSkill,
      reference: { source: "native" as const, skillId: "cccc3333-org" },
      name: "duplicate-playbook",
      activationName: "duplicate-playbook",
      scope: "org" as const,
    };
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "manual",
          revision: 0,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, () =>
        HttpResponse.json(
          catalog([personalSkill, otherPersonalSkill, organizationSkill]),
        ),
      ),
    );

    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("button", { name: "Add" }));

    expect(
      screen.getByText("Skill library · Personal · aaaa1111"),
    ).toBeVisible();
    expect(
      screen.getByText("Skill library · Personal · bbbb2222"),
    ).toBeVisible();
    expect(
      screen.getByText("Skill library · Organization · cccc3333"),
    ).toBeVisible();

    await user.click(screen.getByText("Skill library · Personal · aaaa1111"));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByText("Skill library · Personal · bbbb2222"));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(
      screen.getByText("Skill library · Organization · cccc3333"),
    );

    expect(
      screen.getByRole("button", {
        name: "Remove duplicate-playbook (Personal · aaaa1111)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Remove duplicate-playbook (Personal · bbbb2222)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Remove duplicate-playbook (Organization · cccc3333)",
      }),
    ).toBeVisible();
  });

  it("does not show editable defaults while policy state is loading", async () => {
    server.use(
      http.get(POLICY_URL, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
      http.get(CATALOG_URL, () => HttpResponse.json(catalog([]))),
    );

    renderEditor();

    expect(await screen.findByText("Loading agent skills…")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "All" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("keeps the policy editable when model-driven skill discovery is disabled", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "all",
          revision: 0,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, () =>
        HttpResponse.json(catalog([nativeSkill], false)),
      ),
    );

    renderEditor();

    expect(
      await screen.findByText(/Skill discovery is not enabled/i),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "All" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Disable Skill" }),
    ).toBeVisible();
  });

  it("keeps a dirty draft after a revision conflict refetches the policy", async () => {
    let policyReads = 0;
    server.use(
      http.get(POLICY_URL, () => {
        policyReads += 1;
        return HttpResponse.json({
          mode: policyReads === 1 ? "all" : "manual",
          revision: policyReads === 1 ? 7 : 8,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        });
      }),
      http.get(CATALOG_URL, () =>
        HttpResponse.json(catalog([nativeSkill, externalSkill])),
      ),
      http.patch(POLICY_URL, () =>
        HttpResponse.json(
          {
            error: {
              message: "Activation skill policy was modified",
              type: "api_conflict",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("tab", { name: "Manual" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByText("incident-response"));
    await user.click(screen.getByRole("button", { name: "Save skills" }));

    await waitFor(() => expect(policyReads).toBeGreaterThan(1));
    expect(
      screen.getByRole("button", { name: /^Remove incident-response/ }),
    ).toBeVisible();
  });

  it("can discard hidden rules without revealing their references", async () => {
    let patchBody: unknown;
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "manual",
          revision: 3,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 2,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, () => HttpResponse.json(catalog([]))),
      http.patch(POLICY_URL, async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({
          mode: "manual",
          revision: 4,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        });
      }),
    );

    const user = userEvent.setup();
    renderEditor();
    await user.click(
      await screen.findByRole("button", {
        name: "Remove 2 unavailable allowed skills",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save skills" }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        expectedRevision: 3,
        discardUnavailable: ["allow"],
      }),
    );
  });

  it("keeps provider-only server search matches visible in the picker", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "manual",
          revision: 0,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, () => HttpResponse.json(catalog([externalSkill]))),
    );

    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(
      screen.getByLabelText("Search skills..."),
      "Research Server",
    );

    expect(await screen.findByText("research")).toBeVisible();
  });

  it("drops staged create rules that are unavailable after an environment change", async () => {
    let submittedPolicy: unknown;
    server.use(
      http.get(CATALOG_URL, ({ request }) => {
        const environmentId = new URL(request.url).searchParams.get(
          "environmentId",
        );
        const response = catalog(
          environmentId === "env-a" ? [nativeSkill] : [externalSkill],
        );
        if (environmentId === "env-b") {
          response.pagination = {
            ...response.pagination,
            total: 101,
            totalPages: 2,
            hasNext: true,
          };
        }
        return HttpResponse.json(response);
      }),
    );

    function CreateEnvironmentHarness() {
      const ref = useRef<AgentActivationSkillsEditorRef>(null);
      const [environmentId, setEnvironmentId] = useState("env-a");
      return (
        <>
          <AgentActivationSkillsEditor
            ref={ref}
            environmentId={environmentId}
          />
          <button type="button" onClick={() => setEnvironmentId("env-b")}>
            Change environment
          </button>
          <button
            type="button"
            onClick={() => {
              submittedPolicy = ref.current?.getCreatePolicy();
            }}
          >
            Capture policy
          </button>
        </>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentHarness />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("tab", { name: "Manual" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByText("incident-response"));
    await user.click(
      screen.getByRole("button", { name: "Change environment" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Remove incident-response/ }),
      ).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "Capture policy" }));

    expect(submittedPolicy).toEqual({
      mode: "manual",
      allowedReferences: [],
      excludedReferences: [],
    });
  });

  it("drops only staged rules after an existing agent changes environment", async () => {
    const savedSkill = {
      ...nativeSkill,
      reference: { source: "native" as const, skillId: "skill-saved" },
      name: "saved-skill",
      activationName: "saved-skill",
    };
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "manual",
          revision: 2,
          allowedReferences: [savedSkill.reference],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [savedSkill],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, ({ request }) => {
        const environmentId = new URL(request.url).searchParams.get(
          "environmentId",
        );
        return HttpResponse.json(
          catalog(
            environmentId === "env-a"
              ? [savedSkill, nativeSkill]
              : [externalSkill],
          ),
        );
      }),
    );

    function ExistingEnvironmentHarness() {
      const [environmentId, setEnvironmentId] = useState("env-a");
      return (
        <>
          <AgentActivationSkillsEditor
            agentId={AGENT_ID}
            environmentId={environmentId}
          />
          <button type="button" onClick={() => setEnvironmentId("env-b")}>
            Change environment
          </button>
        </>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ExistingEnvironmentHarness />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.click(await screen.findByText("incident-response"));
    await user.click(
      screen.getByRole("button", { name: "Change environment" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Remove incident-response/ }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /^Remove saved-skill/ }),
    ).toBeVisible();
  });

  it("shows a server-side search failure instead of an empty result", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json({
          mode: "manual",
          revision: 0,
          allowedReferences: [],
          excludedReferences: [],
          hiddenAllowedCount: 0,
          hiddenExcludedCount: 0,
          allowedSkills: [],
          excludedSkills: [],
        }),
      ),
      http.get(CATALOG_URL, ({ request }) =>
        new URL(request.url).searchParams.has("search")
          ? HttpResponse.json({ error: { message: "failed" } }, { status: 500 })
          : HttpResponse.json(catalog([])),
      ),
    );

    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("Search skills..."), "remote-only");

    expect(
      await screen.findByText(/Could not search the full skill catalog/i),
    ).toBeVisible();
  });

  it("fails loud when the policy cannot be loaded", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json(
          { error: { message: "Request failed", type: "api_internal_error" } },
          { status: 500 },
        ),
      ),
      http.get(CATALOG_URL, () => HttpResponse.json(catalog([]))),
    );

    renderEditor();

    expect(
      await screen.findByText(/Could not load the agent's skills/i),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: "All" })).toBeNull();
  });
});

function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

function Harness() {
  const ref = useRef<AgentActivationSkillsEditorRef>(null);
  return (
    <>
      <AgentActivationSkillsEditor ref={ref} agentId={AGENT_ID} />
      <button
        type="button"
        onClick={() => void ref.current?.saveChanges().catch(() => undefined)}
      >
        Save skills
      </button>
    </>
  );
}

function catalog(data: unknown[], enabled = true) {
  return {
    enabled,
    data,
    pagination: {
      currentPage: 1,
      limit: 100,
      total: data.length,
      totalPages: data.length > 0 ? 1 : 0,
      hasNext: false,
      hasPrev: false,
    },
  };
}
