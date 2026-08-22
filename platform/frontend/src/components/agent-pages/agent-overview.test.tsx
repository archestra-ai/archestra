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
import { useHasPermissions } from "@/lib/auth/auth.query";
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
vi.mock("@/lib/agent.query", () => ({ useDelegationTargetAgents: vi.fn() }));
vi.mock("@/lib/agent-skills.query", () => ({
  useAgentSkills: vi.fn(),
  useAgentSkillExclusions: vi.fn(),
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
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [] },
    } as unknown as ReturnType<typeof useEnvironments>);
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

  it("opens with what the agent answers with, and nests card headings below the page group", () => {
    renderOverview("agent", {
      labels: [{ key: "team", value: "support" }],
    } as unknown as Partial<typeof baseAgent>);

    const facts = section("Model and environment");
    expect(facts.getByText("Model")).toBeVisible();
    expect(facts.getByText("Environment")).toBeVisible();

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((el) => el.textContent),
    ).toEqual([
      "Model and environment",
      "Tools and knowledge sources",
      "Subagents",
    ]);
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  it("omits the Instruction card when no instruction is configured", () => {
    renderOverview("agent", {
      systemPrompt: "   ",
    } as unknown as Partial<typeof baseAgent>);

    expect(screen.queryByRole("heading", { name: "Instruction" })).toBeNull();
    expect(screen.queryByText("None — platform defaults apply.")).toBeNull();
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
    expect(field("API key").getByText("Organization default")).toBeVisible();
    expect(model.getByText("Anthropic · Claude Sonnet")).toBeVisible();
    // The form's model pill carries the provider's logo; so does this one.
    expect(model.getByRole("img", { name: /anthropic logo/i })).toBeVisible();
  });

  it("shows the fallback model as a value without explanatory prose", () => {
    renderOverview("agent");
    const model = field("Model");
    expect(model.getByText("Best available model")).toBeVisible();
    expect(field("API key").getByText("Organization default")).toBeVisible();
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
    expect(model.getByText("OpenAI · GPT-5")).toBeVisible();
    expect(model.getByRole("img", { name: /openai logo/i })).toBeVisible();
    expect(field("API key").getByText("Team OpenAI key")).toBeVisible();
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

  it("summarizes assigned tools by MCP server without listing individual tools", () => {
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
    expect(tools.queryByText("create_issue")).toBeNull();
    expect(tools.queryByText("list_issues")).toBeNull();
    expect(tools.queryByText("delegate_to_researcher")).toBeNull();
    // The server has a page; individual tools stay in the editor wizard.
    expect(tools.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "/mcp/registry/cat-1",
    );
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

  it("shows Auto mode with its progressive-loading state", () => {
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: { excludedToolIds: ["x1", "x2"] },
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
    renderOverview("agent", {
      accessAllTools: true,
      toolExposureMode: "search_and_run_only",
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
    expect(tools.queryByText("Tool connections")).toBeNull();
    expect(tools.getAllByRole("link", { name: /Learn more/ })).toHaveLength(1);
  });

  it("does not surface environment-wide knowledge sources in Auto mode", () => {
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
    expect(tools.queryByText("Knowledge sources")).toBeNull();
    expect(tools.queryByText("Handbook")).toBeNull();
    expect(tools.queryByText("Tickets")).toBeNull();
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

  it("omits knowledge status when no custom source is assigned", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(false);
    renderOverview("agent", { accessAllTools: true });

    const tools = section("Tools and knowledge sources");
    expect(tools.queryByText("Knowledge sources")).toBeNull();
    expect(tools.queryByText(/Knowledge search is off/)).toBeNull();
  });

  it("shows the Custom-mode progressive-loading state with its docs link", () => {
    renderOverview("agent", {
      toolExposureMode: "search_and_run_only",
    });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Tools loaded")).toBeInTheDocument();
    expect(tools.getByText("Progressively")).toBeInTheDocument();
    expect(tools.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
      "href",
      expect.stringContaining("#load-tools-when-needed"),
    );
    expect(tools.queryByText("Tool connections")).toBeNull();
  });

  it("names upfront loading as a value", () => {
    renderOverview("agent", {
      toolExposureMode: "full",
    });

    const tools = section("Tools and knowledge sources");
    expect(tools.getByText("Tools loaded")).toBeInTheDocument();
    expect(tools.getByText("Upfront")).toBeInTheDocument();
    expect(tools.queryByText("Off")).toBeNull();
    expect(tools.queryByText("Tool connections")).toBeNull();
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
    renderOverview("agent", {
      tools: [
        {
          id: "delegate-researcher",
          name: "delegate_to_researcher",
          catalogId: null,
          delegateToAgentId: "a2",
        },
        {
          id: "delegate-advisor",
          name: "delegate_to_advisor",
          catalogId: null,
          delegateToAgentId: "advisor",
        },
      ],
    } as unknown as Partial<typeof baseAgent>);

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
    expect(subagents.queryByText("None")).toBeNull();
    expect(
      subagents.queryByRole("link", { name: /Advisor settings/ }),
    ).toBeNull();
  });

  it("omits agent-only Subagents from gateways, legacy profiles, and LLM proxies", () => {
    const gateway = renderOverview("mcp_gateway", {
      agentType: "mcp_gateway",
    });
    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
    gateway.unmount();

    const profile = renderOverview("llm_proxy", { agentType: "profile" });
    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
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
