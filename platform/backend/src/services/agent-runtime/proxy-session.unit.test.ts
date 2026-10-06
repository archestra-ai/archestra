import { expect, test } from "vitest";
import { runtimeProxySession } from "./proxy-session";

test("a personal runtime key uses the user identity rather than its key ID", () => {
  const session = runtimeProxySession({
    organizationId: "org",
    virtualApiKeyId: "key",
    workspaceId: "workspace",
    actor: { kind: "user", id: "alice", organizationId: "org" },
  });
  expect(session).toEqual({
    organization_id: "org",
    caller_id: "user:alice",
    session_id: "user:alice|workspace",
  });
});

test("system and team runtime keys remain credential scoped", () => {
  for (const actor of [
    { kind: "system" as const, id: "system", organizationId: "org" },
    { kind: "team" as const, id: "team", organizationId: "org" },
  ]) {
    const session = runtimeProxySession({
      organizationId: "org",
      virtualApiKeyId: "key",
      workspaceId: "workspace",
      actor,
    });
    expect(session.caller_id).toBe("virtual-key:key");
    expect(session.session_id).toBe("virtual-key:key|workspace");
  }
});
