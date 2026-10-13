---
name: design-arena
description: Run a design arena: a coordinator fans out N subagents (default 7) that each prototype one UI section through a different lens, switchable in-app via a temporary prototype selector, refined in rounds.
---

# Design Arena

Hammer out many design directions for ONE section of a real app page and find what looks good. You (the coordinator) mount a temporary prototype selector in that section, fan out N subagents that each build one variant through a distinct lens, then refine round after round from the user's feedback until one wins.

**N (variant count):** default 7; use whatever the user asks for, and it can change between rounds.

**This is about looks, not engineering.** No tests, no linting passes, no polish beyond what's needed to judge the design. A variant only has to render with real data. Reuse existing components and data; mock what doesn't exist. Every subagent reads and applies the repo's design taste skill (e.g. `design-taste-frontend`) before building; if none exists, ask the user which taste guide to use.

## Inputs
- **Target**: page + section (e.g. `/connection`, step 2) and the file that renders it.
- **Requirements**: what the section must communicate/do. Ask if missing.
- **App URL** where the user flips variants live.

## The prototype selector (same every time)
Scaffolding, never committed. Put it in `__arena__.tsx` next to the target section, variants in `__arena__/v1.tsx` … `vN.tsx`, and list both paths in `.git/info/exclude`. Mark the one import you add to the real section file with `// design-arena: do not commit`.

Look: a compact pill bar under the section heading: muted "Prototype", then "Current", then `1` … `N`; small text, subtle bordered rounded container, selected item bold on a lighter background.

```tsx
"use client";
import { type ReactNode, useState } from "react";

export function DesignArena({ current, variants }: { current: ReactNode; variants: ReactNode[] }) {
  const [sel, setSel] = useState(-1);
  return (
    <div className="space-y-3">
      <div className="inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
        <span className="pr-1 text-muted-foreground">Prototype</span>
        {["Current", ...variants.map((_, i) => `${i + 1}`)].map((label, i) => (
          <button key={label} type="button" onClick={() => setSel(i - 1)}
            className={`rounded px-1.5 py-0.5 ${sel === i - 1 ? "bg-background font-semibold" : "text-muted-foreground"}`}>
            {label}
          </button>
        ))}
      </div>
      {sel < 0 ? current : variants[sel]}
    </div>
  );
}
```

Adapt class names if the repo isn't Tailwind/shadcn, keeping the look.

## Commit guard (Biome)
One-time per repo, if not already present: add a Biome GritQL plugin that fails lint on any arena import, and register it in `biome.json` (`"plugins": ["./biome-plugins/design-arena.grit"]`). This guard file is the only arena-related thing that gets committed.

```grit
`import $_ from $source` where {
  $source <: r".*__arena__.*",
  register_diagnostic(span=$source, message="design-arena: do not commit")
}
```

Run Biome once on the section file with the arena import in place to confirm the rule fires; adjust the pattern if the repo's Biome version needs different syntax.

## Round loop
1. **Mount** the selector with "Current" = today's section.
2. **Pick N lenses**: genuinely different takes (layout, density, metaphor, interaction, scale). Post them as a numbered one-liner list.
3. **Fan out** N subagents in parallel, one file each. Brief: requirements, its lens, accumulated feedback constraints, the taste skill, its file, data hooks to reuse, touch nothing else.
4. **Check** each variant renders; re-spawn broken ones.
5. **Present** the URL and numbered list; ask which wins and what to change.
6. **Refine**: the winner (or a blend) becomes the baseline. Restate feedback as concrete constraints carried into every future brief (ask first if feedback is ambiguous), pick N new lenses on the open questions, repeat from 3.

## Ending
When the user picks a final variant: move it into the real section code, delete `__arena__.tsx`, `__arena__/`, the marked import and the `.git/info/exclude` lines, confirm the page renders.
