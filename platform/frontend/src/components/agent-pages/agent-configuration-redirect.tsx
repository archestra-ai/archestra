"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentPageKind,
  type AgentSetupStepId,
  agentConfigureHref,
} from "./agent-page-config";

const SETUP_STEP_IDS: readonly AgentSetupStepId[] = [
  "configuration",
  "tools",
  "messaging",
  "advanced",
];

/**
 * `/<family>/[id]/edit` — kept only for the links already out there.
 *
 * Configuration used to be a wizard on this route; it is now the detail
 * page's own tabs, so a saved bookmark, a shared URL or an older deep link
 * lands on the tab its `?step=` asked for instead of a dead route. Everything
 * else in the query travels with it, `?openTools=true` included.
 */
export function AgentConfigurationRedirect({
  kind,
  id,
}: {
  kind: AgentPageKind;
  id: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const stepParam = searchParams.get("step");
  const step = SETUP_STEP_IDS.find((candidate) => candidate === stepParam);
  const carried = new URLSearchParams(searchParams.toString());
  carried.delete("step");
  const rest = carried.toString();
  const base = agentConfigureHref(kind, id, step);
  const href = rest ? `${base}${base.includes("?") ? "&" : "?"}${rest}` : base;

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return <Skeleton className="h-96 w-full rounded-xl" />;
}
