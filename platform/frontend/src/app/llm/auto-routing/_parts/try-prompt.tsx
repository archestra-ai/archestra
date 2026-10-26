"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type AutoRoutingPreview,
  type AutoRoutingPreviewBody,
  usePreviewAutoRouting,
} from "@/lib/auto-routing.query";
import { formatPercent } from "./plan-summary";
import { TIER_NAMES } from "./tiers";

type SessionKind = NonNullable<AutoRoutingPreviewBody["kind"]>;

export function TryPrompt({ canUpdate }: { canUpdate: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SessionKind>("main");
  const preview = usePreviewAutoRouting();

  return (
    <section className="space-y-3 rounded-md border p-4">
      <Label htmlFor="auto-routing-try-prompt">Try a prompt</Label>
      <Textarea
        id="auto-routing-try-prompt"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="A first message of a session"
        rows={3}
        disabled={!canUpdate}
      />
      <div className="flex items-center gap-2">
        <Select
          value={kind}
          onValueChange={(value) => setKind(value as SessionKind)}
          disabled={!canUpdate}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Session kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="main">Main session</SelectItem>
            <SelectItem value="subagent">Subagent</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!canUpdate || !text.trim() || preview.isPending}
          onClick={() => preview.mutate({ text, kind })}
        >
          Preview
        </Button>
      </div>
      {preview.data && <PreviewResult result={preview.data} />}
    </section>
  );
}

function PreviewResult({ result }: { result: AutoRoutingPreview }) {
  return (
    <div className="space-y-3 text-sm" data-testid="auto-routing-preview">
      <p>
        <span className="font-medium">{result.chosen.tier}</span>
        <span className="text-muted-foreground">
          {" "}
          · {result.chosen.model.provider}/{result.chosen.model.modelId} ·{" "}
          {result.reason}
        </span>
      </p>
      <div className="grid max-w-md gap-1.5">
        {TIER_NAMES.map((tier, i) => (
          <div key={tier} className="grid grid-cols-[4rem_1fr_3.5rem] gap-2">
            <span className="text-xs text-muted-foreground">{tier}</span>
            <Progress
              value={result.tierNeeded[i] * 100}
              aria-label={`${tier} tier needed`}
            />
            <span className="text-right text-xs tabular-nums">
              {formatPercent(result.tierNeeded[i])}
            </span>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Long-context likelihood</dt>
        <dd className="tabular-nums">{formatPercent(result.pLong)}</dd>
        <dt className="text-muted-foreground">Propensity</dt>
        <dd className="tabular-nums">{result.propensity.toFixed(2)}</dd>
        <dt className="text-muted-foreground">Scorer cost</dt>
        <dd className="tabular-nums">
          {result.scorerCostUsd === null
            ? "unknown"
            : `$${result.scorerCostUsd.toFixed(6)}`}
        </dd>
      </dl>
    </div>
  );
}
