"use client";

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { Copy, WrapText } from "lucide-react";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasNoPodToStream } from "./logs-streaming-indicator";
// SPDX-SnippetEnd
import { LogsBody, LogsStatus, useLogStream } from "./mcp-server-console-logs";
import {
  BarButton,
  BarToggle,
  CommandChip,
  ConnDot,
  connState,
  copyText,
} from "./mcp-server-console-ui";

/**
 * The failed connection's pod logs, inline on the Test Connection step, so the
 * reason a server would not start is readable without leaving the wizard.
 * A compact copy of the server page's Logs tab: same stream, same chrome.
 */
export function TestConnectionLogs({
  serverId,
  serverName,
  status,
}: {
  serverId: string;
  /** Shown until the pod's name arrives with its deployment status. */
  serverName: string;
  status: McpDeploymentStatusEntry | undefined;
}) {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // No pod (never deployed, or idle-hibernated): nothing to tail, so don't
  // open a stream that can only time out.
  const noPod = hasNoPodToStream(status);
  // SPDX-SnippetEnd
  const logs = useLogStream(noPod ? null : serverId);

  return (
    <div className="flex h-[360px] flex-col overflow-hidden rounded-md border border-slate-900 bg-slate-950 text-slate-300 shadow-sm dark:border-slate-800">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-800 pr-1.5 pl-3 sm:gap-3 sm:pr-2">
        <ConnDot state={connState(status)} />
        <span
          className="min-w-0 truncate font-mono text-xs text-slate-200"
          title={status?.podName ?? serverName}
        >
          {status?.podName ?? serverName}
        </span>
        {status?.podAge && (
          <span className="hidden shrink-0 text-xs text-slate-500 sm:inline">
            {status.podAge} old
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          <BarToggle
            pressed={logs.wrap}
            onClick={() => logs.setWrap(!logs.wrap)}
            icon={<WrapText />}
            label="Wrap"
          />
          <BarButton
            icon={<Copy />}
            label="Copy"
            disabled={!logs.content}
            onClick={() => copyText(logs.content, "Logs copied to clipboard")}
          />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <LogsBody logs={logs} status={status} noPod={noPod} />
      </div>

      <footer className="flex h-7 shrink-0 items-stretch overflow-hidden border-t border-slate-800 bg-slate-900/60 font-mono text-[11px] whitespace-nowrap text-slate-400">
        <span className="flex shrink-0 items-center bg-slate-800/80 px-2.5 text-slate-200">
          Logs
        </span>
        <div className="flex shrink-0 items-center gap-3 px-3">
          <LogsStatus logs={logs} status={status} />
        </div>
        {logs.command && (
          <div className="flex min-w-0 flex-1 justify-end">
            <div className="flex min-w-0 items-center gap-2 border-l border-slate-800 pr-1 pl-3">
              <CommandChip command={logs.command} />
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
