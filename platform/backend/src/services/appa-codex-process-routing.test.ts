import { randomUUID } from "node:crypto";
import { beforeEach, describe } from "vitest";
import config from "@/config";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { expect, test } from "@/test";
import {
  persistNativeCodexProcessRoute,
  restoreNativeCodexProcessRoute,
} from "./appa-codex-process-routing";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://appa.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-process-route-test-key".repeat(3),
  };
});

describe("native Codex process routing", () => {
  test("persists an encrypted route before exposing a proxy process handle", async () => {
    const scope = await openScope();
    const output =
      "Wall time: 0.0500 seconds\nProcess running with session ID 1234\nOutput:\nlocal output\n";

    const route = await persistNativeCodexProcessRoute({
      scope,
      sourceCallId: "call-exec-1",
      output,
    });

    expect(route.proxySessionId).toBeLessThan(0);
    expect(route.output).toContain(
      `Process running with session ID ${route.proxySessionId}`,
    );
    expect(route.output).toContain("Output:\nlocal output");

    const [alias] = await AppaProxyWireModel.listIssuedAliases(scope);
    expect(alias).toMatchObject({
      kind: "process",
      wireId: String(route.proxySessionId),
      logicalId: "call-exec-1",
      metadata: {
        purpose: "native_process_handle_correlation",
        localSessionId: 1234,
      },
    });
    expect(alias.metadataCiphertext).not.toContain("1234");
  });

  test("restores only the issued proxy handle and keeps retries stable", async () => {
    const scope = await openScope();
    const output =
      "Wall time: 0.0500 seconds\nProcess running with session ID 1234\nOutput:\n";
    const first = await persistNativeCodexProcessRoute({
      scope,
      sourceCallId: "call-exec-1",
      output,
    });
    const replay = await persistNativeCodexProcessRoute({
      scope,
      sourceCallId: "call-exec-1",
      output,
    });

    expect(replay.proxySessionId).toBe(first.proxySessionId);
    await expect(
      restoreNativeCodexProcessRoute({
        scope,
        arguments: JSON.stringify({
          session_id: first.proxySessionId,
          chars: "status\n",
        }),
      }),
    ).resolves.toBe(JSON.stringify({ session_id: 1234, chars: "status\n" }));
    await expect(
      restoreNativeCodexProcessRoute({
        scope,
        arguments: JSON.stringify({ session_id: 1234, chars: "status\n" }),
      }),
    ).rejects.toThrow("must use a proxy process handle");
    await expect(
      restoreNativeCodexProcessRoute({
        scope,
        arguments: JSON.stringify({ session_id: -7, chars: "status\n" }),
      }),
    ).rejects.toThrow("not an issued owned correlation");
  });

  test("does not route a terminal or malformed client result", async () => {
    const scope = await openScope();

    await expect(
      persistNativeCodexProcessRoute({
        scope,
        sourceCallId: "call-exec-1",
        output:
          "Wall time: 0.0500 seconds\nProcess exited with code 0\nOutput:\n",
      }),
    ).rejects.toThrow("no verified live local handle");
    await expect(
      persistNativeCodexProcessRoute({
        scope,
        sourceCallId: "call-exec-1",
        output: "unstructured local output",
      }),
    ).rejects.toThrow("no verified live local handle");
    expect(await AppaProxyWireModel.listIssuedAliases(scope)).toEqual([]);
  });
});

async function openScope() {
  const ownerScopeHash = `native-process-route-owner-${randomUUID()}`;
  const turn = await AppaProxySessionModel.enterTurn({
    profileId: randomUUID(),
    ownerScopeHash,
    clientSessionId: randomUUID(),
    rootId: `native-process-route:${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 100,
  });
  return {
    sessionId: turn.session.id,
    ownerScopeHash,
    turnId: turn.turnId,
  };
}
