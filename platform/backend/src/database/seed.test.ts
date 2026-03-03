import { KnowledgeGraphModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("seedKnowledgeGraphFromEnv (via KnowledgeGraphModel.seedFromEnv)", () => {
  test("creates KG when no seeded row exists", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    const result = await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://lightrag:9621", apiKey: "test-key" },
    });

    expect(result.provider).toBe("lightrag");
    expect(result.name).toBe("lightrag (env)");
    expect(result.seededFromEnv).toBe(true);
    expect(result.config).toEqual({
      apiUrl: "http://lightrag:9621",
      apiKey: "test-key",
    });
    expect(result.organizationId).toBe(org.id);
  });

  test("updates existing seeded row config when called again", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // First seed
    await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://old-lightrag:9621" },
    });

    // Second seed with updated config
    const updated = await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://new-lightrag:9621", apiKey: "new-key" },
    });

    expect(updated.config).toEqual({
      apiUrl: "http://new-lightrag:9621",
      apiKey: "new-key",
    });

    // Should still be only one KG
    const kgs = await KnowledgeGraphModel.findByOrganization({
      organizationId: org.id,
    });
    expect(kgs).toHaveLength(1);
  });

  test("does not create a new KG when seededFromEnv row already exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Seed first time
    const first = await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://lightrag:9621" },
    });

    // Seed again with same config
    const second = await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://lightrag:9621" },
    });

    // Should return the same row, not create a new one
    expect(second.id).toBe(first.id);
  });

  test("does not affect non-seeded knowledge graphs", async ({
    makeOrganization,
    makeKnowledgeGraph,
  }) => {
    const org = await makeOrganization();

    // Create a manually created KG (not seeded from env)
    await makeKnowledgeGraph(org.id, {
      name: "Manual KG",
      provider: "lightrag",
      config: { apiUrl: "http://manual:9621" },
    });

    // Seed from env
    await KnowledgeGraphModel.seedFromEnv({
      organizationId: org.id,
      name: "lightrag (env)",
      provider: "lightrag",
      config: { apiUrl: "http://lightrag:9621" },
    });

    // Should have 2 KGs total
    const kgs = await KnowledgeGraphModel.findByOrganization({
      organizationId: org.id,
    });
    expect(kgs).toHaveLength(2);

    // The manual one should be untouched
    const manualKg = kgs.find((kg) => kg.name === "Manual KG");
    expect(manualKg).toBeDefined();
    expect(manualKg?.seededFromEnv).toBe(false);
  });
});

describe("seedKnowledgeGraphFromEnv integration", () => {
  test("seedKnowledgeGraphFromEnv returns early when provider is not set", async () => {
    // Set env var to empty to ensure no provider
    const originalEnv = process.env.ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER;
    delete process.env.ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER;

    try {
      const { seedKnowledgeGraphFromEnv } = await import("./seed");
      // Should return without error (no org lookup needed)
      await seedKnowledgeGraphFromEnv();
    } finally {
      if (originalEnv !== undefined) {
        process.env.ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER = originalEnv;
      }
    }
  });
});
