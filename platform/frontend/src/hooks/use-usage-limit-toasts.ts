"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { AlertTriangle, XCircle } from "lucide-react";
import { useLimits } from "@/lib/limits.query";

const THRESHOLD_WARNING = 75;
const THRESHOLD_DANGER = 90;
const THRESHOLD_EXCEEDED = 100;

export function useUsageLimitToasts() {
  const { data: limits } = useLimits();
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!limits) return;

    for (const limit of limits) {
      if (limit.limitType !== "token_cost") continue;

      const actualUsage = (limit.modelUsage ?? []).reduce(
        (sum: number, u: { cost: number }) => sum + u.cost,
        0,
      );
      const percentage =
        limit.limitValue > 0 ? (actualUsage / limit.limitValue) * 100 : 0;

      const key = `${limit.id}-${Math.floor(percentage / 5)}`;

      if (notifiedRef.current.has(key)) continue;

      if (percentage >= THRESHOLD_EXCEEDED) {
        const exceededKey = `${limit.id}-exceeded`;
        if (!notifiedRef.current.has(exceededKey)) {
          toast.error("Usage limit exceeded", {
            description: `Your spending has reached the configured limit ($${actualUsage.toFixed(2)} / $${limit.limitValue.toFixed(2)}).`,
            icon: <XCircle className="h-4 w-4 text-red-500" />,
            duration: 10000,
          });
          notifiedRef.current.add(exceededKey);
        }
      } else if (percentage >= THRESHOLD_DANGER) {
        toast.warning("Approaching usage limit", {
          description: `You've used ${percentage.toFixed(0)}% of your limit ($${actualUsage.toFixed(2)} / $${limit.limitValue.toFixed(2)}).`,
          icon: <AlertTriangle className="h-4 w-4 text-orange-500" />,
          duration: 8000,
        });
        notifiedRef.current.add(key);
      } else if (percentage >= THRESHOLD_WARNING) {
        toast.info("Usage limit warning", {
          description: `You've used ${percentage.toFixed(0)}% of your limit ($${actualUsage.toFixed(2)} / $${limit.limitValue.toFixed(2)}).`,
          icon: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
          duration: 6000,
        });
        notifiedRef.current.add(key);
      }
    }

    const currentKeys = new Set(
      limits
        .filter((l: { limitType: string }) => l.limitType === "token_cost")
        .map((l: { id: string; modelUsage: { cost: number }[]; limitValue: number }) => {
          const usage = (l.modelUsage ?? []).reduce(
            (sum: number, u: { cost: number }) => sum + u.cost,
            0,
          );
          const pct = l.limitValue > 0 ? (usage / l.limitValue) * 100 : 0;
          return `${l.id}-${Math.floor(pct / 5)}`;
        }),
    );
    const newNotified = new Set(
      [...notifiedRef.current].filter((k) => currentKeys.has(k)),
    );
    notifiedRef.current = newNotified;
  }, [limits]);
}
