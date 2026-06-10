import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";

// Marker attribute on the injected <script>, so served documents are
// recognizable in tests and debugging.
const APP_RUNTIME_BRIDGE_MARKER = "data-archestra-runtime-bridge";

const dataGetTool = `${ARCHESTRA_TOOL_PREFIX}${TOOL_APP_DATA_GET_SHORT_NAME}`;
const dataSetTool = `${ARCHESTRA_TOOL_PREFIX}${TOOL_APP_DATA_SET_SHORT_NAME}`;
const dataListTool = `${ARCHESTRA_TOOL_PREFIX}${TOOL_APP_DATA_LIST_SHORT_NAME}`;
const dataDeleteTool = `${ARCHESTRA_TOOL_PREFIX}${TOOL_APP_DATA_DELETE_SHORT_NAME}`;

/**
 * The app runtime bridge: a classic inline script injected at serve time into
 * every owned app's HTML, providing `window.archestra` so apps author pure UI
 * and never carry protocol glue (SDK import, transport, tool-name plumbing).
 *
 * - Classic (non-module) script: `window.archestra` exists synchronously
 *   before any app script — module scripts and DOMContentLoaded handlers can
 *   reference it at their top level.
 * - Connects eagerly at load: the host only delivers toolInput/toolResult
 *   after the guest handshake, so an app that never calls a bridge method must
 *   still complete it. Methods await the memoized connect promise.
 * - Failure is loud: if the host didn't provide the SDK URL or connect fails,
 *   every bridge call rejects with the original error.
 *
 * The bridge is NOT stored in app_versions — it ships fresh on every
 * resources/read, so protocol fixes apply to all apps from one place. The
 * sandbox proxy later injects the CSP meta + `__ARCHESTRA_APP_SDK_URL__`
 * global at the start of <head>, i.e. before this script runs.
 */
const APP_RUNTIME_BRIDGE_SCRIPT = `<script ${APP_RUNTIME_BRIDGE_MARKER}>
(() => {
  "use strict";
  // Render-loop diagnostics: runtime errors are posted to the parent (the
  // sandbox proxy forwards them to the host), where they are validated,
  // capped, and surfaced back to the authoring model. Same channel shape as
  // the proxy's CSP-violation forwarding.
  const postDiagnostic = (errorType, message) => {
    try {
      window.parent.postMessage(
        { type: "mcp-apps:runtime-error", errorType, message: String(message).slice(0, 1000), timestamp: Date.now() },
        "*",
      );
    } catch {
      // never let diagnostics reporting break the app
    }
  };
  window.addEventListener("error", (e) => {
    postDiagnostic("error", e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : ""));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    postDiagnostic("unhandledrejection", (r && (r.stack || r.message)) || String(r));
  });
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    consoleError(...args);
    postDiagnostic(
      "console.error",
      args
        .map((a) => {
          if (a instanceof Error) return a.message;
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  };
  const connectPromise = (async () => {
    const sdkUrl = window.__ARCHESTRA_APP_SDK_URL__;
    if (!sdkUrl) {
      throw new Error("Archestra runtime bridge: host did not provide the app SDK URL");
    }
    const { App, PostMessageTransport } = await import(sdkUrl);
    const app = new App({ name: "archestra-app-bridge", version: "1.0.0" }, {});
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    return app;
  })();
  connectPromise.catch((err) => {
    console.error("Archestra runtime bridge: connect failed", err);
  });
  const callTool = async (name, args) => {
    const app = await connectPromise;
    return app.callServerTool({ name, arguments: args ?? {} });
  };
  window.archestra = {
    data: {
      get: async (key) => (await callTool(${JSON.stringify(dataGetTool)}, { key })).structuredContent?.value,
      set: (key, value) => callTool(${JSON.stringify(dataSetTool)}, { key, value }),
      list: async () => (await callTool(${JSON.stringify(dataListTool)}, {})).structuredContent?.entries ?? [],
      delete: (key) => callTool(${JSON.stringify(dataDeleteTool)}, { key }),
    },
    callTool,
    openLink: async (url) => (await connectPromise).openLink({ url }),
    requestDisplayMode: async (mode) => (await connectPromise).requestDisplayMode({ mode }),
    sendMessage: async (text) =>
      (await connectPromise).sendMessage({ role: "user", content: [{ type: "text", text }] }),
  };
})();
</script>`;

/**
 * Inject the runtime bridge into an owned app's HTML at serve time. Mirrors
 * the sandbox proxy's injectCSP fallback chain so the bridge lands at the
 * start of <head>; the proxy's own injection (CSP meta + SDK URL global) is
 * prepended later at render time and therefore always precedes the bridge.
 */
export function injectAppRuntimeBridge(html: string): string {
  // No injected-already guard: stored HTML never contains the bridge (it is
  // never persisted), and a content-based scan could be tripped by an app
  // merely mentioning the marker, silently losing window.archestra.
  const bridge = APP_RUNTIME_BRIDGE_SCRIPT;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${bridge}`);
  }
  if (html.includes("<HEAD>")) {
    return html.replace("<HEAD>", `<HEAD>${bridge}`);
  }
  if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${bridge}</head>`);
  }
  if (html.includes("<HTML>")) {
    return html.replace("<HTML>", `<HTML><head>${bridge}</head>`);
  }
  const doctype = /(<!DOCTYPE[^>]*>)/i.exec(html);
  if (doctype) {
    return html.replace(doctype[1], `${doctype[1]}<head>${bridge}</head>`);
  }
  return `${bridge}${html}`;
}
