/** Internal omission mark. JSON cannot forge it. The provider never sees it. */
const rewriteOmission: unique symbol = Symbol("openappa.rewriteOmission");

const ORIGIN_DESCRIPTION = "openappa.rewriteOrigin";

export function isOmitted(value: unknown): boolean {
  return !!value && typeof value === "object" && rewriteOmission in value;
}

export function hasCapturedOrigin(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.getOwnPropertySymbols(value).some(
    (symbol) => symbol.description === ORIGIN_DESCRIPTION,
  );
}

/** Marks a captured holder omitted. Does not copy or clear its fields. */
export function markOmitted<T extends object>(node: T): T {
  if (!isOmitted(node)) {
    Object.defineProperty(node, rewriteOmission, {
      value: true,
      enumerable: true,
      configurable: true,
    });
  }
  return node;
}

/**
 * Stubs for nested captured holders that a canonical replacement must not keep.
 * Each stub has provenance only, so a denied child payload cannot ride along.
 */
/**
 * Replaces holder content without dropping captured child origins.
 * The replacement text is visible. Denied or emptied source fields are not.
 */
export function retainOmittedContent(
  previous: unknown,
  next: unknown,
): unknown {
  const stubs = omissionStubs({ content: previous });
  if (stubs.length === 0) return next;
  const visible = Array.isArray(next)
    ? next.filter((entry) => !isOmitted(entry))
    : typeof next === "string"
      ? [{ type: "text", text: next }]
      : [next];
  return [...stubs, ...visible];
}

export function omissionStubs(source: object): object[] {
  const stubs: object[] = [];
  const visit = (node: unknown, root: boolean) => {
    if (!node || typeof node !== "object") return;
    if (!root && hasCapturedOrigin(node)) {
      stubs.push(markOmitted(preserveProvenance(node, {})));
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      const child = record[key];
      if (Array.isArray(child)) {
        for (const item of child) visit(item, false);
        continue;
      }
      visit(child, false);
    }
  };
  visit(source, true);
  return stubs;
}

/**
 * Copies enumerable symbol provenance, including rewriteOrigin, onto a
 * replacement built from an existing source node. New injected nodes stay unmarked.
 */
function preserveProvenance<T extends object>(source: object, target: T): T {
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    if (Object.hasOwn(target, symbol)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
    if (!descriptor?.enumerable) continue;
    Object.defineProperty(target, symbol, descriptor);
  }
  return target;
}

/**
 * Own-key copy. `Object.fromEntries` and `Object.assign` honor a `__proto__`
 * key as a prototype setter, so a restored JSON object must not use them.
 */
type OwnRecord = Record<string, unknown> & { [key: symbol]: unknown };

export function copyOwnRecord(
  source: object,
  entries: readonly [string, unknown][],
): OwnRecord {
  const next: OwnRecord = {};
  for (const [key, value] of entries) {
    Object.defineProperty(next, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return preserveProvenance(source, next);
}
