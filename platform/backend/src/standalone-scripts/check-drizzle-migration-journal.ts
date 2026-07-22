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

function main() {
  const journalPath = path.resolve(
    process.cwd(),
    "src/database/migrations/meta/_journal.json",
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as Journal;
  const outOfOrder = findOutOfOrderMigrations(journal.entries);

  if (outOfOrder.length === 0) {
    process.stdout.write("Drizzle migration journal ordering is valid.\n");
    return;
  }

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
