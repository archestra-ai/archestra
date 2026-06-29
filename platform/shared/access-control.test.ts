import { describe, expect, test } from "vitest";
import {
  allAvailableActions,
  editorPermissions,
  memberPermissions,
  permissionDescriptions,
  predefinedPermissionsMap,
  requiredEndpointPermissionsMap,
} from "./access-control";
import {
  type Action,
  internalResources,
  type Resource,
} from "./permission.types";
import { ADMIN_ROLE_NAME } from "./roles";
import { RouteId } from "./routes";

describe("access-control", () => {
  test("every resource:action combination has a permissionDescription", () => {
    const missing: string[] = [];

    for (const resource of Object.keys(allAvailableActions) as Resource[]) {
      if (internalResources.includes(resource)) continue;

      for (const action of allAvailableActions[resource]) {
        const key = `${resource}:${action}`;
        if (!permissionDescriptions[key]) {
          missing.push(key);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("permissionDescriptions has no stale entries", () => {
    const validKeys = new Set<string>();

    for (const resource of Object.keys(allAvailableActions) as Resource[]) {
      for (const action of allAvailableActions[resource]) {
        validKeys.add(`${resource}:${action}`);
      }
    }

    const stale = Object.keys(permissionDescriptions).filter(
      (key) => !validKeys.has(key),
    );

    expect(stale).toEqual([]);
  });

  describe("auditLog resource", () => {
    test("admin role has auditLog:read", () => {
      expect(predefinedPermissionsMap[ADMIN_ROLE_NAME].auditLog).toContain(
        "read",
      );
    });

    test("editor role does not have auditLog:read", () => {
      expect(editorPermissions.auditLog).not.toContain("read");
    });

    test("member role does not have auditLog:read", () => {
      expect(memberPermissions.auditLog).not.toContain("read");
    });

    test("permissionDescriptions has auditLog:read entry", () => {
      expect(permissionDescriptions["auditLog:read"]).toBeDefined();
      expect(permissionDescriptions["auditLog:read"].length).toBeGreaterThan(0);
    });

    test("auditLog only exposes the read action", () => {
      expect(allAvailableActions.auditLog).toEqual(["read"]);
    });
  });

  describe("LLM-spending skill routes", () => {
    // suggestSkillDescription resolves and spends the source agent's configured
    // LLM key, so it must be gated like chatting with the agent — not by the
    // weaker skill:create + agent:read the convert flow uses. Without chat:read,
    // a caller who can only view+convert a shared agent could burn its key.
    test("suggestSkillDescription requires chat:read", () => {
      const required =
        requiredEndpointPermissionsMap[RouteId.SuggestSkillDescription];
      expect(required?.chat).toContain("read");
      expect(required?.skill).toContain("create");
      expect(required?.agent).toContain("read");
    });
  });

  describe("sandbox artifact route", () => {
    // the download_file tool (sandbox:execute) hands out this artifact URL, so
    // the fetch route must require the same permission — otherwise a role that
    // produced an artifact gets a 403 on a URL it just earned.
    test("getSkillSandboxArtifact requires sandbox:execute", () => {
      const required =
        requiredEndpointPermissionsMap[RouteId.GetSkillSandboxArtifact];
      expect(required?.sandbox).toContain("execute");
    });
  });

  describe("MCP server re-authentication route", () => {
    // Returns true when `rolePermissions` covers every resource:action pair the
    // route's RBAC middleware gate demands. Mirrors what hasPermission() does
    // for the requiredEndpointPermissionsMap entry before the handler runs.
    const roleSatisfiesRoute = (
      rolePermissions: Partial<Record<Resource, Action[]>>,
      routeId: RouteId,
    ): boolean => {
      const required = requiredEndpointPermissionsMap[routeId] ?? {};
      return Object.entries(required).every(([resource, actions]) =>
        (actions as Action[]).every((action) =>
          rolePermissions[resource as Resource]?.includes(action),
        ),
      );
    };

    // Re-authentication re-supplies credentials for a connection the caller can
    // already install — it must not demand a stricter permission than install.
    // The handler's own gate (mcp-server.ts) only requires mcpServerInstallation
    // :create and then does scope-aware authorization; if the middleware gate
    // asks for :update instead, members who installed a connection hit a bare
    // 403 the moment their OAuth token expires and they try to re-authenticate.
    test("requires the same install permission as InstallMcpServer", () => {
      expect(
        requiredEndpointPermissionsMap[RouteId.ReauthenticateMcpServer],
      ).toEqual(requiredEndpointPermissionsMap[RouteId.InstallMcpServer]);
    });

    test("is satisfiable by the member role (members can install)", () => {
      // Members can install (and therefore own) connections...
      expect(memberPermissions.mcpServerInstallation).toContain("create");
      // ...so the middleware gate must let them reach the re-auth handler.
      expect(
        roleSatisfiesRoute(memberPermissions, RouteId.ReauthenticateMcpServer),
      ).toBe(true);
    });
  });
});
