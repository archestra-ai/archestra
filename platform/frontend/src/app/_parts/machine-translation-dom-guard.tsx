"use client";

// Chrome's built-in page translation (and similar machine-translation
// browser features) rewrites the text nodes it translates by re-parenting
// them into injected <font> wrappers. React still holds references to the
// original nodes, so its next commit that unmounts affected DOM throws
// "NotFoundError: Failed to execute 'removeChild' on 'Node'" and crashes
// the whole page (facebook/react#11538) — e.g. any route change after the
// user translates the app. React upstream does not handle this; the
// established mitigation is to make the two DOM operations React relies on
// tolerant of nodes a translator has moved.
//
// Accepted trade-off: the guard suppresses EVERY parent-mismatch on these
// two methods, not just translator-caused ones, so a genuine DOM bug
// (React's or any other consumer's) that would have thrown now no-ops.
// The warnOnce below keeps such cases observable in the console.
let installed = false;
let warned = false;

function warnOnce(operation: string) {
  if (warned) return;
  warned = true;
  console.warn(
    `Skipped DOM ${operation} on a node re-parented by machine translation (e.g. Chrome page translate). Suppressing to avoid crashing React; translated text may render stale until the next navigation.`,
  );
}

export function installMachineTranslationDomGuard() {
  if (installed || typeof Node === "undefined") return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      warnOnce("removeChild");
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    reference: Node | null,
  ): T {
    if (reference && reference.parentNode !== this) {
      warnOnce("insertBefore");
      return node;
    }
    return originalInsertBefore.call(this, node, reference) as T;
  };
}

// Install at module evaluation, not in an effect: effects run after the
// hydration commit, which would leave a window where auto-translation of the
// server-rendered HTML could still crash React. Chunk evaluation happens
// before hydration starts, and the typeof Node guard makes this a no-op
// during SSR.
installMachineTranslationDomGuard();

export function MachineTranslationDomGuard() {
  return null;
}
