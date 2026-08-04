import { describe, expect, test } from "vitest";
import {
  adminPermissions,
  allAvailableActions,
  buildForbiddenErrorMessage,
  editorPermissions,
  findUngrantablePermissions,
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
      expect(allAvailableActions.auditLog).toEqual(["read", "admin"]);
    });
  });

  describe("MCP deleted-resource lifecycle (manage-deleted)", () => {
    // Soft-deleted MCP servers and catalog entries are viewable and restorable
    // only through the dedicated manage-deleted capability. Of the predefined
    // roles only admin holds it — delete (which members hold for their own
    // uninstalls) must not unlock the org-wide tombstone view.
    test("admin role has manage-deleted on both MCP resources", () => {
      const admin = predefinedPermissionsMap[ADMIN_ROLE_NAME];
      expect(admin.mcpServerInstallation).toContain("manage-deleted");
      expect(admin.mcpRegistry).toContain("manage-deleted");
    });

    test("editor role does not have manage-deleted", () => {
      expect(editorPermissions.mcpServerInstallation).not.toContain(
        "manage-deleted",
      );
      expect(editorPermissions.mcpRegistry).not.toContain("manage-deleted");
    });

    test("member role does not have manage-deleted", () => {
      expect(memberPermissions.mcpServerInstallation).not.toContain(
        "manage-deleted",
      );
      expect(memberPermissions.mcpRegistry).not.toContain("manage-deleted");
    });

    test("restore routes require manage-deleted", () => {
      expect(requiredEndpointPermissionsMap[RouteId.RestoreMcpServer]).toEqual({
        mcpServerInstallation: ["manage-deleted"],
      });
      expect(
        requiredEndpointPermissionsMap[RouteId.RestoreInternalMcpCatalogItem],
      ).toEqual({
        mcpRegistry: ["manage-deleted"],
      });
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

  describe("complete-onboarding route", () => {
    // Completing onboarding flips the org-wide onboardingComplete flag, so it
    // must require admin-level organizationSettings:update, not merely
    // authentication — otherwise any member could flip it.
    test("CompleteOnboarding requires organizationSettings:update", () => {
      const required =
        requiredEndpointPermissionsMap[RouteId.CompleteOnboarding];
      expect(required?.organizationSettings).toContain("update");
    });

    test("the member role cannot complete onboarding", () => {
      expect(memberPermissions.organizationSettings).not.toContain("update");
    });

    test("GetOrganization stays authenticated-only", () => {
      expect(requiredEndpointPermissionsMap[RouteId.GetOrganization]).toEqual(
        {},
      );
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

  describe("project file routes", () => {
    // Project file surfaces combine project-level access with the files gate;
    // the sandbox permission is reserved for actual sandbox execution
    // (run_command/upload_file/download_file).
    test("GetProjectFiles requires project:read + file:manage, not sandbox:execute", () => {
      const required = requiredEndpointPermissionsMap[RouteId.GetProjectFiles];
      expect(required?.project).toContain("read");
      expect(required?.file).toContain("manage");
      expect(required?.sandbox).toBeUndefined();
    });

    test("UploadProjectFiles requires project:read + file:manage, not sandbox:execute", () => {
      const required =
        requiredEndpointPermissionsMap[RouteId.UploadProjectFiles];
      expect(required?.project).toContain("read");
      expect(required?.file).toContain("manage");
      expect(required?.sandbox).toBeUndefined();
    });

    test("all predefined roles have file:manage", () => {
      for (const permissions of Object.values(predefinedPermissionsMap)) {
        expect(permissions.file).toContain("manage");
      }
    });
  });

  describe("conversation soft-delete routes", () => {
    // Restore is the inverse of delete, and listing the trash is part of the
    // delete/restore lifecycle — both gate on chat:delete so a chat:read-only
    // role can see active chats but neither the trash nor the restore action.
    test("RestoreChatConversation requires chat:delete", () => {
      expect(
        requiredEndpointPermissionsMap[RouteId.RestoreChatConversation]?.chat,
      ).toEqual(["delete"]);
    });

    test("GetDeletedChatConversations requires chat:delete", () => {
      expect(
        requiredEndpointPermissionsMap[RouteId.GetDeletedChatConversations]
          ?.chat,
      ).toEqual(["delete"]);
    });

    test("the member role can restore and view trashed chats (members can delete)", () => {
      expect(memberPermissions.chat).toContain("delete");
    });

    // Pin the intended divergence from the active-list sibling: a live 403 for a
    // chat:read-only caller isn't reachable in the chat route tests (that harness
    // injects request.user and skips the RBAC middleware), so enforcement is
    // proven generically in the middleware tests. Here we lock the map contract
    // that makes it bite — the trash/restore routes must gate on delete, NOT
    // read, so they never collapse to the same gate as GetChatConversations.
    test("GetChatConversations (the active list) still gates on chat:read", () => {
      expect(
        requiredEndpointPermissionsMap[RouteId.GetChatConversations]?.chat,
      ).toEqual(["read"]);
    });

    test("trash/restore routes do NOT gate on chat:read (divergence from the active list)", () => {
      expect(
        requiredEndpointPermissionsMap[RouteId.GetDeletedChatConversations]
          ?.chat,
      ).not.toContain("read");
      expect(
        requiredEndpointPermissionsMap[RouteId.RestoreChatConversation]?.chat,
      ).not.toContain("read");
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

describe("buildForbiddenErrorMessage", () => {
  test("names the blocked action and the missing permission with its description", () => {
    expect(
      buildForbiddenErrorMessage({
        routeId: RouteId.UploadProjectFiles,
        missingPermissions: { file: ["manage"] },
      }),
    ).toBe(
      "You don't have permission to upload project files. Missing permission: file:manage (List, read, write, and delete files in chats and projects).",
    );
  });

  test("keeps acronyms readable when humanizing the route id", () => {
    expect(buildForbiddenErrorMessage({ routeId: "getMcpServerLogs" })).toBe(
      "You don't have permission to get MCP server logs.",
    );
  });

  test("lists multiple missing permissions in stable order", () => {
    const message = buildForbiddenErrorMessage({
      missingPermissions: { project: ["read"], file: ["manage"] },
    });
    expect(message).toContain("Missing permissions:");
    expect(message).toContain(
      "file:manage (List, read, write, and delete files in chats and projects)",
    );
    expect(message).toContain(
      "project:read (View projects and your own chats inside them)",
    );
    expect(message.indexOf("file:manage")).toBeLessThan(
      message.indexOf("project:read"),
    );
  });

  test("degrades to a generic sentence without route or permissions", () => {
    expect(buildForbiddenErrorMessage({})).toBe(
      "You don't have permission to perform this action.",
    );
  });
});

describe("own-vs-all log split (log/auditLog read vs admin)", () => {
  test("read and admin are distinct actions on both resources", () => {
    expect(allAvailableActions.log).toEqual(["read", "admin"]);
    expect(permissionDescriptions["log:admin"]).toBeTruthy();
    expect(permissionDescriptions["auditLog:admin"]).toBeTruthy();
  });

  test("editor sees only own logs; member has neither log resource", () => {
    expect(editorPermissions.log).toEqual(["read"]);
    expect(editorPermissions.auditLog).toEqual([]);
    expect(memberPermissions.log).toEqual([]);
    expect(memberPermissions.auditLog).toEqual([]);
  });
});

describe("platform_admin predefined role", () => {
  test("holds everything except log:admin, auditLog:admin, and member:impersonate", () => {
    const p = predefinedPermissionsMap.platform_admin;
    expect(p.log).toEqual(["read"]);
    expect(p.auditLog).toEqual(["read"]);
    expect(p.member).not.toContain("impersonate");
    // …and is otherwise the full admin set (modulo the UI-behavior resource).
    for (const [resource, actions] of Object.entries(allAvailableActions)) {
      if (["log", "auditLog", "member", "simpleView"].includes(resource)) {
        continue;
      }
      expect(p[resource as keyof typeof p]).toEqual(actions);
    }
  });

  test("cannot grant the withheld permissions (no-escalation rule)", () => {
    const p = predefinedPermissionsMap.platform_admin;
    expect(findUngrantablePermissions(p, adminPermissions)).toEqual(
      expect.arrayContaining([
        "log:admin",
        "auditLog:admin",
        "member:impersonate",
      ]),
    );
    // …while granting its own role or member stays possible.
    expect(findUngrantablePermissions(p, p)).toEqual([]);
    expect(findUngrantablePermissions(p, memberPermissions)).toEqual([]);
  });
});
