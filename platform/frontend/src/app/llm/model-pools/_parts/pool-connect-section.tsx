"use client";

import { ConnectStep } from "@/components/connect-rail";
import { LlmConnectSteps } from "@/components/llm-connect-steps";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { getProxyBaseUrl } from "@/components/virtual-key-request-example";
import type { ModelPool } from "@/lib/model-pools.query";

/**
 * How clients call a pool: by its name on the Unified Model API, with a
 * virtual key that can call it. The key and request steps are the LLM Proxy
 * page's, with the pool picked as the model.
 */
export function PoolConnectSection({ pool }: { pool: ModelPool }) {
  const connectionBaseUrl = useConnectionBaseUrl();
  return (
    <ol>
      <ConnectStep number={1} title="Endpoint">
        <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
          {getProxyBaseUrl(connectionBaseUrl, { kind: "model-router" })}
        </code>
        <p className="text-sm text-muted-foreground">
          The Unified Model API. Clients ask for {pool.name} as the model, and
          the proxy tries its providers in order.
        </p>
      </ConnectStep>
      <LlmConnectSteps
        firstNumber={2}
        baseUrl={connectionBaseUrl}
        selected="model-router"
        auth="standard"
        targetLabel="Unified Model API"
        pool={pool}
      />
    </ol>
  );
}
