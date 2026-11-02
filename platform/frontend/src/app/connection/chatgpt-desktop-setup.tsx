"use client";

import { useEffect, useState } from "react";
import { CONNECT_CLIENTS } from "./clients";
import type { ConnectPageData } from "./connect-page-data";
import { OneOf, ScriptBlock, TextButton, useCopy } from "./connect-page-parts";
import { detectPlatform } from "./platform.utils";

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
  // The browser's OS, not the command toggle: a Windows user who runs Codex
  // in WSL switches to the macOS / Linux command and still needs the note.
  const [windowsComputer, setWindowsComputer] = useState(false);
  useEffect(() => setWindowsComputer(detectPlatform() === "windows"), []);
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
          The setup uses the Codex CLI, so the approval page shows Codex.
          Restart ChatGPT when the setup is done.
        </p>
        <TextButton onClick={() => data.setWindows(!data.windows)}>
          <OneOf inline shown={data.windows ? 0 : 1}>
            <span>Use the macOS / Linux command</span>
            <span>Use the Windows command</span>
          </OneOf>
        </TextButton>
      </div>
      {windowsComputer && (
        <p className="max-w-prose px-1 text-xs leading-5 text-muted-foreground">
          Does ChatGPT run Codex in WSL? Then run the macOS / Linux command in
          WSL. Before you run it, set CODEX_HOME to your Windows Codex folder,
          for example:
          {/* One line like the command above; it scrolls on narrow screens. */}
          <code className="mt-1 block w-fit max-w-full overflow-x-auto whitespace-nowrap font-mono">
            export CODEX_HOME=/mnt/c/Users/you/.codex
          </code>
        </p>
      )}
    </div>
  );
}
