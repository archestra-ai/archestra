"use client";

import { CONNECT_CLIENTS } from "./clients";
import type { ConnectPageData } from "./connect-page-data";
import { OneOf, ScriptBlock, TextButton, useCopy } from "./connect-page-parts";

/**
 * The ChatGPT desktop app's Work and Codex tabs run Codex's app server and
 * read Codex's config.toml, so the Codex setup also routes them through the
 * LLM proxy, where Guardrails check their tool calls.
 */
export function ChatgptDesktopSetup({
  data,
  includeTools,
  includeSkills,
}: {
  data: ConnectPageData;
  includeTools: boolean;
  includeSkills: boolean;
}) {
  const { copied, copy } = useCopy();
  const codex = CONNECT_CLIENTS.find((client) => client.id === "codex");
  const command = codex
    ? data.installerCommand(
        codex,
        {
          tools: includeTools,
          skills: includeSkills,
          proxy: true,
          plugins: false,
        },
        data.windows,
        { gatewayId: null, pluginIds: null },
      )
    : null;
  return (
    <div className="space-y-3 text-sm">
      <p className="leading-6 text-muted-foreground">
        The Work and Codex tabs use the Codex settings on your computer. Run
        this command in a terminal on that computer. It sends their model
        requests through {data.appName}'s LLM proxy, where Guardrails check each
        tool call.
      </p>
      {command && (
        <ScriptBlock
          command={command}
          copied={copied}
          disabled={false}
          onCopy={() => copy(command)}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        <p className="max-w-prose leading-5">
          The setup uses the Codex CLI, so the approval page shows Codex. It
          checks the local sandbox before changing settings and stops with
          repair instructions if a Linux or WSL prerequisite is missing. Restart
          ChatGPT when the setup is done.
        </p>
        <TextButton onClick={() => data.setWindows(!data.windows)}>
          <OneOf inline shown={data.windows ? 0 : 1}>
            <span>Use the macOS / Linux command</span>
            <span>Use the Windows command</span>
          </OneOf>
        </TextButton>
      </div>
    </div>
  );
}
