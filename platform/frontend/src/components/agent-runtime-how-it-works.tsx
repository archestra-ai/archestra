"use client";

import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * What happens when someone gives a container-runtime agent a task, in the
 * four steps a reader needs before the settings below make sense.
 */
export function AgentRuntimeHowItWorks() {
  const appName = useAppName();
  const steps = [
    {
      title: "Someone gives it a task",
      body: `In ${appName} chat, a Slack thread, or handed off from a coding agent on their laptop.`,
    },
    {
      title: "It starts a run",
      body: "In its own container. Live terminal, files kept between messages.",
    },
    {
      title: `Through ${appName}`,
      body: "Model calls go through the LLM proxy, tools through the MCP gateway. Logged and guarded.",
    },
    {
      title: "The result returns where it started",
      body: "The same chat or thread, or as a patch back on the laptop.",
    },
  ];
  return (
    <section
      aria-label="How it works"
      className="grid gap-4 rounded-lg bg-muted p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {steps.map((step) => (
        <div key={step.title} className="space-y-1">
          <p className="text-sm font-medium">{step.title}</p>
          <p className="text-xs leading-5 text-muted-foreground">{step.body}</p>
        </div>
      ))}
    </section>
  );
}
