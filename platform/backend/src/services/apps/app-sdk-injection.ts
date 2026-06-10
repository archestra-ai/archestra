// Marker attributes on the injected <script> elements, so served documents are
// recognizable in tests and debugging.
const APP_BOOTSTRAP_MARKER = "data-archestra-app-bootstrap";
const APP_SDK_MARKER = "data-archestra-app-sdk";

/** Path the backend serves the Apps SDK on (see server.ts). */
export const APP_SDK_PATH = "/_sandbox/archestra-app-sdk.js";

/** One assigned-tool descriptor embedded for `archestra.tools.list()`. */
export interface AppSdkTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

/**
 * Per-viewer values the SDK reads from `window.__ARCHESTRA_APP_CONTEXT__`.
 *
 * @public — consumed by the injection tests, which knip --production ignores
 */
export interface AppSdkContext {
  user: { id: string; name: string } | null;
  tools: AppSdkTool[];
}

/**
 * Inject the Archestra Apps SDK into an owned app's HTML at serve time, so
 * apps author pure UI and never carry protocol glue (SDK import, transport,
 * tool-name plumbing). Two scripts land at the start of <head>, in order:
 *
 * 1. an inline bootstrap defining `window.__ARCHESTRA_APP_CONTEXT__` — the
 *    per-viewer values (identity, assigned-tool descriptors) the static SDK
 *    file reads at parse time, so the file itself stays user-independent and
 *    cacheable;
 * 2. a blocking classic `<script src>` for the SDK (static/archestra-app-sdk.js,
 *    served on {@link APP_SDK_PATH}), which defines `window.archestra`
 *    synchronously before any app script runs. The root-relative src resolves
 *    against the sandbox proxy's base URL (srcdoc and document.write children
 *    both inherit it), and the proxy allowlists exactly that URL in script-src.
 *
 * Neither script is stored in app_versions — they ship fresh on every
 * resources/read, so SDK fixes apply to all apps from one place. The sandbox
 * proxy later injects the CSP meta + `__ARCHESTRA_APP_SDK_URL__` global at the
 * same anchor and therefore always precedes the bootstrap.
 */
export function injectAppSdk(html: string, context: AppSdkContext): string {
  const bootstrap =
    `<script ${APP_BOOTSTRAP_MARKER}>window.__ARCHESTRA_APP_CONTEXT__=` +
    `${serializeInlineScriptValue(context)};</script>`;
  const sdkTag = `<script ${APP_SDK_MARKER} src="${APP_SDK_PATH}"></script>`;
  const injection = `${bootstrap}${sdkTag}`;

  // No injected-already guard: stored HTML never contains the SDK (it is never
  // persisted), and a content-based scan could be tripped by an app merely
  // mentioning the marker, silently losing window.archestra.
  // Anchors tolerate attributes (<head lang="en">) — matching the save-time
  // validator's predicate — so an attribute-bearing head never falls through
  // to a duplicate-head branch. The proxy's exact-match injectCSP still lands
  // its CSP + SDK URL at or before the document start in every combination,
  // i.e. always ahead of the bootstrap.
  // (\s[^>]*)? — attributes allowed, but never a longer tag name (<header>).
  // Replacements use a function: the injection embeds attacker-influenced JSON
  // (display names, tool descriptions), and a string replacement would expand
  // `$&`/`$'`-style substitution patterns in it — splicing raw document text
  // back into the inline script past the serializer's escaping.
  const head = /(<head(\s[^>]*)?>)/i.exec(html);
  if (head) {
    return html.replace(head[1], () => `${head[1]}${injection}`);
  }
  const htmlTag = /(<html(\s[^>]*)?>)/i.exec(html);
  if (htmlTag) {
    return html.replace(
      htmlTag[1],
      () => `${htmlTag[1]}<head>${injection}</head>`,
    );
  }
  const doctype = /(<!DOCTYPE[^>]*>)/i.exec(html);
  if (doctype) {
    return html.replace(
      doctype[1],
      () => `${doctype[1]}<head>${injection}</head>`,
    );
  }
  return `${injection}${html}`;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Serialize a value for embedding inside an inline <script>. JSON.stringify
 * alone is NOT enough: a viewer display name containing `</script>` is
 * attacker-controlled text that would terminate the script element, so `<`/`>`
 * are emitted as JS unicode escapes (U+2028/U+2029 likewise — they are line
 * terminators in JS string literals).
 */
function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
