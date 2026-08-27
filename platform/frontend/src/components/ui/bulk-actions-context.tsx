"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

type BulkActionsScopeValue = {
  targetId: string;
};

const BulkActionsScopeContext = createContext<BulkActionsScopeValue | null>(
  null,
);

/**
 * Shares a stable filter-bar target with collection-owned bulk actions.
 */
export function BulkActionsScope({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const targetId = `bulk-actions-${id.replaceAll(":", "")}`;
  const value = useMemo(() => ({ targetId }), [targetId]);

  return (
    <BulkActionsScopeContext.Provider value={value}>
      {className ? <div className={className}>{children}</div> : children}
    </BulkActionsScopeContext.Provider>
  );
}

/** Returns the enclosing collection's contextual bulk-actions target, if any. */
export function useBulkActionsScope() {
  return useContext(BulkActionsScopeContext);
}

/**
 * Projects collection-owned controls into a FilterBar without lifting their
 * fast-changing state into the page that computes the collection.
 */
export function ContextualActionsPortal({
  targetId,
  active,
  children,
}: {
  targetId: string;
  active: boolean;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById(targetId));
  }, [targetId]);

  useLayoutEffect(() => {
    if (!target) return;
    const controls = target.parentElement?.querySelector<HTMLElement>(
      '[data-slot="filter-controls"]',
    );

    target.classList.toggle("pointer-events-none", !active);
    target.classList.toggle("opacity-0", !active);
    target.toggleAttribute("inert", !active);
    target.setAttribute("aria-hidden", String(!active));
    controls?.toggleAttribute("inert", active);
    controls?.classList.toggle("pointer-events-none", active);
    controls?.classList.toggle("opacity-0", active);

    return () => {
      target.removeAttribute("inert");
      target.removeAttribute("aria-hidden");
      controls?.removeAttribute("inert");
      controls?.classList.remove("pointer-events-none", "opacity-0");
    };
  }, [active, target]);

  return target ? createPortal(children, target) : null;
}
