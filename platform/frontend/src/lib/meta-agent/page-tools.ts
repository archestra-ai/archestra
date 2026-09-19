import {
  META_AGENT_UI_TOOL_NAMES,
  type MetaAgentUiToolName,
} from "@archestra/shared";

/**
 * Marks a subtree the assistant must neither read nor act on — its own
 * dialog. Without it every snapshot would describe the chat the model is
 * already in, and a click could land on the assistant's own controls.
 */
export const META_AGENT_IGNORE_ATTRIBUTE = "data-meta-agent-ignore";

/**
 * Runs the in-app assistant's page tools against the live DOM. The backend
 * declares them without an implementation; their calls stream here and the
 * result goes back to the model as the tool output. Everything happens inside
 * the user's own browser session, so the assistant can do exactly what the
 * user could do by hand.
 */
class MetaAgentPageTools {
  private navigate: ((path: string) => void) | null = null;

  /** The app router's push, registered by the mounted assistant dialog. */
  setNavigator(navigate: ((path: string) => void) | null) {
    this.navigate = navigate;
  }

  async execute(
    toolName: MetaAgentUiToolName,
    input: Record<string, unknown>,
  ): Promise<PageSnapshot> {
    switch (toolName) {
      case META_AGENT_UI_TOOL_NAMES.GET_PAGE:
        return snapshotPage();
      case META_AGENT_UI_TOOL_NAMES.NAVIGATE:
        return this.navigateTo(String(input.path ?? ""));
      case META_AGENT_UI_TOOL_NAMES.CLICK:
        clickElement(findRef(input.ref));
        return settleAndSnapshot();
      case META_AGENT_UI_TOOL_NAMES.FILL:
        fillElement(findRef(input.ref), String(input.value ?? ""));
        return settleAndSnapshot();
      case META_AGENT_UI_TOOL_NAMES.PRESS_KEY:
        pressKey({
          key: String(input.key ?? ""),
          target:
            input.ref === undefined || input.ref === null
              ? null
              : findRef(input.ref),
        });
        return settleAndSnapshot();
    }
  }

  private async navigateTo(path: string): Promise<PageSnapshot> {
    // Same-origin app paths only: "//host" is protocol-relative and would
    // leave the app, which is not something this tool should ever do.
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error(`Expected an app path starting with "/", got "${path}"`);
    }
    if (!this.navigate) {
      throw new Error("Navigation is not available right now");
    }
    const target = new URL(path, window.location.origin).pathname;
    this.navigate(path);
    await waitFor(() => window.location.pathname === target, 5000);
    return settleAndSnapshot();
  }
}

export const metaAgentPageTools = new MetaAgentPageTools();

export type PageSnapshot = {
  url: string;
  title: string;
  /**
   * The page as text: headings, visible text, and interactive elements as
   * `[ref] role "name"` lines the other tools address by ref.
   */
  content: string;
  truncated: boolean;
};

// ===
// Internal helpers
// ===

const REF_ATTRIBUTE = "data-meta-ref";
const MAX_SNAPSHOT_CHARS = 16_000;
const MAX_NAME_CHARS = 80;
const SETTLE_MS = 450;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=true]",
  "[contenteditable='']",
  ...[
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "checkbox",
    "radio",
    "switch",
    "combobox",
    "treeitem",
    "gridcell",
  ].map((role) => `[role=${role}]`),
].join(",");

const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "IFRAME",
]);

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIALOG",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);

function snapshotPage(): PageSnapshot {
  for (const stale of document.querySelectorAll(`[${REF_ATTRIBUTE}]`)) {
    stale.removeAttribute(REF_ATTRIBUTE);
  }

  const lines: string[] = [];
  let pending = "";
  let nextRef = 1;
  const flush = () => {
    const text = pending.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    pending = "";
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pending += ` ${node.textContent ?? ""}`;
      return;
    }
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) return;
    const element = node;
    if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) return;
    if (element.hasAttribute(META_AGENT_IGNORE_ATTRIBUTE)) return;
    if (isClosingOverlay(element)) return;
    if (!isVisible(element)) return;

    if (element.matches(INTERACTIVE_SELECTOR)) {
      flush();
      const ref = nextRef++;
      element.setAttribute(REF_ATTRIBUTE, String(ref));
      lines.push(describeInteractive(element, ref));
      return;
    }

    const heading = /^H([1-6])$/.exec(element.tagName);
    if (heading) {
      flush();
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) lines.push(`${"#".repeat(Number(heading[1]))} ${text}`);
      return;
    }

    const isBlock =
      BLOCK_TAGS.has(element.tagName) ||
      element.getAttribute("role") === "dialog";
    if (isBlock) flush();
    if (element.getAttribute("role") === "dialog") lines.push("--- dialog ---");
    for (const child of element.childNodes) walk(child);
    if (element.tagName === "TD" || element.tagName === "TH") pending += " |";
    if (isBlock) flush();
  };

  walk(document.body);
  flush();

  let content = lines.join("\n");
  const truncated = content.length > MAX_SNAPSHOT_CHARS;
  if (truncated) content = content.slice(0, MAX_SNAPSHOT_CHARS);

  return {
    url: `${window.location.pathname}${window.location.search}`,
    title: document.title,
    content,
    truncated,
  };
}

function describeInteractive(element: Element, ref: number): string {
  const role = roleOf(element);
  const parts = [`[${ref}] ${role}`];
  const name = accessibleName(element);
  if (name) parts.push(JSON.stringify(name));

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    if (
      element instanceof HTMLInputElement &&
      (element.type === "checkbox" || element.type === "radio")
    ) {
      parts.push(element.checked ? "(checked)" : "(unchecked)");
    } else if (element.type !== "password") {
      if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
      if (element.placeholder && !element.value) {
        parts.push(`placeholder=${JSON.stringify(element.placeholder)}`);
      }
    }
  } else if (element instanceof HTMLSelectElement) {
    parts.push(`value=${JSON.stringify(element.value)}`);
  }

  for (const state of ["checked", "selected", "expanded", "pressed"]) {
    const value = element.getAttribute(`aria-${state}`);
    if (value === "true") parts.push(`(${state})`);
  }
  if (element.getAttribute("data-state") === "active") parts.push("(active)");
  if (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    parts.push("(disabled)");
  }
  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute("href");
    if (href) parts.push(`-> ${href}`);
  }
  return parts.join(" ");
}

function roleOf(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  switch (element.tagName) {
    case "A":
      return "link";
    case "SELECT":
      return "select";
    case "TEXTAREA":
      return "textbox";
    case "SUMMARY":
      return "summary";
    case "INPUT": {
      const type = (element as HTMLInputElement).type;
      if (["checkbox", "radio", "range", "file"].includes(type)) return type;
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    case "BUTTON":
      return "button";
    default:
      return element.hasAttribute("contenteditable") ? "textbox" : "element";
  }
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const fromLabelledBy = labelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const labels =
    "labels" in element
      ? Array.from((element as HTMLInputElement).labels ?? [])
          .map((label) => label.textContent ?? "")
          .join(" ")
      : "";
  const candidates = [
    element.getAttribute("aria-label"),
    fromLabelledBy,
    labels,
    // innerText skips hidden descendants; textContent covers environments
    // without layout, where innerText is not implemented.
    (element instanceof HTMLElement && element.innerText) ||
      element.textContent,
    element.getAttribute("title"),
    element.querySelector("img[alt]")?.getAttribute("alt"),
    element.getAttribute("name"),
  ];
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, " ").trim();
    if (text) {
      return text.length > MAX_NAME_CHARS
        ? `${text.slice(0, MAX_NAME_CHARS)}…`
        : text;
    }
  }
  return "";
}

/**
 * A dialog or menu that is animating out: Radix keeps it mounted, marked
 * closed, until the exit animation ends. Describing it would tell the model
 * the dialog it just closed is still open.
 */
function isClosingOverlay(element: Element): boolean {
  return (
    element.getAttribute("data-state") === "closed" &&
    CLOSABLE_OVERLAY_ROLES.has(element.getAttribute("role") ?? "")
  );
}

const CLOSABLE_OVERLAY_ROLES = new Set([
  "dialog",
  "alertdialog",
  "menu",
  "listbox",
]);

function isVisible(element: Element): boolean {
  if (element.getClientRects().length === 0) {
    // display:contents wrappers have no box of their own but render children.
    return getComputedStyle(element).display === "contents";
  }
  // Opacity is deliberately not checked: enter animations start at opacity 0,
  // so a dialog the assistant just opened would read as invisible.
  return getComputedStyle(element).visibility !== "hidden";
}

function findRef(ref: unknown): HTMLElement {
  const element = document.querySelector(`[${REF_ATTRIBUTE}="${Number(ref)}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(
      `No element with ref ${String(ref)} on the page — take a fresh snapshot`,
    );
  }
  return element;
}

function clickElement(element: HTMLElement) {
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = element.getBoundingClientRect();
  const coordinates = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  // Radix triggers (dropdowns, selects, popovers) open on pointerdown rather
  // than click, so a bare element.click() would do nothing on them.
  const pointer = { ...coordinates, pointerId: 1, pointerType: "mouse" };
  element.dispatchEvent(new PointerEvent("pointerdown", pointer));
  element.dispatchEvent(new MouseEvent("mousedown", coordinates));
  element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerup", pointer));
  element.dispatchEvent(new MouseEvent("mouseup", coordinates));
  element.click();
}

function fillElement(element: HTMLElement, value: string) {
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus();
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    // React tracks the value through the prototype's setter; assigning
    // element.value directly would be swallowed as a no-op change.
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, value);
    return;
  }
  throw new Error("That element is not a text field");
}

function pressKey(params: { key: string; target: HTMLElement | null }) {
  const target =
    params.target ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body);
  if (params.target) params.target.focus();
  const init = { key: params.key, bubbles: true, cancelable: true };
  const notCanceled = target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  // A synthetic Enter does not submit a form by itself.
  if (
    notCanceled &&
    params.key === "Enter" &&
    target instanceof HTMLInputElement &&
    target.form
  ) {
    target.form.requestSubmit();
  }
}

async function settleAndSnapshot(): Promise<PageSnapshot> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return snapshotPage();
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
