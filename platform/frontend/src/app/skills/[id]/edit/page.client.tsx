"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { skillEditHref } from "../../_parts/skill-page-config";

/**
 * `/skills/[id]/edit` — kept only for the links already out there.
 *
 * Content and Access used to be a two-step wizard on this route; they are one
 * page now, the skill's own, so a saved bookmark, a shared URL or an older
 * deep link lands there instead of on a dead route. `?step=` named a half of
 * the form that is no longer split, so it is dropped; everything else in the
 * query travels along.
 */
export function SkillEditPage({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const carried = new URLSearchParams(searchParams.toString());
  carried.delete("step");
  const rest = carried.toString();
  const base = skillEditHref(id);
  const href = rest ? `${base}${base.includes("?") ? "&" : "?"}${rest}` : base;

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return <Skeleton className="h-96 w-full rounded-xl" />;
}
