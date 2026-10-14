// biome-ignore-all lint/suspicious/noConsole: operator CLI; stdout is the MCP protocol once serving
/**
 * Opt-in local stdio MCP executor. The operator binds one workspace, task id,
 * expiry, and closed git operations at launch. Tool inputs cannot choose
 * those. There is no shell fallback and no test operation.
 *
 * From backend/:
 *   node --import ./node_modules/tsx/dist/esm/index.mjs \
 *     src/standalone-scripts/openappa-dev-tools.ts \
 *     --workspace <abs> --task-id <id> --expires <UTC> \
 *     --allow git_status,git_diff_summary,git_log --bwrap <abs>
 *
 * Print the Claude per-process config (stdout) with --print-mcp-config and
 * the same launch flags. Print the opt-in policy snippet with --print-policy.
 * Claude must load that config with --strict-mcp-config. The server key
 * openappa-dev selects the static policy contracts; it does not attest which
 * binary is installed. Trust is this operator-launched process and the client
 * harness that inherits its stdio. Renaming the key drops the contracts back
 * to the catch-all.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BoundScope,
  bindLaunchScope,
  buildClaudeMcpConfig,
  canonicalToolName,
  claudeToolName,
  closeBoundScope,
  DEV_OPERATIONS,
  DEV_SERVER_NAME,
  DevelopmentExecutorError,
  type DevOperation,
  executeOperation,
  type LaunchScope,
  POLICY_SNIPPET,
  parseLaunchArgs,
  planOperation,
  rejectToolInput,
  resolveTsxLoader,
  verifyIsolation,
} from "../openappa/development-executor";

const scriptPath = fileURLToPath(import.meta.url);
const emptyInput = z.object({}).strict();

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--print-policy")) {
    if (argv.length !== 1) {
      console.error(
        "[openappa-dev-tools] --print-policy takes no other arguments",
      );
      return 1;
    }
    process.stdout.write(POLICY_SNIPPET);
    return 0;
  }
  const printConfig = argv.includes("--print-mcp-config");
  const printPlan = argv.includes("--print-plan");
  const launchArgv = argv.filter(
    (token) => token !== "--print-mcp-config" && token !== "--print-plan",
  );
  let launch: LaunchScope;
  try {
    launch = parseLaunchArgs(launchArgv);
  } catch (error) {
    console.error(`[openappa-dev-tools] ${safeMessage(error)}`);
    return 1;
  }
  if (printConfig || printPlan) {
    console.error(
      DEV_OPERATIONS.map(
        (operation) =>
          `${claudeToolName(operation)} ${canonicalToolName(operation)}`,
      ).join("\n"),
    );
  }
  if (printConfig) {
    process.stdout.write(
      buildClaudeMcpConfig({
        nodePath: process.execPath,
        tsxLoader: resolveTsxLoader(import.meta.url),
        scriptPath,
        launchArgs: launchArgv,
      }),
    );
    if (!printPlan) return 0;
  }
  let scope: BoundScope;
  try {
    scope = bindLaunchScope(launch);
    if (!(scope instanceof BoundScope)) {
      throw new DevelopmentExecutorError("closed_scope", "scope was not bound");
    }
  } catch (error) {
    console.error(`[openappa-dev-tools] ${safeMessage(error)}`);
    return 1;
  }
  if (printPlan) {
    for (const operation of scope.launch.allow) {
      const plan = planOperation(scope, operation);
      console.error(
        `${operation} ${JSON.stringify([plan.prlimit, plan.bwrap, ...plan.args])}`,
      );
    }
    await closeBoundScope(scope);
    return 0;
  }
  try {
    await verifyIsolation(scope);
  } catch (error) {
    console.error(`[openappa-dev-tools] ${safeMessage(error)}`);
    await closeBoundScope(scope);
    return 1;
  }
  const server = new McpServer({ name: DEV_SERVER_NAME, version: "1.0.0" });
  for (const operation of scope.launch.allow) {
    registerOperation(server, operation);
  }
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isAllowedOperation(scope, name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "operation is outside the launch scope",
          },
        ],
        isError: true,
      };
    }
    try {
      rejectToolInput(request.params.arguments);
      const text = await executeOperation({
        scope,
        operation: name,
        input: request.params.arguments,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: safeMessage(error) }],
        isError: true,
      };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on("end", () => {
    void closeBoundScope(scope).finally(() => process.exit(0));
  });
  return 0;
}

function registerOperation(server: McpServer, operation: DevOperation): void {
  server.registerTool(
    operation,
    {
      description: `Closed read-only ${operation} for the launch-bound workspace. Arguments are refused.`,
      inputSchema: emptyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      throw new DevelopmentExecutorError(
        "call_handler_missing",
        "tool call handler was not installed",
      );
    },
  );
}

function isAllowedOperation(
  scope: BoundScope,
  name: string,
): name is DevOperation {
  return (scope.launch.allow as readonly string[]).includes(name);
}

function safeMessage(error: unknown): string {
  if (error instanceof DevelopmentExecutorError) return error.message;
  return "development executor failed closed";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === scriptPath) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(`[openappa-dev-tools] ${safeMessage(error)}`);
      process.exit(1);
    });
}
