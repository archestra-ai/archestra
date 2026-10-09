import { buildEnding } from "./steps/ending";
import { psq, sh } from "./steps/quoting";
import {
  bashFooter,
  bashHeader,
  powerShellFooter,
  powerShellHeader,
} from "./steps/script-frame";
import type { AgentEnding, SetupScriptContext } from "./types";

/** One Node implementation; the shell only transports context through env. */
export function renderNodeSetupScript(
  ctx: SetupScriptContext,
  agent: { label: string; binary: string; source: string; ending: AgentEnding },
): string {
  const encodedContext = Buffer.from(JSON.stringify(ctx)).toString("base64");
  const ending = buildEnding(ctx, agent.label, agent.ending);
  if (ctx.platform === "windows") {
    return `${powerShellHeader(ctx, agent)}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required. Install Node.js and retry.' }
$env:ARCHESTRA_NODE_SETUP_CONTEXT = ${psq(encodedContext)}
try {
  & node -e ${psq(agent.source)}
  if ($LASTEXITCODE -ne 0) { throw 'Connection setup failed.' }
} finally { Remove-Item Env:ARCHESTRA_NODE_SETUP_CONTEXT -ErrorAction SilentlyContinue }
${powerShellFooter(ending)}
`;
  }
  return `${bashHeader(ctx, agent)}
if ! command -v node >/dev/null 2>&1; then
  err 'Node.js is required. Install Node.js and retry.'
  exit 1
fi
export ARCHESTRA_NODE_SETUP_CONTEXT=${sh(encodedContext)}
node -e ${sh(agent.source)}
unset ARCHESTRA_NODE_SETUP_CONTEXT
${bashFooter(ending)}
`;
}
