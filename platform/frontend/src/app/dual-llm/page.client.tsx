"use client";

import { Suspense, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { GetDefaultDualLlmConfigResponses } from "@/lib/clients/api";
import {
  useDualLlmConfig,
  useUpdateDualLlmConfig,
} from "@/lib/dual-llm-config.query";
import { ErrorBoundary } from "../_parts/error-boundary";

export function DualLLMPage({
  initialData,
}: {
  initialData?: GetDefaultDualLlmConfigResponses["200"];
}) {
  return (
    <div className="container mx-auto overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <DualLLMContent initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function DualLLMContent({
  initialData,
}: {
  initialData?: GetDefaultDualLlmConfigResponses["200"];
}) {
  const { data: config } = useDualLlmConfig({ initialData });
  const updateConfig = useUpdateDualLlmConfig();

  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [mainAgentPrompt, setMainAgentPrompt] = useState(
    config?.mainAgentPrompt || "",
  );
  const [quarantinedAgentPrompt, setQuarantinedAgentPrompt] = useState(
    config?.quarantinedAgentPrompt || "",
  );
  const [summaryPrompt, setSummaryPrompt] = useState(
    config?.summaryPrompt || "",
  );
  const [maxRounds, setMaxRounds] = useState(config?.maxRounds || 5);

  const handleSave = () => {
    if (!config?.id) return;

    updateConfig.mutate({
      id: config.id,
      data: {
        enabled,
        mainAgentPrompt,
        quarantinedAgentPrompt,
        summaryPrompt,
        maxRounds,
      },
    });
  };

  const hasChanges =
    enabled !== config?.enabled ||
    mainAgentPrompt !== config?.mainAgentPrompt ||
    quarantinedAgentPrompt !== config?.quarantinedAgentPrompt ||
    summaryPrompt !== config?.summaryPrompt ||
    maxRounds !== config?.maxRounds;

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight mb-2">
                Dual LLM Agent Configuration
              </h1>
              <p className="text-sm text-muted-foreground">
                Configure the dual LLM pattern for enhanced security
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateConfig.isPending}
            >
              {updateConfig.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="space-y-6">
          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="enabled" className="text-sm font-semibold">
                  Enable Dual LLM Analysis
                </Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, untrusted data will be processed through the
                  dual LLM quarantine pattern
                </p>
              </div>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <Label htmlFor="max-rounds" className="text-sm font-semibold">
              Max Quarantine Rounds
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              Maximum number of Q&A rounds between main and quarantined agents.
            </p>
            <Input
              id="max-rounds"
              type="number"
              value={maxRounds}
              onChange={(e) =>
                setMaxRounds(Number.parseInt(e.target.value, 10))
              }
              className="w-32"
            />
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <Label htmlFor="main-prompt" className="text-sm font-semibold">
              Main Agent Prompt
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              All instructions for the main agent in a single user message. This
              agent asks questions to understand quarantined data without direct
              access to it. Use{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}originalUserRequest{"}}"}
              </code>{" "}
              for user request.
            </p>
            <Textarea
              id="main-prompt"
              rows={20}
              value={mainAgentPrompt}
              onChange={(e) => setMainAgentPrompt(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <Label
              htmlFor="quarantine-prompt"
              className="text-sm font-semibold"
            >
              Quarantined Agent Prompt
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              This agent has access to potentially malicious data but can only
              answer multiple choice questions. Variables:{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}toolResultData{"}}"}
              </code>
              ,{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}question{"}}"}
              </code>
              ,{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}options{"}}"}
              </code>
              ,{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}maxIndex{"}}"}
              </code>
            </p>
            <Textarea
              id="quarantine-prompt"
              rows={10}
              value={quarantinedAgentPrompt}
              onChange={(e) => setQuarantinedAgentPrompt(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <Label htmlFor="summary-prompt" className="text-sm font-semibold">
              Summary Generation Prompt
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              Prompt for generating safe summary from Q&A. Use{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"{"}
                {"{"}qaText{"}}"}
              </code>{" "}
              for conversation.
            </p>
            <Textarea
              id="summary-prompt"
              rows={4}
              value={summaryPrompt}
              onChange={(e) => setSummaryPrompt(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
