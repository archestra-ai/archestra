export const REPLAY_BLOCK_SELECTOR = [
  "img",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
].join(", ");

export function stripTelemetryUrlContent(url: string): string {
  return url.split(/[?#]/)[0];
}

/** Sanitize full snapshots and incremental mutations before capture. */
export function sanitizeReplaySnapshots(snapshots: unknown): boolean {
  // Packed events cannot be inspected. Reject them if the recorder format changes.
  if (
    !Array.isArray(snapshots) ||
    !snapshots.every(
      (event) =>
        isRecord(event) &&
        typeof event.type === "number" &&
        !("cv" in event) &&
        isRecord(event.data),
    )
  ) {
    return false;
  }

  const pending: unknown[] = [...snapshots];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === "attributes" && isRecord(child)) {
          for (const attribute of Object.keys(child)) {
            if (!LAYOUT_ATTRIBUTES.has(attribute)) {
              delete child[attribute];
            } else {
              child[attribute] = stripAttributeUrls(child[attribute]);
            }
          }
        } else if (child && typeof child === "object") {
          pending.push(child);
        }
      }
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripAttributeUrls(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/url\((?:[^)'"\n]|"[^"]*"|'[^']*')*\)/gi, "none");
  }
  if (Array.isArray(value)) return value.map(stripAttributeUrls);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        stripAttributeUrls(child),
      ]),
    );
  }
  return value;
}

// Keep rendering information; omit link targets, accessible labels, identifiers,
// custom data attributes, and other fields that can duplicate private page text.
const LAYOUT_ATTRIBUTES = new Set([
  "class",
  "style",
  "role",
  "type",
  "width",
  "height",
  "colspan",
  "rowspan",
  "checked",
  "selected",
  "disabled",
  "multiple",
  "open",
  "dir",
  "data-slot",
  "data-state",
  "data-side",
  "data-orientation",
  "aria-expanded",
  "aria-checked",
  "aria-selected",
  "aria-disabled",
  "aria-hidden",
  "viewBox",
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "transform",
  "preserveAspectRatio",
  "_cssText",
  "rr_scrollTop",
  "rr_scrollLeft",
  "rr_width",
  "rr_height",
]);
