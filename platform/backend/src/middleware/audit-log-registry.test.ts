import { describe, expect, test } from "vitest";
import {
  AUDITABLE_ROUTES,
  resolveAuditableRouteConfig,
} from "./audit-log-registry";

/**
 * Contract: resolveAuditableRouteConfig
 * - Exact match → { cfg, viaWalkUp: false }
 * - Walk-up match → { cfg, viaWalkUp: true } with the parent's config
 * - No match → undefined
 */
describe("resolveAuditableRouteConfig", () => {
  test("exact match returns viaWalkUp=false", () => {
    // /api/agents/:id is registered directly
    const resolved = resolveAuditableRouteConfig("/api/agents/:id");
    expect(resolved).not.toBeUndefined();
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("agent");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
  });

  test("exact match for explicitly registered child route returns viaWalkUp=false", () => {
    // /api/agents/:agentId/tools/:toolId is registered explicitly to prevent walk-up
    const resolved = resolveAuditableRouteConfig(
      "/api/agents/:agentId/tools/:toolId",
    );
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("agentTool");
    expect(resolved?.cfg.resourceIdParam).toBe("toolId");
  });

  test("walk-up match returns viaWalkUp=true with the parent config", () => {
    // /api/mcp_server/:id/some-subroute is not registered; walks up to /api/mcp_server/:id
    const resolved = resolveAuditableRouteConfig(
      "/api/mcp_server/:id/some-subroute",
    );
    expect(resolved).not.toBeUndefined();
    expect(resolved?.viaWalkUp).toBe(true);
    expect(resolved?.cfg).toBe(AUDITABLE_ROUTES["/api/mcp_server/:id"]);
    expect(resolved?.cfg.resourceType).toBe("mcpServer");
  });

  test("walk-up match two levels deep returns viaWalkUp=true", () => {
    // /api/connectors/:id/knowledge-bases has no direct entry; inherits connector
    const resolved = resolveAuditableRouteConfig(
      "/api/connectors/:id/knowledge-bases",
    );
    expect(resolved?.viaWalkUp).toBe(true);
    expect(resolved?.cfg.resourceType).toBe("connector");
  });

  test("no match returns undefined", () => {
    expect(resolveAuditableRouteConfig("/api/unrelated-route")).toBeUndefined();
    expect(resolveAuditableRouteConfig("/api/unrelated/:id")).toBeUndefined();
  });

  test("undefined input returns undefined", () => {
    expect(resolveAuditableRouteConfig(undefined)).toBeUndefined();
  });
});
