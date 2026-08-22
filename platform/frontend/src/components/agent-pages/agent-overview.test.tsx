import type { archestraApiTypes } from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDelegationTargetAgents } from "@/lib/agent.query";
import {
  useAgentSkillExclusions,
  useAgentSkills,
} from "@/lib/agent-skills.query";
import { useAgentSubagentExclusions } from "@/lib/agent-subagent-exclusions.query";
import { useAgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useConnectors } from "@/lib/knowledge/connector.query";
import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBases,
} from "@/lib/knowledge/knowledge-base.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { AgentOverview } from "./agent-overview";

vi.mock("@/components/editor");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
// The MCP server icons fall back to the app logo, which reads the org's
// appearance settings.
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent-subagent-exclusions.query", () => ({
  useAgentSubagentExclusions: vi.fn(),
}));
vi.mock("@/lib/agent-tool-exclusions.query", () => ({
  useAgentToolExclusions: vi.fn(),
}));
vi.mock("@/lib/agent-tools.query", () => ({ useAgentDelegations: vi.fn() }));
vi.mock("@/lib/agent.query", () => ({ useDelegationTargetAgents: vi.fn() }));
vi.mock("@/lib/agent-skills.query", () => ({
  useAgentSkills: vi.fn(),
  useAgentSkillExclusions: vi.fn(),
}));
vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  useIdentityProviders: vi.fn(),
}));
vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));
vi.mock("@/lib/config/config.query", () => ({ useFeature: vi.fn() }));
vi.mock("@/lib/knowledge/connector.query", () => ({ useConnectors: vi.fn() }));
vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: vi.fn(),
  useIsKnowledgeBaseConfigured: vi.fn(),
}));
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: vi.fn(),
  fetchCatalogTools: vi.fn(),
}));
vi.mock("@/lib/llm-models.query", () => ({ useLlmModels: vi.fn() }));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: vi.fn(),
}));
vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({ catalogName: "Archestra" }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueries: vi.fn(),
}));

type Agent = archestraApiTypes.GetAgentResponses["200"];

const baseAgent = {
  id: "a1",
  name: "Support",
  agentType: "agent",
  builtIn: false,
  scope: "personal",
  authorId: "me",
  authorName: "Me",
  teams: [],
  users: [],
  labels: [],
  icon: null,
  description: null,
  systemPrompt: null,
  suggestedPrompts: [],
  tools: [],
  knowledgeBaseIds: [],
  connectorIds: [],
  accessAllTools: false,
  accessAllSubagents: false,
  toolExposureMode: "full",
  missingCredentialBehavior: "allow",
  considerContextUntrusted: false,
  identityProviderId: null,
  passthroughHeaders: null,
  environmentId: null,
  modelId: null,
  resolvedLlmModelName: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function renderOverview(
  kind: "agent" | "llm_proxy" | "mcp_gateway",
  overrides: Partial<typeof baseAgent> = {},
) {
  return render(
    <AgentOverview
      kind={kind}
      agent={{ ...baseAgent, ...overrides } as unknown as Agent}
    />,
  );
}

/** The card whose heading names it, so assertions can be scoped to it. */
function section(name: string) {
  // Every card title is one rank; cards are siblings, not a hierarchy.
  const heading = screen.getByRole("heading", { name });
  const element = heading.closest("section");
  if (!element) throw new Error(`No section around "${name}"`);
  return within(element);
}

/** A labelled field of the summary card, so assertions can be scoped to it. */
function field(label: string) {
  const element = screen.getByText(label).parentElement;
  if (!element) throw new Error(`No field labelled "${label}"`);
  return within(element);
}

describe("AgentOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "me" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [] },
    } as unknown as ReturnType<typeof useEnvironments>);
    vi.mocked(useIdentityProviders).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useIdentityProviders>);
    vi.mocked(useConnectors).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useConnectors>);
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(true);
    vi.mocked(useKnowledgeBases).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useKnowledgeBases>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useLlmModels).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useLlmModels>);
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    vi.mocked(useQueries).mockReturnValue([]);
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
    vi.mocked(useAgentSubagentExclusions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAgentSubagentExclusions>);
    vi.mocked(useAgentDelegations).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAgentDelegations>);
    vi.mocked(useDelegationTargetAgents).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useDelegationTargetAgents>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAgentSkills).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAgentSkills>);
    vi.mocked(useAgentSkillExclusions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAgentSkillExclusions>);
  });

  it("leaves editing to the page header instead of repeating it on cards", () => {
    renderOverview("agent", {
      systemPrompt: "Be brief.",
    } as unknown as Partial<typeof baseAgent>);

    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("closes with the record itself: id, dates, owner and labels, never an updater", () => {
    renderOverview("agent", {
      authorName: "Ada",
      labels: [{ key: "team", value: "support" }],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-18T09:00:00.000Z",
    } as unknown as Partial<typeof baseAgent>);

    const details = section("Details");
    expect(details.getByText("a1")).toBeVisible();
    expect(
      details.getByRole("button", { name: /copy to clipboard/i }),
    ).toBeVisible();
    expect(details.getByText("Created")).toBeVisible();
    expect(details.getByText("Last updated")).toBeVisible();
    expect(details.getByText("Ada")).toBeVisible();
    // Labels classify the record, so they close the page with it.
    expect(details.getByText("Labels")).toBeVisible();
    // The agent row records when it changed, never by whom.
    expect(details.queryByText(/updated by/i)).toBeNull();
    // "Accessible to: Me" on a page only this reader can open said nothing;
    // the visibility badge beside the page title carries the scope.
    expect(screen.queryByText("Accessible to")).toBeNull();
  });

  it("opens with what the agent answers with, and stacks one card per subject at one heading rank", () => {
    renderOverview("agent", {
      labels: [{ key: "team", value: "support" }],
    } as unknown as Partial<typeof baseAgent>);

    const facts = section("Model and environment");
    expect(facts.getByText("Model")).toBeVisible();
    expect(facts.getByText("Environment")).toBeVisible();

    // Cards are siblings, so their titles are one rank — the three h3s that
    // used to precede the page's first h2 said a hierarchy that was not there.
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((el) => el.textContent),
    ).toEqual([
      "Model and environment",
      "Instruction",
      "Tools and knowledge sources",
      "Subagents",
      "Security and identity",
      "Details",
    ]);
    expect(screen.queryAllByRole("heading", { level: 3 })).toEqual([]);
  });

  it("reads the instruction in the wizard's editor, read-only, keeping its Handlebars highlighting", () => {
    renderOverview("agent", {
      systemPrompt: "Hello {{user.name}}, be brief.",
    } as unknown as Partial<typeof baseAgent>);

    const editor = section("Instruction").getByRole("textbox", {
      name: "Instruction",
    });
    expect(editor).toHaveValue("Hello {{user.name}}, be brief.");
    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveAttribute("data-language", "handlebars");
  });

  it("clips a long instruction until the reader asks for the rest", async () => {
    const user = userEvent.setup();
    // Forty lines: well past the collapsed height at the mock editor's line
    // height, which is what the clip is measured against.
    const prompt = Array.from(
      { length: 40 },
      (_, i) => `Rule ${i + 1}: be brief.`,
    ).join("\n");
    renderOverview("agent", {
      systemPrompt: prompt,
    } as unknown as Partial<typeof baseAgent>);

    const instruction = section("Instruction");
    const editor = instruction.getByRole("textbox", { name: "Instruction" });
    expect(editor).toHaveValue(prompt);
    const toggle = instruction.getByRole("button", {
      name: /show full instruction/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // An icon-only toggle, named for assistive tech, laid over the clipped
    // text rather than under it.
    expect(toggle).toHaveTextContent("");
    const clip = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(clip).toContainElement(editor);
    expect(clip?.parentElement).toContainElement(toggle);
    expect(clip).toHaveStyle({ maxHeight: "160px" });
    expect(clip?.className).toMatch(/mask-image/);

    await user.click(toggle);
    const collapse = instruction.getByRole("button", { name: /show less/i });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    // Open: the whole prompt (40 lines at the mock's 20px, plus padding)
    // and the strip the toggle sits in — no more, so the box does not end
    // in an empty rectangle.
    expect(clip).toHaveStyle({ maxHeight: `${40 * 20 + 16 + 36}px` });
    // The fade belongs to the clipped state only; masking the open state
    // greyed out that strip for no reason.
    expect(clip?.className).not.toMatch(/mask-image/);
  });

  it("leaves a short instruction whole, with nothing to expand", () => {
    renderOverview("agent", {
      systemPrompt: "Be brief.",
    } as unknown as Partial<typeof baseAgent>);

    expect(
      section("Instruction").queryByRole("button", { name: /show/i }),
    ).toBeNull();
  });

  it("names the model an agent without one of its own actually runs on", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: { defaultModelId: "m1" },
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmModels).mockReturnValue({
      data: [
        { dbId: "m1", displayName: "Claude Sonnet", provider: "anthropic" },
      ],
    } as unknown as ReturnType<typeof useLlmModels>);

    renderOverview("agent");
    const model = field("Model");
    expect(model.getByText("Organization default")).toBeVisible();
    expect(model.getByText("Anthropic · Claude Sonnet")).toBeVisible();
    // The form's model pill carries the provider's logo; so does this one.
    expect(model.getByRole("img", { name: /anthropic logo/i })).toBeVisible();
  });

  it("shows the fallback model as a value without explanatory prose", () => {
    renderOverview("agent");
    const model = field("Model");
    expect(model.getByText("Best available model")).toBeVisible();
    expect(model.getByText("Organization default")).toBeVisible();
    expect(model.queryByText(/No organization default is set/)).toBeNull();
  });

  it("shows the agent's own key and model with the provider's logo", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ id: "k1", name: "Team OpenAI key", provider: "openai" }],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    renderOverview("agent", {
      llmApiKeyId: "k1",
      modelId: "m2",
      resolvedLlmModelName: "GPT-5",
      resolvedLlmProvider: "openai",
    } as unknown as Partial<typeof baseAgent>);

    const model = field("Model");
    expect(model.getByText("Team OpenAI key")).toBeVisible();
    expect(model.getByText("OpenAI · GPT-5")).toBeVisible();
    expect(model.getByRole("img", { name: /openai logo/i })).toBeVisible();
  });

  it("names the servers the disabled tools belong to, with the wizard's N/M counts", () => {
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [
        { id: "cat-a", name: "Archestra", icon: null },
        { id: "cat-b", name: "GitHub", icon: null },
      ],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useQueries).mockReturnValue([
      {
        data: [
          { id: "a1", name: "a__one" },
          { id: "a2", name: "a__two" },
          { id: "a3", name: "a__three" },
        ],
      },
      { data: [{ id: "b1", name: "b__one" }] },
    ] as unknown as ReturnType<typeof useQueries>);
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: { excludedToolIds: ["a1", "a2", "zzz"] },
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
    renderOverview("agent", { accessAllTools: true });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("2/3 disabled")).toBeVisible();
    expect(tools.queryByText("GitHub")).toBeNull();
    // An id no visible server accounts for is still counted, not dropped.
    expect(tools.getByText("Other servers")).toBeVisible();
    expect(tools.getByText("1/1 disabled")).toBeVisible();
  });

  it("groups assigned tools under their MCP server, leaving delegation rows to the Subagents section", () => {
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [{ id: "cat-1", name: "GitHub", icon: null }],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    renderOverview("agent", {
      tools: [
        {
          id: "t1",
          name: "github__create_issue",
          catalogId: "cat-1",
          delegateToAgentId: null,
        },
        {
          id: "t2",
          name: "github__list_issues",
          catalogId: "cat-1",
          delegateToAgentId: null,
        },
        {
          id: "d1",
          name: "delegate_to_researcher",
          catalogId: null,
          delegateToAgentId: "a2",
        },
      ],
    } as Partial<typeof baseAgent>);

    const tools = section("Tools and knowledge sources");
    // The server pill carries the count; two tools, not three.
    expect(tools.getByText("GitHub")).toBeInTheDocument();
    expect(tools.getByText("(2)")).toBeInTheDocument();
    expect(tools.getByText("create_issue")).toBeInTheDocument();
    expect(tools.getByText("list_issues")).toBeInTheDocument();
    expect(tools.queryByText("delegate_to_researcher")).toBeNull();
    // The server has a page; its pill opens it. A single tool has none, so
    // its badge stays inert rather than offering a dead click.
    expect(tools.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "/mcp/registry/cat-1",
    );
    expect(tools.queryByRole("link", { name: "create_issue" })).toBeNull();
  });

  it("counts the disabled subagents past the cap instead of dropping them", () => {
    const roster = Array.from({ length: 14 }, (_, index) => ({
      id: `sub-${index}`,
      name: `Agent ${index}`,
      icon: null,
    }));
    vi.mocked(useDelegationTargetAgents).mockReturnValue({
      data: roster,
    } as unknown as ReturnType<typeof useDelegationTargetAgents>);
    vi.mocked(useAgentSubagentExclusions).mockReturnValue({
      data: { excludedSubagentIds: roster.map((target) => target.id) },
    } as unknown as ReturnType<typeof useAgentSubagentExclusions>);
    renderOverview("agent", { accessAllSubagents: true });

    const subagents = section("Subagents");
    expect(subagents.getByText("Agent 0")).toBeInTheDocument();
    expect(subagents.queryByText("Agent 12")).toBeNull();
    expect(subagents.getByText("+2 more")).toBeInTheDocument();
    // Each named one opens the agent it disables.
    expect(subagents.getByRole("link", { name: /Agent 0/ })).toHaveAttribute(
      "href",
      "/agents/sub-0",
    );
  });

  it("shows Auto mode as compact state rows, with connections dormant", () => {
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: { excludedToolIds: ["x1", "x2"] },
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
    renderOverview("agent", {
      accessAllTools: true,
      toolExposureMode: "search_and_run_only",
      missingCredentialBehavior: "block",
    });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Auto")).toBeInTheDocument();
    expect(tools.getByText("Disabled tools")).toBeInTheDocument();
    // The pills carry the counts; no heading repeats them.
    expect(tools.queryByText("2")).toBeNull();
    // Discovering tools on demand is the progressive-loading setting, shown
    // as the same setting row as under Custom — not one more note on the mode.
    expect(tools.queryByText(/discovered on demand/)).toBeNull();
    expect(tools.getByText("Tools loaded")).toBeInTheDocument();
    expect(tools.getByText("Progressively")).toBeInTheDocument();
    expect(tools.getByText("Tool connections")).toBeInTheDocument();
    expect(tools.getByText("Not needed")).toBeInTheDocument();
    expect(tools.queryByText("Required before use")).toBeNull();
    expect(tools.getAllByRole("link", { name: /Learn more/ })).toHaveLength(2);
  });

  it("names the knowledge sources Auto mode searches — the environment's, not the stored assignment", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
        {
          id: "c2",
          name: "Tickets",
          connectorType: "jira",
          environmentId: null,
        },
        // Another environment's source is not searched by this agent.
        {
          id: "c3",
          name: "Staging wiki",
          connectorType: "notion",
          environmentId: "env-2",
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    renderOverview("agent", {
      accessAllTools: true,
      // Auto ignores the assignment at runtime, so it must not be listed.
      connectorIds: ["c3"],
    } as unknown as Partial<typeof baseAgent>);

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Knowledge sources")).toBeInTheDocument();
    expect(tools.getByText("Handbook")).toBeInTheDocument();
    expect(tools.getByText("Tickets")).toBeInTheDocument();
    expect(tools.queryByText("Staging wiki")).toBeNull();
  });

  it("counts assigned sources it cannot name rather than dropping them", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    renderOverview("agent", {
      accessAllTools: false,
      connectorIds: ["c1", "c2"],
      knowledgeBaseIds: ["kb-9"],
    } as unknown as Partial<typeof baseAgent>);

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Handbook")).toBeInTheDocument();
    // Two ids this reader cannot resolve: named as a count, not silently lost.
    expect(tools.getByText("+2 not visible to you")).toBeInTheDocument();
  });

  it("says knowledge search is off when the organization has no embedding model", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(false);
    renderOverview("agent", { accessAllTools: true });

    const tools = section("Tools and knowledge sources");
    expect(
      tools.getByText(/Knowledge search is off — no embedding model/),
    ).toBeInTheDocument();
  });

  it("shows Custom-mode settings as compact state rows with docs links", () => {
    renderOverview("agent", {
      toolExposureMode: "search_and_run_only",
      missingCredentialBehavior: "warn",
    });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Tools loaded")).toBeInTheDocument();
    expect(tools.getByText("Progressively")).toBeInTheDocument();
    // Each setting points at its public docs.
    const learnMore = tools.getAllByRole("link", { name: /Learn more/ });
    expect(learnMore[0]).toHaveAttribute(
      "href",
      expect.stringContaining("#load-tools-when-needed"),
    );
    expect(learnMore[1]).toHaveAttribute(
      "href",
      expect.stringContaining("#tool-connections"),
    );
    expect(tools.getByText("Tool connections")).toBeInTheDocument();
    expect(tools.getByText("Requested at chat start")).toBeInTheDocument();
  });

  it("names upfront loading and on-demand connections as values", () => {
    renderOverview("agent", {
      toolExposureMode: "full",
      missingCredentialBehavior: "allow",
    });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Tools loaded")).toBeInTheDocument();
    expect(tools.getByText("Upfront")).toBeInTheDocument();
    expect(tools.queryByText("Off")).toBeNull();
    expect(tools.getByText("Requested when needed")).toBeInTheDocument();
  });

  it("names the delegation targets and the advisor's state, without counting the advisor", () => {
    // This reader may open LLM settings, so the row offers the way there.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useDelegationTargetAgents).mockReturnValue({
      data: [
        { id: "advisor", builtInAgentConfig: { name: "advisor-agent" } },
        { id: "a2", name: "Researcher", icon: null },
      ],
    } as unknown as ReturnType<typeof useDelegationTargetAgents>);
    vi.mocked(useAgentDelegations).mockReturnValue({
      data: [
        { id: "a2", name: "Researcher" },
        { id: "advisor", name: "Advisor" },
      ],
    } as unknown as ReturnType<typeof useAgentDelegations>);
    renderOverview("agent");

    const subagents = section("Subagents");
    const pills = subagents.getByRole("list");
    expect(within(pills).getByText("Researcher")).toBeInTheDocument();
    expect(within(pills).queryByText("Advisor")).toBeNull();
    // The advisor is its own setting, shown as a setting row under the
    // pills — the way the tool settings are — not as plain text.
    expect(subagents.getByText("Advisor Subagent")).toBeInTheDocument();
    expect(subagents.getByText("On")).toBeInTheDocument();
    expect(subagents.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
      "href",
      expect.stringContaining("#advisor"),
    );
    // The advisor is a beta capability, and its model is one org-wide
    // setting — the row says so and points at where it is chosen.
    expect(subagents.getByText("Beta")).toBeInTheDocument();
    expect(
      subagents.getByRole("link", { name: /Advisor settings/ }),
    ).toHaveAttribute("href", "/settings/llm#advisor");
  });

  it("withholds the advisor's settings link from a reader who cannot open LLM settings", () => {
    // The suite denies every permission by default, this one included.
    vi.mocked(useDelegationTargetAgents).mockReturnValue({
      data: [{ id: "advisor", builtInAgentConfig: { name: "advisor-agent" } }],
    } as unknown as ReturnType<typeof useDelegationTargetAgents>);
    renderOverview("agent");

    const subagents = section("Subagents");
    expect(subagents.getByText("Advisor Subagent")).toBeInTheDocument();
    expect(
      subagents.queryByRole("link", { name: /Advisor settings/ }),
    ).toBeNull();
  });

  it("keeps the Subagents section for a gateway and a legacy profile, but not for an LLM proxy", () => {
    const gateway = renderOverview("mcp_gateway", {
      agentType: "mcp_gateway",
    });
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible();
    gateway.unmount();

    const profile = renderOverview("llm_proxy", { agentType: "profile" });
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible();
    profile.unmount();

    renderOverview("llm_proxy", { agentType: "llm_proxy" });
    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
  });

  it("shows the published skills only once they have loaded", () => {
    vi.mocked(useFeature).mockReturnValue(
      true as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    // Still loading: an empty default would read as "publishes nothing".
    const loading = renderOverview("agent");
    expect(
      screen.queryByRole("heading", { name: "Published skills" }),
    ).toBeNull();
    loading.unmount();

    vi.mocked(useAgentSkills).mockReturnValue({
      data: {
        accessAllSkills: false,
        skillIds: ["s1"],
        skills: [{ id: "s1", name: "Weekly report" }],
      },
    } as unknown as ReturnType<typeof useAgentSkills>);
    renderOverview("agent");
    expect(
      section("Published skills").getByText("Weekly report"),
    ).toBeInTheDocument();
  });
});
