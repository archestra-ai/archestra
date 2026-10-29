/**
 * Which branches of a payload tree start open: breadth first from the root,
 * each branch opening while the rows it adds keep the first read within
 * `rowBudget`. A small payload opens whole; a large one opens as many levels
 * as fit, and a branch too big to fit stays folded while smaller ones beside
 * it still open.
 */
export function branchesToOpen(
  root: unknown,
  rowBudget: number,
): WeakSet<object> {
  const open = new WeakSet<object>();
  if (!isBranch(root)) return open;

  open.add(root);
  let rows = rowsWhenOpen(root);
  let level: object[] = [root];
  while (level.length > 0) {
    const next: object[] = [];
    for (const branch of level) {
      for (const child of childBranches(branch)) {
        const cost = rowsWhenOpen(child);
        if (rows + cost > rowBudget) continue;
        open.add(child);
        rows += cost;
        next.push(child);
      }
    }
    level = next;
  }
  return open;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * The tree shows an array longer than this as groups of this many, each
 * group folded until it is opened.
 */
const GROUP_SIZE = 100;

function isBranch(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isGrouped(branch: object): boolean {
  return Array.isArray(branch) && branch.length > GROUP_SIZE;
}

function entries(branch: object): unknown[] {
  return Array.isArray(branch) ? branch : Object.values(branch);
}

/** One row per entry, or per group for a grouped array. */
function rowsWhenOpen(branch: object): number {
  const count = entries(branch).length;
  return isGrouped(branch) ? Math.ceil(count / GROUP_SIZE) : count;
}

/** A grouped array's entries sit in folded groups, so none open with it. */
function childBranches(branch: object): object[] {
  return isGrouped(branch) ? [] : entries(branch).filter(isBranch);
}
