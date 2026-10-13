"use client";

// design-arena scaffolding: prototype switcher for the WizardFooter version
// placement. Delete this file and `__arena__/` once a variant is picked.

import {
  Children,
  type ReactNode,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { VERSION_SLOT_GENERATION_ATTRIBUTE } from "@/components/version";
import type { FooterVariantProps } from "./__arena__/types";
import { Variant as V1 } from "./__arena__/v1";
import { Variant as V2 } from "./__arena__/v2";
import { Variant as V3 } from "./__arena__/v3";
import { Variant as V4 } from "./__arena__/v4";
import { Variant as V5 } from "./__arena__/v5";
import { Variant as V6 } from "./__arena__/v6";

const VARIANTS: Array<(props: FooterVariantProps) => ReactNode> = [
  V1,
  V2,
  V3,
  V4,
  V5,
  V6,
];

export function WizardFooterArena({
  current,
  children,
  className,
  slotProps,
}: {
  current: ReactNode;
  children: ReactNode;
  className?: string;
  slotProps: Record<string, string>;
}) {
  const sel = useSelection();

  // The version line portals into the first slot it finds and only re-queries
  // when the body generation attribute changes, so announce the new slot.
  useLayoutEffect(() => {
    document.body.setAttribute(
      VERSION_SLOT_GENERATION_ATTRIBUTE,
      `arena-${sel}-${Date.now()}`,
    );
  }, [sel]);

  const items = Children.toArray(children);
  const left = items.length > 1 ? items.slice(0, -1) : [];
  const right = items.length > 0 ? items.slice(-1) : [];
  const ActiveVariant = sel >= 0 ? VARIANTS[sel] : null;

  return (
    <>
      <ArenaSwitcher sel={sel} />
      {ActiveVariant ? (
        <ActiveVariant
          left={left}
          right={right}
          className={className}
          slotProps={slotProps}
        />
      ) : (
        current
      )}
    </>
  );
}

function ArenaSwitcher({ sel }: { sel: number }) {
  return (
    <div className="fixed right-4 bottom-24 z-50 inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
      <span className="pr-1 text-muted-foreground">Prototype</span>
      {["Current", ...VARIANTS.map((_, i) => `${i + 1}`)].map((label, i) => (
        <button
          key={label}
          type="button"
          onClick={() => setSelection(i - 1)}
          className={`rounded px-1.5 py-0.5 ${sel === i - 1 ? "bg-background font-semibold" : "text-muted-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const STORAGE_KEY = "design-arena:wizard-footer";
const listeners = new Set<() => void>();

function readSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? -1 : Number(raw);
    return Number.isInteger(n) && n >= -1 && n < VARIANTS.length ? n : -1;
  } catch {
    return -1;
  }
}

function setSelection(n: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // selection just won't persist
  }
  for (const l of listeners) l();
}

function useSelection() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readSelection,
    () => -1,
  );
}
