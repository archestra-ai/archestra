import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewSummary } from "@/components/overview-summary";
import {
  useAgentSkillExclusions,
  useAgentSkills,
} from "@/lib/agent-skills.query";
import { useAgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { useAgentOverviewFacts } from "./agent-overview";
import type { AgentPageKind } from "./agent-page-config";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/agent-tool-exclusions.query", () => ({
  useAgentToolExclusions: vi.fn(),
}));
vi.mock("@/lib/agent-skills.query", () => ({
  useAgentSkills: vi.fn(),
  useAgentSkillExclusions: vi.fn(),
}));
vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));
vi.mock("@/lib/config/config.query", () => ({ useFeature: vi.fn() }));
vi.mock("@/lib/llm-models.query", () => ({ useLlmModels: vi.fn() }));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: vi.fn(),
}));

type Agent = archestraApiTypes.GetAgentResponses["200"];

const baseAgent = {
  id: "a1",
  name: "Support",
  agentType: "agent",
  builtIn: false,
  scope: "personal",
  authorId: "me",
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
  environmentId: null as string | null,
  modelId: null as string | null,
  resolvedLlmModelName: null as string | null,
  resolvedLlmProvider: null as string | null,
  llmApiKeyId: null as string | null,
};

/**
 * The hook drives the page's Overview, so it is exercised through the same
 * component the page renders it with rather than through a bare hook harness.
 */
function Harness({ kind, agent }: { kind: AgentPageKind; agent: Agent }) {
  const facts = useAgentOverviewFacts({ kind, agent });
  return <OverviewSummary headingId="h" facts={facts} />;
}

function renderOverview(
  kind: AgentPageKind,
  overrides: Partial<typeof baseAgent> = {},
) {
  return render(
    <Harness
      kind={kind}
      agent={{ ...baseAgent, ...overrides } as unknown as Agent}
    />,
  );
}

/** The `<dt>`/`<dd>` pair a label names, so assertions can be scoped to it. */
function fact(label: string) {
  const element = screen.getByText(label).parentElement;
  if (!element) throw new Error(`No fact labelled "${label}"`);
  return within(element);
}

function labels() {
  return screen.getAllByRole("term").map((node) => node.textContent);
}

describe("useAgentOverviewFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
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
    vi.mocked(useLlmModels).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useLlmModels>);
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
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

  it("names the model and the key an agent answers with", () => {
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ id: "k1", name: "Team key" }],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    renderOverview("agent", {
      resolvedLlmModelName: "claude-sonnet-5",
      resolvedLlmProvider: "anthropic",
      llmApiKeyId: "k1",
    });

    expect(fact("Model").getByText(/claude-sonnet-5/)).toBeVisible();
    expect(fact("API key").getByText("Team key")).toBeVisible();
  });

  it("falls back to the organization default when the agent has no model", () => {
    renderOverview("agent");

    expect(fact("Model").getByText("Best available model")).toBeVisible();
    expect(fact("API key").getByText("Organization default")).toBeVisible();
  });

  it("names the environment an agent runs in", () => {
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [{ id: "env-1", name: "Production" }] },
    } as unknown as ReturnType<typeof useEnvironments>);
    renderOverview("agent", { environmentId: "env-1" });

    expect(fact("Environment").getByText("Production")).toBeVisible();
  });

  it("counts assigned tools by the servers they come from", () => {
    renderOverview("agent", {
      tools: [
        { id: "t1", catalogId: "c1" },
        { id: "t2", catalogId: "c1" },
        { id: "t3", catalogId: "c2" },
        // Delegation rows belong to subagents, not to the tool count.
        { id: "t4", catalogId: "c3", delegateToAgentId: "sub" },
      ],
    } as unknown as Partial<typeof baseAgent>);

    expect(fact("Tools").getByText("3 from 2 servers")).toBeVisible();
  });

  it("says how many tools Auto has disabled", () => {
    vi.mocked(useAgentToolExclusions).mockReturnValue({
      data: { excludedToolIds: ["t1", "t2"] },
    } as unknown as ReturnType<typeof useAgentToolExclusions>);
    renderOverview("agent", { accessAllTools: true });

    expect(
      fact("Tools").getByText("Auto — all tools, 2 disabled"),
    ).toBeVisible();
  });

  it("stays silent about skills until the published set has loaded", () => {
    vi.mocked(useFeature).mockReturnValue(
      true as unknown as ReturnType<typeof useFeature>,
    );
    renderOverview("mcp_gateway");

    expect(labels()).not.toContain("Published skills");
  });

  it("counts published skills once they have loaded", () => {
    vi.mocked(useFeature).mockReturnValue(
      true as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAgentSkills).mockReturnValue({
      data: { accessAllSkills: false, skills: [{ id: "s1" }, { id: "s2" }] },
    } as unknown as ReturnType<typeof useAgentSkills>);
    renderOverview("mcp_gateway");

    expect(fact("Published skills").getByText("2")).toBeVisible();
  });

  it("says nothing about published skills on an agent, and reads nothing", () => {
    // Publishing over `skill://` is a gateway surface, so the fact belongs on
    // the gateway pages only — even with a published set sitting in the cache.
    vi.mocked(useFeature).mockReturnValue(
      true as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAgentSkills).mockReturnValue({
      data: { accessAllSkills: false, skills: [{ id: "s1" }] },
    } as unknown as ReturnType<typeof useAgentSkills>);
    renderOverview("agent");

    expect(labels()).not.toContain("Published skills");
    expect(useAgentSkills).toHaveBeenCalledWith(undefined);
    expect(useAgentSkillExclusions).toHaveBeenCalledWith(undefined);
  });

  it("leaves a gateway's environment to the page header", () => {
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [{ id: "env-1", name: "Production" }] },
    } as unknown as ReturnType<typeof useEnvironments>);
    renderOverview("mcp_gateway", { environmentId: "env-1" });

    expect(labels()).toEqual(["Tools", "Created by"]);
  });

  it("drops the record-level configuration a built-in agent does not own", () => {
    renderOverview("agent", { builtIn: true });

    // Its model is still its own; the environment and tools are not.
    expect(labels()).toEqual(["Model", "API key"]);
    // Nor a creator: a built-in belongs to nobody, so the fact is absent
    // rather than present-but-empty, which would read as missing data.
    expect(labels()).not.toContain("Created by");
  });
});
