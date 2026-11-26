"use client";

import { Gauge, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  type GuardrailsMode,
  useGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";

const MODE_BADGE: Record<
  GuardrailsMode,
  { label: string; tone: string; dot: string }
> = {
  off: {
    label: "Not configured",
    tone: "bg-muted text-muted-foreground",
    dot: "border-[1.5px] border-muted-foreground/60",
  },
  observe: {
    label: "Observe only",
    tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  enforce: {
    label: "Enforced",
    tone: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

/** Guardrails and budgets: one line each, with the page that configures it. */
export function SummaryTiles() {
  // Any member may read the switch, as the Connect page does.
  const { data: guardrails } = useGuardrailsDeployment({ anyMember: true });
  // The deployment's own mode, as the Guardrails page shows it; not per key.
  // Unknown (loading, or the feature is off) shows no state rather than a
  // wrong one.
  const mode = guardrails && (guardrails.active ? guardrails.mode : "off");
  const badge = mode && MODE_BADGE[mode];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Tile
        id="llm-proxy-guardrails"
        icon={<ShieldCheck />}
        title="Guardrails"
        badge={
          badge && (
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap",
                badge.tone,
              )}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", badge.dot)}
              />
              {badge.label}
            </span>
          )
        }
        text={
          mode === "off"
            ? "Add a policy to deterministically check every request"
            : "Deterministic data leak prevention"
        }
        href="/openappa"
        linkLabel="Configure"
      />
      <Tile
        id="llm-proxy-budgets"
        icon={<Gauge />}
        title="Budgets and limits"
        text="Spend and rate limits per org, team, user or key"
        href="/llm/limits"
        linkLabel="Cost Controls"
      />
    </div>
  );
}

function Tile({
  id,
  icon,
  title,
  badge,
  text,
  href,
  linkLabel,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  text: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 items-center gap-3 rounded-xl border bg-card px-4 py-3"
    >
      <span
        aria-hidden
        className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-[15px]"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 id={id} className="text-sm font-semibold whitespace-nowrap">
            {title}
          </h2>
          {badge}
        </div>
        <span className="truncate text-[12.5px] text-muted-foreground">
          {text}
        </span>
      </div>
      <Link
        href={href}
        className="shrink-0 text-[13px] text-primary hover:underline"
      >
        {linkLabel}
      </Link>
    </section>
  );
}
