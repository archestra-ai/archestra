"use client";
// design-arena: do not commit
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { RequestWaterfall as V1 } from "./__arena__/v1";
import { RequestWaterfall as V2 } from "./__arena__/v2";
import { RequestWaterfall as V3 } from "./__arena__/v3";
import { RequestWaterfall as V4 } from "./__arena__/v4";
import { RequestWaterfall as V5 } from "./__arena__/v5";
import { RequestWaterfall as V6 } from "./__arena__/v6";
import { RequestWaterfall as V7 } from "./__arena__/v7";
import { RequestWaterfall as V8 } from "./__arena__/v8";
import { RequestWaterfall as V9 } from "./__arena__/v9";
import { RequestWaterfall as V10 } from "./__arena__/v10";
import { buildGuardrailsMock } from "./__arena__/guardrails-mock";
import { RequestWaterfall } from "./request-waterfall";

const VARIANTS = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10];
const STORAGE_KEY = "design-arena:guardrails";

export function ArenaWaterfall(props: ComponentProps<typeof RequestWaterfall>) {
  const guardrails = useMemo(
    () => buildGuardrailsMock(props.timeline),
    [props.timeline],
  );
  return (
    <DesignArena
      current={<RequestWaterfall {...props} />}
      variants={VARIANTS.map((Variant, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        <Variant key={index} {...props} guardrails={guardrails} />
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
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const saved = Number(raw);
    if (Number.isInteger(saved) && saved >= -1 && saved < variants.length) {
      setSel(saved);
    }
  }, [variants.length]);
  const pick = (index: number) => {
    setSel(index);
    window.localStorage.setItem(STORAGE_KEY, String(index));
  };
  return (
    <div className="space-y-2">
      <div className="inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
        <span className="pr-1 text-muted-foreground">Prototype</span>
        {["Current", ...variants.map((_, i) => `${i + 1}`)].map((label, i) => (
          // biome-ignore lint/plugin: arena scaffolding
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
