import type { AppTemplate } from "@/types";

// A minimal starting point with a curated style baseline on the design-system
// variables, so an app scaffolded from "blank" looks decent before any custom
// CSS. Pure UI: `window.archestra` (data store, tools) is injected by the
// platform at render time — see services/apps/app-runtime-bridge.ts.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--font-sans, system-ui, sans-serif);
      margin: 0; padding: 2rem;
      color: var(--color-text-primary, #111);
      background: var(--color-background-primary, #fff);
      line-height: 1.5;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
    p { color: var(--color-text-secondary, #666); margin: 0 0 0.75rem; }
    button {
      font: inherit; padding: 0.5rem 1rem; border: none; cursor: pointer;
      border-radius: var(--border-radius-md, 6px);
      background: var(--color-background-inverse, #111);
      color: var(--color-text-inverse, #fff);
    }
    button:disabled { opacity: 0.5; cursor: default; }
    input, textarea, select {
      font: inherit; padding: 0.5rem;
      border: 1px solid var(--color-border-primary, #ccc);
      border-radius: var(--border-radius-md, 6px);
    }
    ul, ol { margin: 0 0 0.75rem; padding-left: 1.25rem; }
  </style>
</head>
<body>
  <h1>My App</h1>
  <p>Edit this app's HTML to build your interface.</p>
</body>
</html>`;

export const blankTemplate: AppTemplate = {
  id: "blank",
  name: "Blank",
  description: "An empty app you can build from scratch.",
  html,
};
