// Safe interpolation of an app's author-controlled identity (its name and its
// standalone-page link) into model-facing text the chat renders as markdown.
// Kept in one place so scaffold/edit/render/publish surface an identical,
// human-labeled link — never a bare `/a/<id>` path a weak model mangles into a
// raw-UUID link label or a leading-slash-dropped relative href — and so a name
// (unrestricted in its characters) can never inject markdown wherever it appears.

// An app's standalone page. Root-relative on purpose: origin-qualifying it would
// break white-label deployments served from another host.
export function appRunUrl(appId: string): string {
  return `/a/${appId}`;
}

// A markdown link to an app's standalone page, labeled with its name, safe to
// interpolate into model-facing text the chat renders as markdown. The label is
// escaped so a name containing `](` cannot terminate the label and inject a
// second link; a blank or whitespace-only name falls back to a visible label.
export function appRunLink(name: string, appId: string): string {
  const label = escapeAppNameForModelText(name);
  return `[${label === "" ? "Open app" : label}](${appRunUrl(appId)})`;
}

// An app name made safe to interpolate as literal text into model-facing
// markdown: whitespace (including newlines, which could start a new block) is
// collapsed, and every markdown-significant ASCII punctuation character is
// backslash-escaped so the name renders verbatim and can never inject an image,
// link, heading, or code fence. Each `\x` collapses back to `x` when rendered,
// so the escaping is invisible to the user. Empty for a blank name.
export function escapeAppNameForModelText(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim();
  return collapsed.replace(MARKDOWN_PUNCTUATION, (char) => `\\${char}`);
}

// An app name made safe as PLAINTEXT tool metadata — a launch tool's title or
// description, which many MCP clients render without markdown. Newlines, control
// (\p{Cc}) and format (\p{Cf}, e.g. the U+202E bidi override) characters collapse
// to single spaces so the name stays one readable line, cannot break out of the
// surrounding sentence, and cannot bidi-spoof it. Deliberately NOT markdown-
// escaped: a backslash would show up literally in a plaintext client, so this is
// the plaintext-context counterpart of escapeAppNameForModelText.
export function sanitizeAppNameForToolMetadata(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

// The launch tool's human-facing title and description for an app, as shown in
// MCP tool lists (plaintext in many clients). Derived from the app name and
// sanitized as tool metadata so both stay one readable line and cannot smuggle
// control or bidi characters. Kept here so every producer — backing-tool
// creation, the gateway serve path, and rename sync — renders one identical,
// safe string instead of re-inlining the template.
export function appLaunchToolTitle(name: string): string {
  const safe = sanitizeAppNameForToolMetadata(name);
  return safe === "" ? "Open app" : `Open ${safe}`;
}

export function appLaunchToolDescription(name: string): string {
  const safe = sanitizeAppNameForToolMetadata(name);
  // Fall back to an unquoted, still-useful string when a name of only control/
  // format characters sanitizes away — mirrors appRunLink's blank-name label.
  return safe === ""
    ? "Open the app and render its UI."
    : `Open the "${safe}" app and render its UI.`;
}

const MARKDOWN_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;
