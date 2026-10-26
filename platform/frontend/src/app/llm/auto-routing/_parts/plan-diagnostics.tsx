"use client";

import { AlertTriangle, Info } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AutoRoutingPlanDetail,
  useAutoRoutingPlan,
} from "@/lib/auto-routing.query";
import {
  type Holdout,
  type PlanModels,
  parseColdStartDiagnostics,
  parseHoldout,
  parsePlanModels,
  rejectionReason,
  SIZE_MODEL_TOKEN_SCALE,
} from "./plan-document";

export function PlanDiagnostics({ planId }: { planId: string }) {
  const { data: plan, isPending } = useAutoRoutingPlan(planId);
  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading plan…</p>;
  }
  if (!plan) {
    return <p className="text-sm text-muted-foreground">Plan not found.</p>;
  }
  return <PlanDiagnosticsBody plan={plan} />;
}

function PlanDiagnosticsBody({ plan }: { plan: AutoRoutingPlanDetail }) {
  switch (plan.status) {
    case "failed":
      return (
        <InlineNotice variant="error">
          <AlertTriangle />
          <span className="font-medium">Fit failed</span>
          <InlineNoticeText>{plan.error ?? "Unknown error"}</InlineNoticeText>
        </InlineNotice>
      );
    case "rejected":
      return (
        <InlineNotice variant="neutral">
          <Info />
          <span className="font-medium">Not published</span>
          <InlineNoticeText>{rejectionReason(plan.error)}</InlineNoticeText>
        </InlineNotice>
      );
    case "cold_start": {
      const coldStart = parseColdStartDiagnostics(plan.diagnostics);
      return (
        <InlineNotice variant="neutral">
          <Info />
          <span className="font-medium">Cold start</span>
          <InlineNoticeText>
            {coldStart
              ? `${coldStart.sessions} of ${coldStart.min_sessions} sessions needed to fit a plan.`
              : "Not enough sessions to fit a plan."}
          </InlineNoticeText>
        </InlineNotice>
      );
    }
    case "active":
    case "superseded": {
      const models = parsePlanModels(plan.plan);
      const holdout = parseHoldout(plan.diagnostics);
      return (
        <div className="space-y-6">
          {models ? (
            <>
              <SizeModelTable models={models} />
              <LongShareTable models={models} />
            </>
          ) : (
            <UnknownFormat version={plan.planFormatVersion} />
          )}
          {holdout ? (
            <HoldoutTable holdout={holdout} />
          ) : (
            <UnknownFormat version={plan.planFormatVersion} />
          )}
        </div>
      );
    }
  }
}

function SizeModelTable({ models }: { models: PlanModels }) {
  const size = models.size_model;
  return (
    <Section title="Session size model">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Term</TableHead>
            <TableHead className="text-right">Effect</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Baseline session ({size.baseline})</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatTokens(Math.exp(size.intercept) * SIZE_MODEL_TOKEN_SCALE)}{" "}
              tokens
            </TableCell>
          </TableRow>
          {size.source_effects.map((effect) => (
            <TableRow key={effect.source}>
              <TableCell>Source: {effect.source}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMultiplier(effect.coef)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>Long-context likelihood (p_long = 1)</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMultiplier(size.p_long)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Section>
  );
}

function LongShareTable({ models }: { models: PlanModels }) {
  const rows = [
    ["Intercept", models.long_share.intercept],
    ["log(session tokens)", models.long_share.log_size],
    ["Subagent session", models.long_share.is_subagent],
  ] as const;
  return (
    <Section title="Long-context token share">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Term</TableHead>
            <TableHead className="text-right">Coefficient</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {value.toFixed(4)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function HoldoutTable({ holdout }: { holdout: Holdout }) {
  switch (holdout.status) {
    case "insufficient_history":
      return (
        <Section title="Holdout check (last 10 days)">
          <p className="text-sm text-muted-foreground">
            All history falls inside the holdout window.
          </p>
        </Section>
      );
    case "fit_failed":
      return (
        <Section title="Holdout check (last 10 days)">
          <InlineNotice variant="error">
            <AlertTriangle />
            <span className="font-medium">Holdout fit failed</span>
            <InlineNoticeText>{holdout.error}</InlineNoticeText>
          </InlineNotice>
        </Section>
      );
    case "evaluated":
      return (
        <Section title="Holdout check (last 10 days)">
          <Table>
            <TableBody>
              <MetricRow label="Sessions" value={String(holdout.sessions)} />
              <MetricRow
                label="Predicted tokens"
                value={formatTokens(holdout.predicted_tokens)}
              />
              <MetricRow
                label="Realized tokens"
                value={formatTokens(holdout.realized_tokens)}
              />
              <MetricRow
                label="Spearman rank correlation"
                value={holdout.spearman?.toFixed(3) ?? "n/a"}
              />
            </TableBody>
          </Table>
        </Section>
      );
  }
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell>{label}</TableCell>
      <TableCell className="text-right tabular-nums">{value}</TableCell>
    </TableRow>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function UnknownFormat({ version }: { version: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      Plan format {version} is not supported by this view.
    </p>
  );
}

function formatMultiplier(logCoefficient: number): string {
  return `× ${Math.exp(logCoefficient).toFixed(2)} tokens`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
