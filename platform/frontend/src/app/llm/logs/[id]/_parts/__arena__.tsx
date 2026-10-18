"use client";
// design-arena: do not commit
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { useGuardrailsArena } from "./__arena__/guardrails-arena";
import { RequestWaterfall as N1 } from "./__arena__/n1";
import { RequestWaterfall as N2 } from "./__arena__/n2";
import { RequestWaterfall as N3 } from "./__arena__/n3";
import { RequestWaterfall as N4 } from "./__arena__/n4";
import { RequestWaterfall as V6 } from "./__arena__/v6";
import { RequestWaterfall as V8 } from "./__arena__/v8";
import { RequestWaterfall } from "./request-waterfall";

export {
  ArenaDetails,
  GuardrailsArenaProvider,
} from "./__arena__/guardrails-arena";

const VARIANTS = [N1, N2, N3, N4, V6, V8];
const LABELS = ["A", "B", "C", "D", "old 6", "old 8"];
const STORAGE_KEY = "design-arena:guardrails-3";

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
