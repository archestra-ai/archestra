"use client";
// design-arena: do not commit
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { useGuardrailsArena } from "./__arena__/guardrails-arena";
import { RequestWaterfall as M1 } from "./__arena__/m1";
import { RequestWaterfall as M2 } from "./__arena__/m2";
import { RequestWaterfall as M3 } from "./__arena__/m3";
import { RequestWaterfall as M4 } from "./__arena__/m4";
import { RequestWaterfall as C } from "./__arena__/n3";
import { RequestWaterfall } from "./request-waterfall";

export {
  ArenaDetails,
  GuardrailsArenaProvider,
} from "./__arena__/guardrails-arena";

const VARIANTS = [M1, M2, M3, M4, C];
const LABELS = ["C1", "C2", "C3", "C4", "C (prev)"];
const STORAGE_KEY = "design-arena:guardrails-4";

export function ArenaWaterfall(props: ComponentProps<typeof RequestWaterfall>) {
  const { guardrails, selectedConsultKey, selectConsult, selectSpan } =
    useGuardrailsArena();
  return (
    <DesignArena
      current={<RequestWaterfall {...props} onSelect={selectSpan} />}
      variants={VARIANTS.map((Variant, index) => (
        <Variant
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          key={index}
          {...props}
          onSelect={selectSpan}
          guardrails={guardrails}
          selectedConsultKey={selectedConsultKey}
          onSelectConsult={selectConsult}
        />
      ))}
    />
  );
}

function DesignArena({
  current,
  variants,
}: {
  current: ReactNode;
  variants: ReactNode[];
}) {
  const [sel, setSel] = useState(-1);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = Number(raw);
      if (Number.isInteger(saved) && saved >= -1 && saved < variants.length) {
        setSel(saved);
      }
    } catch {}
  }, [variants.length]);
  const pick = (index: number) => {
    setSel(index);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(index));
    } catch {}
  };
  return (
    <div className="space-y-2">
      <div className="inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
        <span className="pr-1 text-muted-foreground">Prototype</span>
        {["Current", ...LABELS.slice(0, variants.length)].map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => pick(i - 1)}
            className={`rounded px-1.5 py-0.5 ${sel === i - 1 ? "bg-background font-semibold" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {sel < 0 ? current : variants[sel]}
    </div>
  );
}
