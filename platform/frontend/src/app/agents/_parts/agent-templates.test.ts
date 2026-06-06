import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATES,
  type AgentTemplate,
  buildCreateAgentBodyFromTemplate,
  getAgentTemplateById,
} from "./agent-templates";

function firstTemplate(): AgentTemplate {
  const [template] = AGENT_TEMPLATES;
  if (!template) throw new Error("AGENT_TEMPLATES is empty");
  return template;
}

describe("AGENT_TEMPLATES", () => {
  it("exposes a non-empty catalog", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has required, non-empty fields on every template", () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name.trim().length > 0).toBe(true);
      expect(t.description.trim().length > 0).toBe(true);
      expect(t.category.trim().length > 0).toBe(true);
      expect(t.systemPrompt.trim().length > 20).toBe(true);
      expect(Array.isArray(t.suggestedPrompts)).toBe(true);
      for (const s of t.recommendedMcpServers) {
        expect(s.name.trim().length > 0).toBe(true);
        expect(s.catalogName.trim().length > 0).toBe(true);
      }
    }
  });
});

describe("buildCreateAgentBodyFromTemplate", () => {
  it("maps a template to a create-agent body with sensible defaults", () => {
    const template = firstTemplate();
    const body = buildCreateAgentBodyFromTemplate(template);
    expect(body.name).toBe(template.name);
    expect(body.agentType).toBe("agent");
    expect(body.systemPrompt).toBe(template.systemPrompt);
    expect(body.icon).toBe(template.icon);
    expect(body.scope).toBe("personal");
  });

  it("respects an overridden name and scope", () => {
    const body = buildCreateAgentBodyFromTemplate(firstTemplate(), {
      name: "  My Reviewer  ",
      scope: "org",
    });
    expect(body.name).toBe("My Reviewer");
    expect(body.scope).toBe("org");
  });

  it("falls back to the template name when the override is blank", () => {
    const template = firstTemplate();
    const body = buildCreateAgentBodyFromTemplate(template, { name: "   " });
    expect(body.name).toBe(template.name);
  });
});

describe("getAgentTemplateById", () => {
  it("finds a known template", () => {
    const template = firstTemplate();
    expect(getAgentTemplateById(template.id)?.id).toBe(template.id);
  });

  it("returns undefined for an unknown id", () => {
    expect(getAgentTemplateById("does-not-exist")).toBeUndefined();
  });
});
