import type { AppTemplate } from "@/types";

// A minimal starting point. The platform injects a baseline stylesheet (theme
// variables, themed element defaults, .arch-* components — see
// services/apps/app-sdk-injection.ts) plus `window.archestra` (user identity,
// storage, tools) at render time, so this template carries no theme and stays
// pure UI: add only app-specific CSS.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
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
