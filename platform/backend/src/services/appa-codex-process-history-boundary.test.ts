import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import {
  type AppaProxyHookConfig,
  AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  normalizeNativeCodexProcessHistory,
  restoreNativeCodexClientProcessCalls,
} from "./appa-codex-process-routing";

const runtimeUrl = "http://native-process-history.test";
const hookUrl = `${runtimeUrl}/hook`;
const hookConfig: AppaProxyHookConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  nativeCodexEnabled: true,
  sessionHmacSecret: "native-process-history-test-key".repeat(3),
};

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper, not React
const server = useMswServer();

beforeEach(() => {
  config.llmProxy.appaHook = hookConfig;
  server.use(
    http.post(hookUrl, async ({ request }) => {
      const event = (await request.json()) as { event: string };
      return HttpResponse.json({
        decision: event.event === "tool_call" ? "allow_call" : "ack",
      });
    }),
  );
});

describe("native Codex process history boundary", () => {
  test("keeps proxy handles in history while returning local client call arguments", async () => {
    const profileId = randomUUID();
    const ownerScopeHash = `native-process-history-owner-${randomUUID()}`;
    const clientSessionId = `native-process-history-thread-${randomUUID()}`;
    const execArguments = '{"cmd":"sleep 1"}';
    const first = await open({
      profileId,
      ownerScopeHash,
      clientSessionId,
    });
    await first.authorizeOutboundToolCalls([
      outbound({
        id: "call_exec",
        name: "functions.exec_command",
        arguments: execArguments,
      }),
    ]);
    await first.finish();

    const second = await open({
      profileId,
      ownerScopeHash,
      clientSessionId,
      toolResults: [
        {
          id: "call_exec",
          content:
            "Wall time: 0.0500 seconds\nProcess running with session ID 1234\nOutput:\n",
          claimedCall: {
            name: "functions.exec_command",
            rawArguments: execArguments,
          },
        },
      ],
    });
    const proxySessionId = Number(
      (
        await AppaProxyWireModel.listIssuedAliases(second.getNativeWireScope())
      ).find(
        (alias) => alias.kind === "process" && alias.logicalId === "call_exec",
      )?.wireId,
    );
    expect(proxySessionId).toBeLessThan(0);
    const proxyArguments = JSON.stringify({
      session_id: proxySessionId,
      chars: "",
    });
    await second.authorizeOutboundToolCalls([
      outbound({
        id: "call_write",
        name: "functions.write_stdin",
        arguments: proxyArguments,
      }),
    ]);

    const request = {
      input: [
        {
          type: "function_call",
          call_id: "call_write",
          name: "write_stdin",
          arguments: '{"session_id":1234,"chars":""}',
        },
      ],
    };
    await normalizeNativeCodexProcessHistory({
      scope: second.getNativeWireScope(),
      request,
    });
    expect(request.input[0]?.arguments).toBe(proxyArguments);

    await expect(
      restoreNativeCodexClientProcessCalls({
        scope: second.getNativeWireScope(),
        calls: [{ name: "functions.write_stdin", arguments: proxyArguments }],
      }),
    ).resolves.toEqual([
      {
        name: "functions.write_stdin",
        arguments: '{"session_id":1234,"chars":""}',
      },
    ]);
    await second.finish();
  });
});

function open(params: {
  profileId: string;
  ownerScopeHash: string;
  clientSessionId: string;
  toolResults?: Parameters<typeof AppaProxyHookSession.open>[0]["toolResults"];
}) {
  return AppaProxyHookSession.open({
    config: hookConfig,
    profileId: params.profileId,
    ownerScopeHash: params.ownerScopeHash,
    clientSessionId: params.clientSessionId,
    modelInput: { input: "continue" },
    toolResults: params.toolResults ?? [],
  });
}

function outbound(params: { id: string; name: string; arguments: string }) {
  return {
    id: params.id,
    emittedName: params.name,
    emittedArguments: params.arguments,
    emittedArgumentsCanonical: canonicalJsonObject(params.arguments),
    targetName: params.name,
    targetArguments: JSON.parse(params.arguments) as Record<string, unknown>,
  };
}
