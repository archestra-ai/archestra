import { randomUUID } from "node:crypto";
import db, { schema } from "@/database";
import type { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import {
  persistNativeCodexHistory,
  validateNativeCodexHistory,
} from "@/services/appa-codex-history";
import {
  recordIssuedResponseItems,
  validateInboundOpaqueItems,
} from "@/services/appa-opaque-history";
import { expect, test } from "@/test";
import type { AppaOpaqueHistoryScope } from "@/types";

test("admits legacy compaction only from issued history and binds its successor window", async () => {
  const { scope, session } = await makeSession();
  const reasoning = {
    type: "reasoning",
    id: "reasoning-issued-by-provider",
    encrypted_content: "issued-reasoning-ciphertext",
  };
  await recordIssuedResponseItems({
    scope,
    mode: "inference",
    sourceWindow: windowRef("window-0", 0, "turn-0"),
    responseItems: [reasoning],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });
  const request = {
    model: scope.model,
    input: [reasoning],
  };

  const history = await validateNativeCodexHistory({
    session,
    request,
    headers: {
      "x-codex-window-id": "window-0",
      "x-codex-turn-metadata": JSON.stringify({
        window_number: 0,
        turn_id: "turn-1",
        compaction: { trigger: "manual" },
      }),
    },
    provider: scope.provider,
    legacyCompact: true,
  });

  expect(history).toMatchObject({
    mode: "compactv1",
    trigger: "manual",
    scope,
    sourceWindow: windowRef("window-0", 0, "turn-1"),
  });

  const compaction = {
    type: "compaction",
    encrypted_content: "issued-compaction-ciphertext",
  };
  await persistNativeCodexHistory({
    history,
    response: { output: [compaction] },
  });

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: windowRef("window-1", 1, "turn-2"),
      items: [compaction],
    }),
  ).resolves.toEqual([compaction]);
});

test("rejects unknown opaque history in a legacy compact request", async () => {
  const { scope, session } = await makeSession();

  await expect(
    validateNativeCodexHistory({
      session,
      request: {
        model: scope.model,
        input: [
          {
            type: "reasoning",
            id: "unissued-reasoning",
            encrypted_content: "unissued-ciphertext",
          },
        ],
      },
      headers: {
        "x-codex-window-id": "window-0",
        "x-codex-turn-metadata": JSON.stringify({
          window_number: 0,
          turn_id: "turn-0",
          compaction: { trigger: "automatic" },
        }),
      },
      provider: scope.provider,
      legacyCompact: true,
    }),
  ).rejects.toThrow("Opaque Codex history has no valid issued binding");
});

test("binds opaque reasoning before the next client tool-result turn", async () => {
  const { scope, session } = await makeSession();
  const issued = {
    type: "reasoning",
    id: "reasoning-before-mcp-call",
    encrypted_content: "provider-issued-ciphertext",
    summary: [],
  };
  await recordIssuedResponseItems({
    scope,
    mode: "inference",
    sourceWindow: windowRef("window-0", 0, "turn-0"),
    responseItems: [issued],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });

  const history = await validateNativeCodexHistory({
    session,
    request: { model: scope.model, input: [issued] },
    headers: {
      "x-codex-window-id": "window-0",
      "x-codex-turn-metadata": JSON.stringify({
        window_number: 0,
        turn_id: "turn-1",
      }),
    },
    provider: scope.provider,
    legacyCompact: false,
  });
  const nextIssued = {
    type: "reasoning",
    id: "reasoning-with-mcp-call",
    encrypted_content: "provider-issued-before-local-failure",
    summary: [],
  };
  await persistNativeCodexHistory({
    history,
    response: { output: [nextIssued] },
  });

  await expect(
    validateNativeCodexHistory({
      session,
      request: {
        model: scope.model,
        input: [issued, nextIssued],
      },
      headers: {
        "x-codex-window-id": "window-0",
        "x-codex-turn-metadata": JSON.stringify({
          window_number: 0,
          turn_id: "turn-2",
        }),
      },
      provider: scope.provider,
      legacyCompact: false,
    }),
  ).resolves.toMatchObject({ scope });
});

async function makeSession(): Promise<{
  scope: AppaOpaqueHistoryScope;
  session: AppaProxyHookSession;
}> {
  const sessionId = randomUUID();
  const ownerScopeHash = `owner-${sessionId}`;
  await db.insert(schema.appaProxySessionsTable).values({
    id: sessionId,
    profileId: randomUUID(),
    ownerScopeHash,
    clientSessionId: `client-${sessionId}`,
    rootId: `root-${sessionId}`,
  });
  const scope = {
    sessionId,
    ownerScopeHash,
    provider: "openai",
    protocol: "codex-responses",
    model: "gpt-test",
  };
  return {
    scope,
    session: {
      getNativeWireScope: () => ({ ...scope, turnId: "turn-0" }),
    } as unknown as AppaProxyHookSession,
  };
}

function windowRef(
  providerWindowId: string,
  frameVersion: number,
  sourceTurnId: string,
) {
  return { providerWindowId, frameVersion, sourceTurnId };
}
