import { describe, expect, test } from "vitest";
import {
  computeSkillMarketplaceExpiresAt,
  SKILL_MARKETPLACE_CLIENTS,
  type SkillMarketplaceClient,
} from "./skills-marketplace-clients";

const params = {
  cloneUrl: "https://host.example/skills/m/archestra_skl_tok/repo.git",
  marketplaceName: "archestra-acme-skills",
};

function clientById(id: SkillMarketplaceClient["id"]): SkillMarketplaceClient {
  const client = SKILL_MARKETPLACE_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`no marketplace client ${id}`);
  return client;
}

describe("SKILL_MARKETPLACE_CLIENTS install steps", () => {
  test("claude-code registers the clone URL then installs the bundle by name", () => {
    const steps = clientById("claude-code").getInstallSteps(params);
    expect(steps.map((s) => s.code)).toEqual([
      `claude plugin marketplace add ${params.cloneUrl}`,
      `claude plugin install ${params.marketplaceName}@${params.marketplaceName}`,
    ]);
  });

  test("codex registers the clone URL and installs via /plugins", () => {
    const steps = clientById("codex").getInstallSteps(params);
    expect(steps.map((s) => s.code)).toEqual([
      `codex plugin marketplace add ${params.cloneUrl}`,
      "/plugins",
    ]);
  });

  test("copilot-cli registers and browses with copilot commands", () => {
    const steps = clientById("copilot-cli").getInstallSteps(params);
    expect(steps.map((s) => s.code)).toEqual([
      `copilot plugin marketplace add ${params.cloneUrl}`,
      `copilot plugin marketplace browse ${params.marketplaceName}`,
    ]);
  });

  test("cursor adds the plugin by URL and installs from the marketplace view", () => {
    const steps = clientById("cursor").getInstallSteps(params);
    expect(steps[0].code).toBe(`/add-plugin ${params.cloneUrl}`);
    expect(steps[1].code).toBeUndefined();
    expect(steps[1].body).toContain(params.marketplaceName);
  });

  test("every client embeds the clone URL in its first step", () => {
    for (const client of SKILL_MARKETPLACE_CLIENTS) {
      const [first] = client.getInstallSteps(params);
      expect(`${first.code}${first.body ?? ""}`).toContain(params.cloneUrl);
    }
  });
});

describe("computeSkillMarketplaceExpiresAt", () => {
  test("adds the preset days to now", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(computeSkillMarketplaceExpiresAt(30, now)).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  test("null days means no expiration", () => {
    expect(computeSkillMarketplaceExpiresAt(null)).toBeNull();
  });
});
