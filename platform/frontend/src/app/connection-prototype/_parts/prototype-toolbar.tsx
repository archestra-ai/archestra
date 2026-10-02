"use client";

import { ChevronLeft, ChevronRight, FlaskConical } from "lucide-react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROTOTYPE_VARIANTS } from "../variants";
import { CONNECT_SCENARIOS, type PrototypePersona } from "./scenarios";

const PERSONAS: { id: PrototypePersona; label: string }[] = [
  { id: "end-user", label: "End user" },
  { id: "admin", label: "Admin" },
];

export function PrototypeToolbar({
  variantId,
  scenarioId,
  persona,
  onChange,
}: {
  variantId: string;
  scenarioId: string;
  persona: PrototypePersona;
  onChange: (updates: {
    variant?: string;
    scenario?: string;
    persona?: PrototypePersona;
  }) => void;
}) {
  const index = Math.max(
    0,
    PROTOTYPE_VARIANTS.findIndex((variant) => variant.id === variantId),
  );
  const current = PROTOTYPE_VARIANTS[index];
  const step = (delta: number) => {
    const count = PROTOTYPE_VARIANTS.length;
    onChange({
      variant: PROTOTYPE_VARIANTS[(index + delta + count) % count].id,
    });
  };

  // `[` and `]` flip between variants without leaving the keyboard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key === "[") step(-1);
      if (event.key === "]") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
      <FlaskConical className="size-4 text-muted-foreground" />
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Previous variant"
        onClick={() => step(-1)}
      >
        <ChevronLeft />
      </Button>
      <Select
        value={current.id}
        onValueChange={(variant) => onChange({ variant })}
      >
        <SelectTrigger size="sm" aria-label="Variant">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROTOTYPE_VARIANTS.map((variant, variantIndex) => (
            <SelectItem key={variant.id} value={variant.id}>
              {variantIndex + 1}. {variant.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Next variant"
        onClick={() => step(1)}
      >
        <ChevronRight />
      </Button>
      <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
        <Kbd>[</Kbd>
        <Kbd>]</Kbd>
      </span>

      <Select
        value={scenarioId}
        onValueChange={(scenario) => onChange({ scenario })}
        disabled={current.data === "live"}
      >
        <SelectTrigger size="sm" aria-label="Mock scenario">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONNECT_SCENARIOS.map((scenario) => (
            <SelectItem key={scenario.id} value={scenario.id}>
              {scenario.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex">
        {PERSONAS.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.id === persona ? "default" : "outline"}
            className="first:rounded-r-none last:rounded-l-none"
            disabled={current.data === "live"}
            onClick={() => onChange({ persona: option.id })}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <Badge variant={current.data === "live" ? "default" : "secondary"}>
        {current.data === "live" ? "Live data" : "Mock data"}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {current.hypothesis}
      </span>
    </div>
  );
}
