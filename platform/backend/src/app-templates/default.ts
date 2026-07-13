import { composeManagedDocument } from "@/services/apps/app-managed-sections";
import type { AppTemplate } from "@/types";

// The one opinionated starter: the platform-owned managed-sections shell (four
// owned nodes — see app-managed-sections.ts) with a plain empty state. It is
// built through composeManagedDocument so the shell has a single definition and
// every new app starts as a managed document the author edits by section
// (edit_app's sections mode). Product guidance lives in the Apps UI, not in
// source the author must delete first — so the body is just the app's name and
// a one-line prompt and the script starts empty. `{{APP_NAME}}` is substituted
// (HTML-escaped) with the real name when the app is created
// (resolveCreateAppHtml); the platform injects the theme stylesheet at render
// time, so this carries only its own layout.
const html = composeManagedDocument({
  title: "{{APP_NAME}}",
  css: `
    body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; }
    #app { display: flex; flex-direction: column; gap: 0.5rem; text-align: center; padding: 2rem; }
    h1 { margin: 0; font-size: 2rem; }
    p { margin: 0; color: var(--color-text-secondary); }
  `,
  body: `
    <h1>{{APP_NAME}}</h1>
    <p>Send a prompt describing what you want to build.</p>
  `,
  javascript: "",
});

export const defaultTemplate: AppTemplate = {
  id: "default",
  name: "Starter",
  description: "A minimal starter with the app's name and a prompt to build.",
  html,
};
