import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Drizzle decides which migrations to run from the journal `when` high-water
// mark, not just the filename order. A migration appended with an older `when`
// can be silently skipped by databases that already applied a newer entry,
// leaving schema objects missing while later migrations still run.
type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type Journal = {
  entries: JournalEntry[];
};

type OutOfOrderMigration = {
  previous: JournalEntry;
  current: JournalEntry;
};

const KNOWN_LEGACY_OUT_OF_ORDER_PAIRS = new Set([
  "0253_rename-github-repository-files-flag->0254_black_skin",
]);

export function findOutOfOrderMigrations(
  entries: JournalEntry[],
): OutOfOrderMigration[] {
  const outOfOrder: OutOfOrderMigration[] = [];

  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (!previous || !current || current.when > previous.when) continue;

    const pairKey = `${previous.tag}->${current.tag}`;
    if (KNOWN_LEGACY_OUT_OF_ORDER_PAIRS.has(pairKey)) continue;

    outOfOrder.push({ previous, current });
  }

  return outOfOrder;
}

/**
 * The same rule, applied across branches rather than inside one journal.
 *
 * A branch journal can be perfectly ordered and still be unshippable. Every
 * migration a branch adds is compared against the newest entry on the base
 * branch, because a database that already ran that entry skips anything older.
 * The ordering check above cannot see this: the offending entry is on main,
 * not in the journal being read.
 */
export function findMigrationsOlderThanBase(params: {
  entries: JournalEntry[];
  baseEntries: JournalEntry[];
}): { added: JournalEntry; newestOnBase: JournalEntry }[] {
  const newestOnBase = params.baseEntries.reduce<JournalEntry | undefined>(
    (newest, entry) => (!newest || entry.when > newest.when ? entry : newest),
    undefined,
  );
  if (!newestOnBase) return [];

  const knownTags = new Set(params.baseEntries.map((entry) => entry.tag));
  return params.entries
    .filter((entry) => !knownTags.has(entry.tag))
    .filter((entry) => entry.when <= newestOnBase.when)
    .map((added) => ({ added, newestOnBase }));
}

function readBaseJournal(journalPath: string): JournalEntry[] | undefined {
  // Absent on a shallow clone or a checkout with no remote, which is a reason
  // to skip this check rather than to fail a build that cannot run it.
  const repoRelative = path.posix.join(
    "platform/backend",
    path.relative(process.cwd(), journalPath).split(path.sep).join("/"),
  );
  try {
    const raw = execFileSync("git", ["show", `origin/main:${repoRelative}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (JSON.parse(raw) as Journal).entries;
  } catch {
    return undefined;
  }
}

function main() {
  const journalPath = path.resolve(
    process.cwd(),
    "src/database/migrations/meta/_journal.json",
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as Journal;
  const outOfOrder = findOutOfOrderMigrations(journal.entries);

  if (outOfOrder.length > 0) {
    process.stderr.write(
      "Drizzle migration journal has out-of-order `when` values. " +
        "Generate new migrations after syncing with main, and never insert a migration with a timestamp older than the previous entry.\n",
    );
    for (const issue of outOfOrder) {
      process.stderr.write(
        `- ${issue.current.idx}:${issue.current.tag} (${issue.current.when}) must be newer than ` +
          `${issue.previous.idx}:${issue.previous.tag} (${issue.previous.when})\n`,
      );
    }
    process.exit(1);
  }

  const baseEntries = readBaseJournal(journalPath);
  const staleAgainstBase = baseEntries
    ? findMigrationsOlderThanBase({ entries: journal.entries, baseEntries })
    : [];

  if (staleAgainstBase.length > 0) {
    process.stderr.write(
      "Drizzle migrations added on this branch are older than the newest migration on origin/main. " +
        "A database that already applied that migration skips these ones without reporting anything. " +
        "Rebase on main, then renumber and regenerate these migrations so their `when` values are newer.\n",
    );
    for (const issue of staleAgainstBase) {
      process.stderr.write(
        `- ${issue.added.idx}:${issue.added.tag} (${issue.added.when}) must be newer than ` +
          `origin/main ${issue.newestOnBase.idx}:${issue.newestOnBase.tag} (${issue.newestOnBase.when})\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    baseEntries
      ? "Drizzle migration journal ordering is valid, on this branch and against origin/main.\n"
      : "Drizzle migration journal ordering is valid. origin/main was unavailable, so the cross-branch check was skipped.\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
