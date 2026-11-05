"use client";

import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * A container-runtime agent already has its harness's own tools. Without this,
 * readers took the tool picker below for everything the agent can do.
 */
export function AgentRuntimeToolSources() {
  const appName = useAppName();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Built in, always on</p>
        <p className="text-xs leading-5 text-muted-foreground">
          The coding agent&apos;s own tools keep working in its container:
          shell, file read and edit, git, web fetch. Nothing to set up here.
        </p>
      </div>
      <div className="space-y-1 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <p className="text-sm font-medium">Added by {appName} (this page)</p>
        <p className="text-xs leading-5 text-muted-foreground">
          Extra MCP servers, skills, knowledge and subagents on top. By default,
          everything the person asking can already use. A run never gets more
          access than that person.
        </p>
      </div>
    </div>
  );
}
