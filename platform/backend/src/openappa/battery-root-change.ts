import { isDeepStrictEqual } from "node:util";
import { asRecord, parsePolicyToml } from "@/openappa/policy-text";

/**
 * What a change to the policy file does when all it does is attach or detach
 * bundled batteries for MCP servers, the change a server's editor may propose
 * without the permission to update guardrails: the tool prefixes whose rules
 * it changes, every one of which the caller then holds to the requester's
 * edit access. Any other change is refused, with why.
 *
 * The rest of the file must stay as it was, parsed: every table and key but
 * `include` and `[aliases.mcp]`. An include entry may come or go only as a
 * bundled battery's, `batteries/<name>/appa.toml`, and only for a battery
 * that governs MCP servers through its namespaces; one that governs the
 * organization is refused. An `[aliases.mcp]` binding may change only for a
 * namespace one bundled battery the file includes declares, and no other
 * battery it includes: a binding is the server list of every battery that
 * declares its namespace. A battery added touches every target its
 * namespaces are bound to afterwards, one removed every target they were
 * bound to before, and a binding changed the targets it gains or loses.
 */
export async function batteryRootChange(params: {
  before: string;
  after: string;
  /**
   * The namespaces a bundled battery declares: none for one that governs the
   * organization, null for a name no bundled battery has.
   */
  namespacesOf: (name: string) => Promise<readonly string[] | null>;
  /**
   * The namespaces the battery an include entry other than a bundled one
   * names declares, such as an uploaded package's: null when nothing answers
   * the entry.
   */
  includedNamespacesOf: (entry: string) => Promise<readonly string[] | null>;
}): Promise<{ prefixes: Set<string> } | { refused: string }> {
  const before = parsePolicyToml(params.before);
  const after = parsePolicyToml(params.after);
  if (!before || !after) return { refused: "the policy file does not parse" };
  if (
    !isDeepStrictEqual(withoutBatteryParts(before), withoutBatteryParts(after))
  )
    return { refused: CHANGES_MORE };
  const listedBefore = includeEntries(before);
  const listedAfter = includeEntries(after);
  const boundBefore = mcpAliases(before);
  const boundAfter = mcpAliases(after);
  if (!listedBefore || !listedAfter || !boundBefore || !boundAfter)
    return { refused: CHANGES_MORE };
  const includedBefore = new Set(listedBefore);
  const includedAfter = new Set(listedAfter);
  // The entries both keep stay as they were, in order and count: only a
  // battery's own entry may come or go.
  if (
    listedAfter.length !== includedAfter.size ||
    !isDeepStrictEqual(
      listedBefore.filter((entry) => includedAfter.has(entry)),
      listedAfter.filter((entry) => includedBefore.has(entry)),
    )
  )
    return { refused: CHANGES_MORE };
  const added = [...includedAfter].filter(
    (entry) => !includedBefore.has(entry),
  );
  const removed = [...includedBefore].filter(
    (entry) => !includedAfter.has(entry),
  );
  const prefixes = new Set<string>();
  const namespaces = new Map<string, readonly string[] | null>();
  const declared = async (entry: string) => {
    const name = BUNDLED_ENTRY.exec(entry)?.[1];
    if (name === undefined) return null;
    if (!namespaces.has(name))
      namespaces.set(name, await params.namespacesOf(name));
    return namespaces.get(name) ?? null;
  };
  for (const [entries, bound] of [
    [added, boundAfter],
    [removed, boundBefore],
  ] as const)
    for (const entry of entries) {
      const name = BUNDLED_ENTRY.exec(entry)?.[1];
      if (name === undefined)
        return {
          refused: `it changes the include ${JSON.stringify(entry)}, which is not a bundled battery's`,
        };
      const declares = await declared(entry);
      if (declares === null)
        return { refused: `no bundled battery is named ${name}` };
      if (declares.length === 0)
        return {
          refused: `${name} governs every tool call in the organization, not one MCP server's`,
        };
      for (const namespace of declares)
        for (const target of bound.get(namespace) ?? []) prefixes.add(target);
    }
  // Every namespace a bundled battery the file includes declares, before or
  // after: the bindings a battery change may move. A binding is the server
  // list of every included battery that declares its namespace, so one that
  // another battery declares too stays as it was.
  const batteryNamespaces = new Set<string>();
  const declarers = new Map<string, number>();
  let unreadable: string | undefined;
  for (const entry of new Set([...includedBefore, ...includedAfter])) {
    const bundled = BUNDLED_ENTRY.test(entry);
    const declares = bundled
      ? await declared(entry)
      : await params.includedNamespacesOf(entry);
    if (declares === null && !bundled) unreadable ??= entry;
    for (const namespace of declares ?? []) {
      if (bundled) batteryNamespaces.add(namespace);
      declarers.set(namespace, (declarers.get(namespace) ?? 0) + 1);
    }
  }
  for (const namespace of new Set([
    ...boundBefore.keys(),
    ...boundAfter.keys(),
  ])) {
    const was = new Set(boundBefore.get(namespace) ?? []);
    const is = new Set(boundAfter.get(namespace) ?? []);
    const moved = [
      ...[...is].filter((target) => !was.has(target)),
      ...[...was].filter((target) => !is.has(target)),
    ];
    if (moved.length === 0) continue;
    if (!batteryNamespaces.has(namespace))
      return {
        refused: `it binds the namespace ${JSON.stringify(namespace)}, which no bundled battery the policy includes declares`,
      };
    if ((declarers.get(namespace) ?? 0) > 1)
      return {
        refused: `it binds the namespace ${JSON.stringify(namespace)}, which another battery the policy includes declares too, so it changes that battery's servers`,
      };
    if (unreadable !== undefined)
      return {
        refused: `it binds the namespace ${JSON.stringify(namespace)} while the policy includes ${JSON.stringify(unreadable)}, whose namespaces could not be read`,
      };
    for (const target of moved) prefixes.add(target);
  }
  if (prefixes.size === 0)
    return {
      refused:
        added.length + removed.length > 0
          ? "it includes or removes a battery without attaching it to an MCP server or detaching it from one"
          : CHANGES_MORE,
    };
  return { prefixes };
}

// ===

/** A bundled battery's include entry, as the Batteries page writes one. */
const BUNDLED_ENTRY = /^batteries\/([a-z0-9][a-z0-9_-]*)\/appa\.toml$/;

const CHANGES_MORE =
  "it changes more of the policy file than which batteries govern which MCP servers";

/** The parsed policy without `include` and `[aliases.mcp]`, for comparing the rest. */
function withoutBatteryParts(document: Record<string, unknown>) {
  const { include: _include, aliases, ...rest } = document;
  const kept = asRecord(aliases);
  if (!kept) return aliases === undefined ? rest : { ...rest, aliases };
  const { mcp: _mcp, ...otherAliases } = kept;
  return Object.keys(otherAliases).length === 0
    ? rest
    : { ...rest, aliases: otherAliases };
}

/** The include entries in order, or null when `include` is not a list of strings. */
function includeEntries(document: Record<string, unknown>): string[] | null {
  const include = document.include;
  if (include === undefined) return [];
  if (!Array.isArray(include)) return null;
  if (!include.every((entry) => typeof entry === "string")) return null;
  return include as string[];
}

/** `[aliases.mcp]` by namespace, or null when it is not a table of string lists. */
function mcpAliases(
  document: Record<string, unknown>,
): Map<string, string[]> | null {
  const mcp = asRecord(asRecord(document.aliases)?.mcp);
  const bound = new Map<string, string[]>();
  if (!mcp) return asRecord(document.aliases)?.mcp === undefined ? bound : null;
  for (const [namespace, targets] of Object.entries(mcp)) {
    if (
      !Array.isArray(targets) ||
      !targets.every((target) => typeof target === "string")
    )
      return null;
    bound.set(namespace, targets as string[]);
  }
  return bound;
}
