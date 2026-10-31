"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AutoRoutingPreview,
  type AutoRoutingPreviewBody,
  type AutoRoutingScorerState,
  usePreviewAutoRouting,
} from "@/lib/auto-routing.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { AddJevKeyLink } from "./add-jev-key";
import { formatPercent } from "./plan-summary";
import { TIER_NAMES } from "./tiers";

export function TryPrompt({
  canUpdate,
  scorer,
}: {
  canUpdate: boolean;
  scorer: AutoRoutingScorerState;
}) {
  const [text, setText] = useState("");
  const [requestMode, setRequestMode] = useState(false);
  const [client, setClient] = useState("");
  const preview = usePreviewAutoRouting();
  const parsed = previewBody({ text, requestMode, client });

  if (scorer === "no_jev_key") {
    return (
      <section className="flex items-center gap-2 rounded-md border p-4 text-sm">
        <span className="font-medium">Try a prompt</span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <AddJevKeyLink />
      </section>
    );
  }
  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <Switch
          id="auto-routing-request-mode"
          checked={requestMode}
          disabled={!canUpdate}
          onCheckedChange={(checked) => {
            setRequestMode(checked);
            setText("");
            preview.reset();
          }}
        />
        <Label htmlFor="auto-routing-request-mode">Use request JSON</Label>
      </div>
      <Label htmlFor="auto-routing-try-prompt">
        {requestMode ? "Opening request JSON" : "Try a prompt"}
      </Label>
      <Textarea
        id="auto-routing-try-prompt"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          preview.reset();
        }}
        placeholder={
          requestMode
            ? "Paste the opening request body from LLM Logs"
            : "A first message of a session"
        }
        aria-invalid={!!parsed.error}
        aria-describedby="auto-routing-preview-input-help"
        rows={3}
        disabled={!canUpdate}
      />
      <p
        id="auto-routing-preview-input-help"
        className="text-xs text-muted-foreground"
      >
        {parsed.error ??
          (requestMode
            ? "Uses the request's opening user message, system instructions and tools, as live routing does. Scores a new session under the current plan; does not replay a saved decision or execute the request."
            : "Text-only preview. Use request JSON to include the agent's system instructions and tools.")}
      </p>
      {requestMode && (
        <div className="space-y-2">
          <Label htmlFor="auto-routing-preview-client">
            Client identifier (optional)
          </Label>
          <Input
            id="auto-routing-preview-client"
            value={client}
            maxLength={256}
            placeholder="Client identifier from the original request metadata"
            disabled={!canUpdate}
            onChange={(event) => {
              setClient(event.target.value);
              preview.reset();
            }}
          />
        </div>
      )}
      <Button
        size="sm"
        disabled={!canUpdate || !parsed.body || preview.isPending}
        onClick={() => {
          if (parsed.body) preview.mutate(parsed.body);
        }}
      >
        Preview
      </Button>
      {preview.data && <PreviewResult result={preview.data} />}
    </section>
  );
}

function previewBody({
  text,
  requestMode,
  client,
}: {
  text: string;
  requestMode: boolean;
  client: string;
}): { body?: AutoRoutingPreviewBody; error?: string } {
  if (!text.trim()) return {};
  if (!requestMode) return { body: { text } };
  try {
    const request: unknown = JSON.parse(text);
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      return { error: "Enter a JSON object containing the request body." };
    }
    return {
      body: {
        request: request as Record<string, unknown>,
        ...(client.trim() ? { client: client.trim() } : {}),
      },
    };
  } catch {
    return { error: "Enter valid JSON containing the request body." };
  }
}

function PreviewResult({ result }: { result: AutoRoutingPreview }) {
  return (
    <div className="space-y-3 text-sm" data-testid="auto-routing-preview">
      <p>
        <span className="font-medium">{result.chosen.tier}</span>
        <span className="text-muted-foreground">
          {" "}
          · {result.chosen.model.provider}/{result.chosen.model.modelId} ·{" "}
          {REASON_LABELS[result.reason]}
        </span>
      </p>
      <div className="grid max-w-md gap-1.5">
        <span className="text-xs text-muted-foreground">
          Chance each tier is enough for this session
        </span>
        {TIER_NAMES.map((tier, i) => (
          <div key={tier} className="grid grid-cols-[4rem_1fr_3.5rem] gap-2">
            <span className="text-xs text-muted-foreground">{tier}</span>
            <Progress
              value={result.tierNeeded[i] * 100}
              aria-label={`${tier} tier is enough`}
            />
            <span className="text-right text-xs tabular-nums">
              {formatPercent(result.tierNeeded[i])}
            </span>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {result.expectedCostUsd !== null && (
          <>
            <dt className="text-muted-foreground">
              Expected session cost ({result.chosen.tier})
            </dt>
            <dd className="tabular-nums">
              {formatCurrency(result.expectedCostUsd)}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Long-context likelihood</dt>
        <dd className="tabular-nums">{formatPercent(result.pLong)}</dd>
        <dt className="text-muted-foreground">Choice probability</dt>
        <dd className="tabular-nums">{formatPercent(result.propensity)}</dd>
        {result.scorerCostUsd !== null && (
          <>
            <dt className="text-muted-foreground">Scorer cost</dt>
            <dd className="tabular-nums">${result.scorerCostUsd.toFixed(6)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const REASON_LABELS: Record<AutoRoutingPreview["reason"], string> = {
  planned: "picked by the active plan",
  cold_start: "no plan yet, so the normal tier",
  plan_stale: "plan out of date, so the normal tier",
};
