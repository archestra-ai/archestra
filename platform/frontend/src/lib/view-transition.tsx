import * as React from "react";

type ViewTransitionProps = {
  /** Shared-element identity: elements with the same name on the old and new
   * tree are morphed between their positions/sizes. */
  name?: string;
  /** Animation class applied when this element is paired with a same-named
   * element across a transition (targeted via ::view-transition-*(.class)). */
  share?: string;
  /** Animation class applied when this element enters during a transition. */
  enter?: string;
  /** Animation class applied when this element exits during a transition. */
  exit?: string;
  /** Fallback for activations not covered above; "none" opts out of the
   * default crossfade during unrelated transitions. */
  default?: string;
  children?: React.ReactNode;
};

// React's <ViewTransition> ships only in the experimental React channel, not in
// the standalone `react` package that TypeScript and vitest resolve. Fall back
// to rendering children unwrapped when it is unavailable — the UI is identical,
// just without the animation (the same graceful degradation as browsers without
// the View Transitions API).
const ReactViewTransition = (
  React as unknown as {
    ViewTransition?: React.ComponentType<ViewTransitionProps>;
  }
).ViewTransition;

export const ViewTransition: React.ComponentType<ViewTransitionProps> =
  ReactViewTransition ?? (({ children }) => <>{children}</>);
