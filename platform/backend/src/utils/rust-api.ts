import { type IncomingMessage, request as requestHttp } from "node:http";

export function isRustApiReady(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = requestHttp(
      {
        socketPath,
        path: "/internal/v1/ready",
        method: "POST",
        signal: AbortSignal.timeout(1_000),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.once("error", () => resolve(false));
    request.end();
  });
}

export function callRustApi(params: {
  socketPath: string;
  path:
    | "/internal/v1/audit-logs/list"
    | "/internal/v1/interactions/settle"
    | "/internal/v1/interactions/settle-minute-spend"
    | "/internal/v1/interactions/reconcile-tokens"
    | "/internal/v1/interactions/refund-unsent"
    | "/internal/v1/interactions/admit-throughput"
    | "/internal/v1/interactions/link-session-titles"
    | "/internal/v1/interactions/stamp-agent-use"
    | "/internal/v1/interactions/record-legacy-usage"
    | "/internal/v1/interactions/mark-pool-attempt-failed-over"
    | "/internal/v1/mcp/discover"
    | "/internal/v1/mcp/dispatch"
    | "/internal/v1/mcp/tools/whoami"
    | "/internal/v1/mcp/tools/agent-token-usage"
    | "/internal/v1/mcp/tools/list-teams"
    | "/internal/v1/mcp/tools/create-team"
    | "/internal/v1/mcp/tools/edit-team"
    | "/internal/v1/mcp/tools/delete-team"
    | "/internal/v1/mcp/tools/add-team-member"
    | "/internal/v1/mcp/tools/update-team-member-role"
    | "/internal/v1/mcp/tools/remove-team-member"
    | "/internal/v1/mcp/tools/get-limits"
    | "/internal/v1/mcp/tools/create-limit"
    | "/internal/v1/mcp/tools/update-limit"
    | "/internal/v1/mcp/tools/delete-limit"
    | "/internal/v1/mcp/tools/list-hooks"
    | "/internal/v1/mcp/tools/create-hook"
    | "/internal/v1/mcp/tools/update-hook"
    | "/internal/v1/mcp/tools/delete-hook"
    | "/internal/v1/mcp/tools/get-agent"
    | "/internal/v1/mcp/tools/remove-agent-tool"
    | "/internal/v1/mcp/tools/assign-agent-tool"
    | "/internal/v1/mcp/tools/patch-agent-skill-policy"
    | "/internal/v1/mcp/tools/set-app-lock"
    | "/internal/v1/mcp/tools/set-app-tools"
    | "/internal/v1/mcp/tools/set-app-labels"
    | "/internal/v1/mcp/tools/scaffold-app"
    | "/internal/v1/mcp/tools/edit-app"
    | "/internal/v1/mcp/tools/refine-app"
    | "/internal/v1/mcp/tools/publish-app"
    | "/internal/v1/mcp/tools/delete-app"
    | "/internal/v1/mcp/tools/edit-mcp-description"
    | "/internal/v1/mcp/tools/edit-mcp-config"
    | "/internal/v1/mcp/tools/create-mcp-server"
    | "/internal/v1/mcp/tools/deploy-mcp-server"
    | "/internal/v1/mcp/tools/reload-mcp-server-tools"
    | "/internal/v1/mcp/tools/get-agent-by-name"
    | "/internal/v1/mcp/tools/create-agent"
    | "/internal/v1/mcp/tools/edit-agent"
    | "/internal/v1/mcp/tools/create-gateway"
    | "/internal/v1/mcp/tools/gateway-version"
    | "/internal/v1/mcp/tools/enable-gateway-all-tools"
    | "/internal/v1/mcp/tools/edit-gateway"
    | "/internal/v1/mcp/tools/edit-gateway-assignments"
    | "/internal/v1/mcp/tools/assign-gateway-delegation"
    | "/internal/v1/mcp/tools/get-project"
    | "/internal/v1/mcp/tools/link-project-app"
    | "/internal/v1/mcp/tools/unlink-project-app"
    | "/internal/v1/mcp/tools/list-projects"
    | "/internal/v1/mcp/tools/get-llm-interaction"
    | "/internal/v1/mcp/tools/list-llm-interactions"
    | "/internal/v1/mcp/tools/list-llm-sessions"
    | "/internal/v1/mcp/tools/get-llm-session-logs"
    | "/internal/v1/mcp/tools/list-llm-models"
    | "/internal/v1/mcp/tools/get-knowledge-base"
    | "/internal/v1/mcp/tools/delete-knowledge-base"
    | "/internal/v1/mcp/tools/update-knowledge-base"
    | "/internal/v1/mcp/tools/create-knowledge-base"
    | "/internal/v1/mcp/tools/get-knowledge-connector"
    | "/internal/v1/mcp/tools/delete-knowledge-connector"
    | "/internal/v1/mcp/tools/update-knowledge-connector"
    | "/internal/v1/mcp/tools/create-knowledge-connector"
    | "/internal/v1/mcp/tools/assign-connector-to-knowledge-base"
    | "/internal/v1/mcp/tools/unassign-connector-from-knowledge-base"
    | "/internal/v1/mcp/tools/assign-knowledge-base-to-agent"
    | "/internal/v1/mcp/tools/unassign-knowledge-base-from-agent"
    | "/internal/v1/mcp/tools/assign-connector-to-agent"
    | "/internal/v1/mcp/tools/unassign-connector-from-agent"
    | "/internal/v1/mcp/tools/get-knowledge-connectors"
    | "/internal/v1/mcp/tools/get-knowledge-bases"
    | "/internal/v1/mcp/tools/get-schedule-trigger-run"
    | "/internal/v1/mcp/tools/get-schedule-trigger-run-transcript"
    | "/internal/v1/mcp/tools/condense-schedule-transcript"
    | "/internal/v1/mcp/tools/get-schedule-trigger"
    | "/internal/v1/mcp/tools/create-schedule-trigger"
    | "/internal/v1/mcp/tools/update-schedule-trigger"
    | "/internal/v1/mcp/tools/delete-schedule-trigger"
    | "/internal/v1/mcp/tools/create-manual-schedule-run"
    | "/internal/v1/mcp/tools/list-schedule-triggers"
    | "/internal/v1/mcp/tools/list-schedule-trigger-runs"
    | "/internal/v1/mcp/tools/list-team-members"
    | "/internal/v1/mcp/tools/list-team-external-groups"
    | "/internal/v1/mcp/tools/add-team-external-group"
    | "/internal/v1/mcp/tools/remove-team-external-group"
    | "/internal/v1/openai/policy-finalizer"
    | "/internal/v1/openai/policy-order"
    | "/internal/v1/openai/runtime-proof"
    | "/internal/v1/openai/runtime-proof-attachment"
    | "/internal/v1/openai/delegation-proof"
    | "/internal/v1/openai/delegation-attachment"
    | "/internal/v1/openai/tool-release"
    | "/internal/v1/openai/policy-sse"
    | "/internal/v1/openai/receipt-prefix-sse"
    | "/internal/v1/openai/terminal-sse"
    | "/internal/v1/site-notification/replace";
  json: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        socketPath: params.socketPath,
        method: "POST",
        path: params.path,
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
      },
      (response) => {
        readBody(response).then(resolve, reject);
      },
    );
    request.on("error", reject);
    request.end(params.json);
  });
}

async function readBody(response: IncomingMessage): Promise<unknown> {
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`Rust API returned HTTP ${response.statusCode}`);
  }
  response.setEncoding("utf8");
  let body = "";
  for await (const chunk of response) {
    body += chunk;
  }
  return JSON.parse(body);
}
