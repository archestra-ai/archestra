import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const ERROR = "<throws>";
const records = [
  { id: "a", value: 1 },
  { id: "b", value: 2 },
  { id: "c", value: 3 },
];
const transfer = { source: "A", target: "B", amount: 100, currency: "USD" };
const tasks = [
  {
    name: "toMinor",
    parameters: "text",
    contract:
      "Convert a trimmed signed decimal string to integer cents. Require digits before the optional dot and one or two fractional digits. Reject non-strings, invalid syntax, and unsafe results. Do not use floating-point decimal multiplication.",
    cases: [
      [["1.23"], 123],
      [["0"], 0],
      [["-0.01"], -1],
      [["+12.3"], 1230],
      [[" 4.50 "], 450],
      [["001.02"], 102],
      [["-12"], -1200],
      [["1.234"], ERROR],
      [[".5"], ERROR],
      [[1], ERROR],
    ],
  },
  {
    name: "fromMinor",
    parameters: "cents",
    contract:
      "Format a safe integer number of cents as a signed decimal with exactly two fractional digits. Zero has no minus sign. Reject non-safe-integer input.",
    cases: [
      [[0], "0.00"],
      [[1], "0.01"],
      [[-1], "-0.01"],
      [[100], "1.00"],
      [[-100], "-1.00"],
      [[12345], "123.45"],
      [[-12345], "-123.45"],
      [[10], "0.10"],
      [[1.5], ERROR],
      [["100"], ERROR],
    ],
  },
  {
    name: "inMonth",
    parameters: "timestamp, month",
    contract:
      "Return whether an ISO timestamp falls in the YYYY-MM month in UTC, not its written timezone. Return false for an invalid date or malformed month. Month must match YYYY-MM with month 01..12.",
    cases: [
      [["2026-01-15T12:00:00Z", "2026-01"], true],
      [["2026-01-31T23:00:00-02:00", "2026-02"], true],
      [["2026-02-01T01:00:00+02:00", "2026-01"], true],
      [["2026-01-01T00:00:00Z", "2025-12"], false],
      [["bad", "2026-01"], false],
      [["2026-01-01", "2026-13"], false],
      [["2026-01-01", "2026-1"], false],
      [["2024-02-29T12:00:00Z", "2024-02"], true],
      [["2026-12-31T23:59:59Z", "2026-12"], true],
      [["2026-01-01T00:00:00+01:00", "2025-12"], true],
    ],
  },
  {
    name: "dedupeEvents",
    parameters: "events",
    contract:
      "For each string id retain the event with the highest numeric revision; retain the earlier event on a tie. Preserve first-id-appearance order. Return an array without mutating inputs. Events always have valid ids and revisions.",
    cases: [
      [[[]], []],
      [[[{ id: "a", revision: 1 }]], [{ id: "a", revision: 1 }]],
      [
        [
          [
            { id: "a", revision: 1 },
            { id: "a", revision: 2 },
          ],
        ],
        [{ id: "a", revision: 2 }],
      ],
      [
        [
          [
            { id: "a", revision: 2 },
            { id: "a", revision: 1 },
          ],
        ],
        [{ id: "a", revision: 2 }],
      ],
      [
        [
          [
            { id: "b", revision: 1 },
            { id: "a", revision: 1 },
            { id: "b", revision: 3 },
          ],
        ],
        [
          { id: "b", revision: 3 },
          { id: "a", revision: 1 },
        ],
      ],
      [
        [
          [
            { id: "a", revision: 1, value: 1 },
            { id: "a", revision: 1, value: 2 },
          ],
        ],
        [{ id: "a", revision: 1, value: 1 }],
      ],
      [
        [
          [
            { id: "a", revision: 0 },
            { id: "b", revision: 0 },
          ],
        ],
        [
          { id: "a", revision: 0 },
          { id: "b", revision: 0 },
        ],
      ],
      [
        [
          [
            { id: "1", revision: 1 },
            { id: "2", revision: 1 },
            { id: "1", revision: 3 },
          ],
        ],
        [
          { id: "1", revision: 3 },
          { id: "2", revision: 1 },
        ],
      ],
      [
        [
          [
            { id: "x", revision: -1 },
            { id: "x", revision: 0 },
          ],
        ],
        [{ id: "x", revision: 0 }],
      ],
      [
        [
          [
            { id: "a", revision: 3 },
            { id: "b", revision: 2 },
            { id: "a", revision: 4 },
            { id: "b", revision: 1 },
          ],
        ],
        [
          { id: "a", revision: 4 },
          { id: "b", revision: 2 },
        ],
      ],
    ],
  },
  {
    name: "sumMinor",
    parameters: "amounts",
    contract:
      "Sum an array of safe integer cents. Empty sum is zero. Reject any non-safe-integer element or unsafe final sum. Do not coerce strings or mutate inputs.",
    cases: [
      [[[]], 0],
      [[[1]], 1],
      [[[1, 2, 3]], 6],
      [[[-1, 2]], 1],
      [[[100, -100]], 0],
      [[[0, 0]], 0],
      [[[1000000, 2000000]], 3000000],
      [[[1.2]], ERROR],
      [[["1"]], ERROR],
      [[[9007199254740991, 1]], ERROR],
    ],
  },
  {
    name: "allocateMinor",
    parameters: "total, weights",
    contract:
      "Allocate a nonnegative safe integer total in proportion to nonnegative finite weights using largest remainders: floor each exact share, then award remaining cents by descending fractional remainder, breaking ties by original index. Reject negative totals and zero total weight. Return shares in original order.",
    cases: [
      [
        [10, [1, 1]],
        [5, 5],
      ],
      [
        [11, [1, 1]],
        [6, 5],
      ],
      [
        [1, [1, 1, 1]],
        [1, 0, 0],
      ],
      [
        [100, [1, 2, 3]],
        [17, 33, 50],
      ],
      [
        [0, [2, 3]],
        [0, 0],
      ],
      [
        [7, [0, 1, 1]],
        [0, 4, 3],
      ],
      [[5, [1]], [5]],
      [
        [2, [1, 1, 1]],
        [1, 1, 0],
      ],
      [[10, [0, 0]], ERROR],
      [[-1, [1, 1]], ERROR],
    ],
  },
  {
    name: "applyBasisPoints",
    parameters: "amount, bps",
    contract:
      "Return amount*bps/10000 rounded to nearest cent with halves away from zero. Amount is a signed safe integer; bps is an integer in 0..10000. Reject invalid bps. Test products are within safe arithmetic range.",
    cases: [
      [[10000, 1900], 1900],
      [[-10000, 1900], -1900],
      [[50, 100], 1],
      [[-50, 100], -1],
      [[1, 5000], 1],
      [[3, 5000], 2],
      [[0, 10000], 0],
      [[100, 0], 0],
      [[100, 10000], 100],
      [[100, 10001], ERROR],
    ],
  },
  {
    name: "netOfTax",
    parameters: "gross, bps",
    contract:
      "Split a signed integer gross amount into {net,tax}; net is gross*10000/(10000+bps), rounded with halves away from zero, and tax=gross-net. bps must be an integer in 0..10000. Test products are safe.",
    cases: [
      [[120, 2000], { net: 100, tax: 20 }],
      [[119, 1900], { net: 100, tax: 19 }],
      [[100, 0], { net: 100, tax: 0 }],
      [[-120, 2000], { net: -100, tax: -20 }],
      [[1, 10000], { net: 1, tax: 0 }],
      [[-1, 10000], { net: -1, tax: 0 }],
      [[100, 10000], { net: 50, tax: 50 }],
      [[0, 1900], { net: 0, tax: 0 }],
      [[107, 700], { net: 100, tax: 7 }],
      [[1, -1], ERROR],
    ],
  },
  {
    name: "paginate",
    parameters: "records, after, limit",
    contract:
      "Return at most limit records after the record whose id equals after; null means start. Preserve supplied record order. Unknown cursors throw. Limit must be an integer 1..100. Inputs are not mutated.",
    cases: [
      [[records, null, 2], records.slice(0, 2)],
      [[records, "a", 2], records.slice(1)],
      [[records, "b", 5], records.slice(2)],
      [[records, "c", 1], []],
      [[[], null, 5], []],
      [[records, null, 100], records],
      [[records, "missing", 1], ERROR],
      [[records, null, 0], ERROR],
      [[records, null, 1.5], ERROR],
      [[records, null, 1], records.slice(0, 1)],
    ],
  },
  {
    name: "groupByCurrency",
    parameters: "entries",
    contract:
      "Group {currency,amount} entries into alphabetically sorted {currency,total} rows. Normalize currency to uppercase; require exactly three ASCII letters and safe integer amounts. Do not mutate input. Empty input returns [].",
    cases: [
      [[[]], []],
      [[[{ currency: "usd", amount: 1 }]], [{ currency: "USD", total: 1 }]],
      [
        [
          [
            { currency: "usd", amount: 1 },
            { currency: "USD", amount: 2 },
          ],
        ],
        [{ currency: "USD", total: 3 }],
      ],
      [
        [
          [
            { currency: "USD", amount: 2 },
            { currency: "eur", amount: 3 },
          ],
        ],
        [
          { currency: "EUR", total: 3 },
          { currency: "USD", total: 2 },
        ],
      ],
      [
        [
          [
            { currency: "EUR", amount: -2 },
            { currency: "EUR", amount: 2 },
          ],
        ],
        [{ currency: "EUR", total: 0 }],
      ],
      [[[{ currency: "gbp", amount: 0 }]], [{ currency: "GBP", total: 0 }]],
      [
        [
          [
            { currency: "JPY", amount: 100 },
            { currency: "USD", amount: 1 },
          ],
        ],
        [
          { currency: "JPY", total: 100 },
          { currency: "USD", total: 1 },
        ],
      ],
      [[[{ currency: "US", amount: 1 }]], ERROR],
      [[[{ currency: "USD", amount: 1.2 }]], ERROR],
      [[[{ currency: "u$d", amount: 1 }]], ERROR],
    ],
  },
  {
    name: "validateTransfer",
    parameters: "transfer",
    contract:
      "Return {ok,errors}. Validate in order: source is a nonempty trimmed string; target is a nonempty trimmed string different from trimmed source; amount is a positive safe integer; currency is exactly three uppercase ASCII letters. Errors are the failing field names in that order. Null means all fields missing.",
    cases: [
      [[transfer], { ok: true, errors: [] }],
      [[{ ...transfer, source: "" }], { ok: false, errors: ["source"] }],
      [[{ ...transfer, target: "" }], { ok: false, errors: ["target"] }],
      [[{ ...transfer, target: "A" }], { ok: false, errors: ["target"] }],
      [[{ ...transfer, amount: 0 }], { ok: false, errors: ["amount"] }],
      [[{ ...transfer, amount: 1.5 }], { ok: false, errors: ["amount"] }],
      [[{ ...transfer, currency: "usd" }], { ok: false, errors: ["currency"] }],
      [
        [null],
        { ok: false, errors: ["source", "target", "amount", "currency"] },
      ],
      [
        [{ source: 0, target: 0, amount: -1, currency: "USD" }],
        { ok: false, errors: ["source", "target", "amount"] },
      ],
      [
        [{ ...transfer, source: " ", currency: "US" }],
        { ok: false, errors: ["source", "currency"] },
      ],
    ],
  },
  {
    name: "reconcileBalance",
    parameters: "opening, entries, closing",
    contract:
      "Return {computed,delta,balanced}, with computed=opening+sum(entries), delta=closing-computed, balanced=(delta===0). Every amount must be a safe integer; reject invalid inputs and unsafe computed sums. Entries are integer cents.",
    cases: [
      [[0, [], 0], { computed: 0, delta: 0, balanced: true }],
      [[100, [20, -5], 115], { computed: 115, delta: 0, balanced: true }],
      [[100, [20], 125], { computed: 120, delta: 5, balanced: false }],
      [[0, [-10], 0], { computed: -10, delta: 10, balanced: false }],
      [[-100, [100], 0], { computed: 0, delta: 0, balanced: true }],
      [[10, [0], 9], { computed: 10, delta: -1, balanced: false }],
      [[1, [], 2], { computed: 1, delta: 1, balanced: false }],
      [[1.2, [], 0], ERROR],
      [[0, ["1"], 0], ERROR],
      [[9007199254740991, [1], 0], ERROR],
    ],
  },
  {
    name: "agingBucket",
    parameters: "dueDate, asOf",
    contract:
      "For valid YYYY-MM-DD dates, calculate whole UTC days from dueDate to asOf. Return current for age<=0; otherwise 1-30, 31-60, 61-90, or 90+. Reject invalid dates, including calendar rollovers.",
    cases: [
      [["2026-01-01", "2026-01-01"], "current"],
      [["2026-01-02", "2026-01-01"], "current"],
      [["2026-01-01", "2026-01-02"], "1-30"],
      [["2026-01-01", "2026-01-31"], "1-30"],
      [["2026-01-01", "2026-02-01"], "31-60"],
      [["2026-01-01", "2026-03-02"], "31-60"],
      [["2026-01-01", "2026-03-03"], "61-90"],
      [["2026-01-01", "2026-04-02"], "90+"],
      [["2026-02-30", "2026-03-01"], ERROR],
      [["bad", "2026-01-01"], ERROR],
    ],
  },
  {
    name: "finalizeInvoice",
    parameters: "lines",
    contract:
      "For lines {quantity,unitMinor,taxBps}, return {subtotal,tax,total}. quantity and unitMinor are nonnegative safe integers; taxBps is an integer 0..10000. Calculate each line's subtotal, round its tax half away from zero, then sum. Reject invalid lines. Do not mutate input. Test products and totals are safe.",
    cases: [
      [[[]], { subtotal: 0, tax: 0, total: 0 }],
      [
        [[{ quantity: 1, unitMinor: 100, taxBps: 2000 }]],
        { subtotal: 100, tax: 20, total: 120 },
      ],
      [
        [[{ quantity: 2, unitMinor: 50, taxBps: 1000 }]],
        { subtotal: 100, tax: 10, total: 110 },
      ],
      [
        [[{ quantity: 1, unitMinor: 50, taxBps: 100 }]],
        { subtotal: 50, tax: 1, total: 51 },
      ],
      [
        [
          [
            { quantity: 1, unitMinor: 1, taxBps: 5000 },
            { quantity: 1, unitMinor: 1, taxBps: 5000 },
          ],
        ],
        { subtotal: 2, tax: 2, total: 4 },
      ],
      [
        [[{ quantity: 0, unitMinor: 100, taxBps: 2000 }]],
        { subtotal: 0, tax: 0, total: 0 },
      ],
      [
        [[{ quantity: 3, unitMinor: 100, taxBps: 0 }]],
        { subtotal: 300, tax: 0, total: 300 },
      ],
      [
        [[{ quantity: 1, unitMinor: 100, taxBps: 10000 }]],
        { subtotal: 100, tax: 100, total: 200 },
      ],
      [[[{ quantity: -1, unitMinor: 100, taxBps: 0 }]], ERROR],
      [[[{ quantity: 1, unitMinor: 100, taxBps: 10001 }]], ERROR],
    ],
  },
];

export const SEQUENTIAL_TASKS = tasks.map((task) => ({
  ...task,
  path: `src/${task.name}.mjs`,
  cases: task.cases.map(([args, expected]) =>
    expected === ERROR ? { args, throws: true } : { args, expected },
  ),
}));
export const SEQUENTIAL_TICKET =
  "Implement the ledger utility suite, one versioned stage at a time. Read the current stage's source to obtain a revision receipt; run its baseline check; edit using the returned revision; verify using the edit's new revision. Advance only when verification passes. Every stage checks the current feature and all earlier features. Keep functions pure, with no imports, host I/O, dynamic evaluation, or globals. After all stages, a final review must check the current revision before publication. Every revision is an opaque optimistic-concurrency receipt: never guess it or batch dependent operations. Return the final revision in your completion report.\n";
const SEQUENTIAL_FILES = {
  "ticket.txt": SEQUENTIAL_TICKET,
  ...Object.fromEntries(
    SEQUENTIAL_TASKS.map((task) => [
      task.path,
      `export function ${task.name}(${task.parameters}) {\n  throw new Error("not implemented");\n}\n`,
    ]),
  ),
};
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const SEQUENTIAL_DEFINITION_HASH = digest({
  files: SEQUENTIAL_FILES,
  tasks: SEQUENTIAL_TASKS,
});
export const SEQUENTIAL_APPLICATION_BYTES = Buffer.byteLength(
  JSON.stringify({ files: SEQUENTIAL_FILES, tasks: SEQUENTIAL_TASKS }),
);

export function renderSequentialChecks(tasks, stageCount) {
  assert.ok(
    Number.isInteger(stageCount) &&
      stageCount >= 1 &&
      stageCount <= tasks.length,
  );
  return renderChecks(tasks.slice(0, stageCount));
}

function sequentialChecks(stageCount) {
  return renderSequentialChecks(SEQUENTIAL_TASKS, stageCount);
}

function renderChecks(tasks) {
  return `import test from "node:test";\nimport assert from "node:assert/strict";\n${tasks
    .map((task, index) => {
      assert.match(task.name, /^[A-Za-z][A-Za-z0-9]*$/);
      assert.match(task.path, /^src\/[A-Za-z][A-Za-z0-9]*\.mjs$/);
      const binding = `feature${index}`;
      const cases = task.cases
        .map((entry, caseIndex) => {
          const title = JSON.stringify(
            `${index + 1}:${task.name}:${caseIndex + 1}`,
          );
          const args = JSON.stringify(entry.args);
          const invocation = entry.throws
            ? `assert.throws(() => ${binding}(...args));`
            : `assert.deepEqual(${binding}(...args), ${JSON.stringify(entry.expected)});`;
          return `test(${title}, () => { const args = ${args}; const before = structuredClone(args); ${invocation} assert.deepEqual(args, before); });`;
        })
        .join("\n");
      return `import { ${task.name} as ${binding} } from ${JSON.stringify(`/workspace/${task.path}`)};\n${cases}`;
    })
    .join("\n")}\n`;
}

export function createSequentialWorkload() {
  let stage = 0;
  let phase = "read";
  let revision = null;
  let coreCalls = 0;
  const completed = [];
  let steps = new Set();
  const issue = () => {
    revision = randomBytes(32).toString("hex");
  };
  const current = () =>
    stage < SEQUENTIAL_TASKS.length
      ? {
          stage: stage + 1,
          totalStages: SEQUENTIAL_TASKS.length,
          ...SEQUENTIAL_TASKS[stage],
        }
      : null;
  const step = (value, entry) => {
    if (!steps.has(value)) {
      steps.add(value);
      coreCalls++;
      entry.substantive = true;
    }
  };
  return {
    files: SEQUENTIAL_FILES,
    checks: () =>
      sequentialChecks(Math.min(stage + 1, SEQUENTIAL_TASKS.length)),
    expectedTests: () => Math.min(stage + 1, SEQUENTIAL_TASKS.length) * 10,
    before({ name, args, entry }) {
      entry.stage = Math.min(stage + 1, SEQUENTIAL_TASKS.length);
      entry.phase = phase;
      assert.ok(phase !== "published", "already_published");
      if (
        name === "project_read" &&
        args.path.startsWith("src/") &&
        stage < SEQUENTIAL_TASKS.length
      )
        assert.equal(
          args.path,
          current()?.path,
          "current_stage_source_required",
        );
      if (["project_check", "project_edit", "project_publish"].includes(name)) {
        assert.ok(
          typeof revision === "string" && args.revision === revision,
          "current_revision_receipt_required",
        );
        if (name === "project_edit") {
          assert.equal(phase, "edit", "baseline_check_required");
          assert.equal(
            args.path,
            current()?.path,
            "current_stage_source_required",
          );
          assert.ok(
            !/\b(?:import|require|process|globalThis|eval|Function|console|fetch)\b/.test(
              args.after,
            ),
            "pure_source_required",
          );
        } else if (name === "project_publish")
          assert.equal(phase, "publish", "independent_final_check_required");
        else
          assert.ok(
            ["baseline", "verify", "review", "publish"].includes(phase),
            "read_or_edit_revision_required",
          );
        const { revision: _, ...plain } = args;
        return plain;
      }
      return args;
    },
    after({ name, value, entry }) {
      if (name === "project_read" && value.path === current()?.path) {
        if (phase === "read") {
          step("read", entry);
          phase = "baseline";
          issue();
        }
        return {
          ...value,
          task: current(),
          revision,
          nextAction: phase === "edit" ? "project_edit" : "project_check",
        };
      }
      if (name === "project_read" || name === "project_list")
        return {
          ...value,
          task: current(),
          revision: stage === SEQUENTIAL_TASKS.length ? revision : undefined,
          nextAction: phase,
        };
      if (name === "project_edit") {
        step("edit", entry);
        phase = "verify";
        issue();
        return { ...value, revision, nextAction: "project_check" };
      }
      if (name === "project_check") {
        const output = value.output;
        const compact = {
          tests: Number(/^# tests (\d+)\s*$/m.exec(output)?.[1]),
          passed: Number(/^# pass (\d+)\s*$/m.exec(output)?.[1]),
          failed: Number(/^# fail (\d+)\s*$/m.exec(output)?.[1]),
          skipped: Number(/^# skipped (\d+)\s*$/m.exec(output)?.[1]),
          failedTests: [...output.matchAll(/^not ok \d+ - (.+)$/gm)]
            .map((match) => match[1])
            .slice(0, 10),
        };
        const checkManifestHash = digest(this.checks());
        if (phase === "baseline") {
          assert.equal(value.passed, false, "seeded_failure_required");
          step("baseline", entry);
          phase = "edit";
          issue();
        } else if (phase === "verify") {
          if (value.passed) {
            step("verify", entry);
            completed.push({
              stage: stage + 1,
              sourceHash: value.sourceHash,
              checkManifestHash,
            });
            stage++;
            steps = new Set();
            phase = stage === SEQUENTIAL_TASKS.length ? "review" : "read";
            revision = null;
            if (phase === "review") issue();
          } else {
            phase = "edit";
            issue();
          }
        } else {
          assert.ok(value.passed, "final_checks_must_pass");
          phase = "publish";
          issue();
        }
        return {
          ...value,
          output: JSON.stringify(compact),
          checkManifestHash,
          revision,
          task: current(),
          nextAction: phase,
          completedStages: stage,
        };
      }
      if (name === "project_publish") phase = "published";
      return value;
    },
    status: () => ({
      id: "ledger-sequential-14",
      definitionHash: SEQUENTIAL_DEFINITION_HASH,
      totalStages: SEQUENTIAL_TASKS.length,
      completedStages: stage,
      phase,
      substantiveToolCalls: coreCalls,
      expectedCoreCalls: SEQUENTIAL_TASKS.length * 4,
      completed: structuredClone(completed),
      applicationInputBytes: SEQUENTIAL_APPLICATION_BYTES,
    }),
  };
}
