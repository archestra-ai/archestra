"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { PrototypeToolbar } from "./_parts/prototype-toolbar";
import {
  CONNECT_SCENARIOS,
  DEFAULT_SCENARIO_ID,
  type PrototypePersona,
} from "./_parts/scenarios";
import { PROTOTYPE_VARIANTS } from "./variants";

export default function ConnectPrototypePage() {
  usePageTitle("Connect prototypes");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const variant =
    PROTOTYPE_VARIANTS.find(
      (item) => item.id === searchParams.get("variant"),
    ) ?? PROTOTYPE_VARIANTS[0];
  const scenario =
    CONNECT_SCENARIOS.find(
      (item) => item.id === searchParams.get("scenario"),
    ) ??
    CONNECT_SCENARIOS.find((item) => item.id === DEFAULT_SCENARIO_ID) ??
    CONNECT_SCENARIOS[0];
  const persona: PrototypePersona =
    searchParams.get("persona") === "admin" ? "admin" : "end-user";

  // Every choice lives in the URL so a specific variant + scenario can be
  // shared as a link when giving feedback.
  const updateParams = (updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const { Component } = variant;

  return (
    <div className="flex min-h-full flex-col">
      <PrototypeToolbar
        variantId={variant.id}
        scenarioId={scenario.id}
        persona={persona}
        onChange={updateParams}
      />
      <div className="min-h-0 flex-1">
        <Component key={variant.id} scenario={scenario} persona={persona} />
      </div>
    </div>
  );
}
