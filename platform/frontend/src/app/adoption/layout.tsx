"use client";

import { useSearchParams } from "next/navigation";
import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";
import {
  ADOPTION_VIEWS,
  resolveAdoptionView,
} from "./_parts/connection-explorer";

export default function AdoptionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useSearchParams();
  const view = resolveAdoptionView(new URLSearchParams(params.toString()));
  const tabs = ADOPTION_VIEWS.map((item) => {
    // The range carries over; every view keeps its own filters.
    const next = new URLSearchParams();
    for (const key of ["startDate", "endDate"]) {
      const value = params.get(key);
      if (value) next.set(key, value);
    }
    if (item.id !== "usage") next.set("view", item.id);
    const search = next.toString();
    return {
      label: item.label,
      href: search ? `/adoption?${search}` : "/adoption",
      selected: view === item.id,
    };
  });
  return (
    <LogsSectionLayout
      listPath="/adoption"
      title="Adoption"
      description="Who has connected agents and client apps, and how much each one is used."
      tabs={tabs}
    >
      {children}
    </LogsSectionLayout>
  );
}
