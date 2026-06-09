import type { AppTemplate } from "@/types";

// A minimal starting point: valid MCP App HTML with nothing but a heading, so a
// new app renders immediately and the author can replace the body. No host SDK —
// templates that need the App Data Store start from `form` instead.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <style>
    body { font-family: var(--font-sans, system-ui, sans-serif); margin: 0; padding: 2rem; color: var(--color-text-primary, #111); }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: var(--color-text-secondary, #666); margin: 0; }
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
