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

  test("agent restore route uses restored action instead of POST create fallback", () => {
    const resolved = resolveAuditableRouteConfig("/api/agents/:id/restore");
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("agent");
    expect(resolved?.cfg.action).toBe("agent.restored");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
  });

  test("skill reset route uses updated action instead of POST create fallback", () => {
    const resolved = resolveAuditableRouteConfig("/api/skills/:id/reset");
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("skill");
    expect(resolved?.cfg.action).toBe("skill.updated");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
  });

  test("connector permission-sync route is registered so its POST is not dropped as a walk-up", () => {
    const resolved = resolveAuditableRouteConfig(
      "/api/connectors/:id/permission-sync",
    );
    // viaWalkUp would make the hook discard the POST entirely (no audit row),
    // and the inherited config would call it a connector creation.
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("connector");
    expect(resolved?.cfg.action).toBe("connector.permission_sync_triggered");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
  });

  test("delegations sync route is registered so its POST is not dropped as a walk-up", () => {
    // POST /api/agents/:agentId/delegations is unregistered → walks up to
    // /api/agents/:agentId → the hook discards POST walk-ups → the record falls
    // to the unknown.created fallback with a null resourceType. Registering it
    // directly pins the correct agent.updated semantics.
    const resolved = resolveAuditableRouteConfig(
      "/api/agents/:agentId/delegations",
    );
    expect(resolved?.viaWalkUp).toBe(false);
    expect(resolved?.cfg.resourceType).toBe("agent");
    expect(resolved?.cfg.action).toBe("agent.updated");
    expect(resolved?.cfg.resourceIdParam).toBe("agentId");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
  });

  test("single-delegation DELETE inherits agent.updated, not agent.deleted", () => {
    // DELETE /api/agents/:agentId/delegations/:targetAgentId walks up. A DELETE
    // walk-up is NOT suppressed, so without the explicit /delegations entry it
    // would inherit /api/agents/:agentId and derive agent.deleted — mislabeling
    // the removal of one delegation as deleting the whole agent.
    const resolved = resolveAuditableRouteConfig(
      "/api/agents/:agentId/delegations/:targetAgentId",
    );
    expect(resolved?.viaWalkUp).toBe(true);
    expect(resolved?.cfg.action).toBe("agent.updated");
    expect(resolved?.cfg.resourceType).toBe("agent");
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
