import { readFileSync } from "node:fs";
import path from "node:path";
import config from "@/config";

/**
 * Demo MCP Apps seeded into organizations that have never had an app, so the
 * Apps page demonstrates what apps can do instead of starting empty (see
 * `seedDefaultAppsForPristineOrgs` in `database/seed.ts`). Each app's HTML is
 * a plain committed document under `src/static/default-apps/` (the static dir
 * the build already copies to dist) — not a TS template literal, so authors
 * can edit real HTML and backslashes/backticks survive verbatim.
 *
 * Identity is the `templateId` provenance marker stored on the app row. Seeded
 * apps are ordinary apps in every other way: org-scoped, fully editable, and
 * deletable — a deleted one is never resurrected because seeding only targets
 * orgs with no app rows at all (soft-deleted included).
 */
interface DefaultAppDefinition {
  /** Stable provenance marker stored in `apps.template_id`; never reuse. */
  templateId: string;
  name: string;
  description: string;
  /** Filename under the backend static dir's `default-apps/`. */
  htmlFile: string;
}

export const DEFAULT_APPS: readonly DefaultAppDefinition[] = [
  {
    templateId: "default-app:demo-task-tracker",
    name: "Demo Task Tracker",
    description:
      "A simple task tracker demo app that uses Archestra's persistent shared data layer. Features a cinematic intro loader and lets colleagues collaborate on tasks together.",
    htmlFile: "demo-task-tracker.html",
  },
  {
    templateId: "default-app:demo-multiplayer-video-game",
    name: "Demo Multiplayer Video Game",
    description:
      "An 8-bit styled 2D top-down multiplayer shooter with a randomly generated map, built as a mini app in Archestra. Uses Archestra's shared data layer for multiplayer state and persistent storage so it can be shared with colleagues and played together.",
    htmlFile: "demo-multiplayer-video-game.html",
  },
  {
    templateId: "default-app:demo-data-analysis-tool",
    name: "Demo Data Analysis Tool",
    description:
      "A stylish graph viewer with timeframe selectors and a cinematic intro loader, built as a mini app in Archestra using the shared data layer for persistent, multiplayer-friendly storage.",
    htmlFile: "demo-data-analysis-tool.html",
  },
  {
    templateId: "default-app:demo-3d-object-viewer",
    name: "Demo 3D Object Viewer",
    description:
      "A stylish 3D object viewer that displays a randomly generated complex 3D shape you can rotate, with a cinematic fade-in/fade-out intro loader. Built as a mini app in Archestra.",
    htmlFile: "demo-3d-object-viewer.html",
  },
];

/**
 * Read a default app's HTML from the backend static dir (same dir the sandbox
 * proxy is served from, so it resolves in src under tsx/vitest and in dist in
 * a production build).
 */
export function loadDefaultAppHtml(app: DefaultAppDefinition): string {
  const file = path.join(
    path.dirname(config.mcpSandbox.filePath),
    "default-apps",
    app.htmlFile,
  );
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `Default app HTML "${app.htmlFile}" not found at ${file}. The file is committed under src/static/default-apps and copied to dist by the build. Cause: ${String(err)}`,
    );
  }
}
