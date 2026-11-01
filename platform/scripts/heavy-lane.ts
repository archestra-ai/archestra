/**
 * One memory-heavy command at a time in a small container.
 *
 * Side by side, tools that each fit take a small Agent Runtime pod past its
 * memory limit, and the kernel then kills every process in it: the frontend's
 * `check:commit` ran tsc, knip and biome at once (3.4 GiB, each alone at most
 * 2.8), the root `commit:check` every package's at once, a pod's first type
 * check next to the dev stack's build. At one or two CPUs nothing is gained by
 * running them together. So below `HEAVY_LANE_BELOW_BYTES` every heavy command
 * holds one exclusive kernel file lock (`flock`, from util-linux), which the
 * kernel releases however the holder exits; a second one waits and says for
 * whom. Above it, and without `flock`, commands run as before.
 *
 * A command whose declared peak does not fit beside the dev stack's servers
 * (`heavyLaneCeilings`) first stops the backend and frontend with
 * `scripts/dev-lite.sh pause`, keeping PostgreSQL and the builds, and starts
 * them again with `resume` when it ends, however it ends short of SIGKILL. It
 * says so on stderr. A stack paused by someone else stays as it was.
 *
 * A command started under the lane sees `ARCHESTRA_HEAVY_LANE=held` and runs
 * its own heavy commands directly (`check:commit` running `type-check`), so the
 * lane never waits for itself.
 *
 * The ceilings (`heavyLaneCeilings` in vitest.resources.ts) are the 4 GiB
 * budget measured in staging pods.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/heavy-lane.ts \
 *     [--label <text>] [--peak-gib <n>] [--dev-lite <script>] -- <command> [args...]
 *
 * (Node 24 strips the types; the flag silences its note that platform/ has no
 * package type.)
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectResourceEnvelope,
  heavyLaneActive,
  heavyLaneCeilings,
  pausesServers,
} from "../vitest.resources.ts";

/** Set for every command the lane runs; nested heavy commands run directly. */
const HEAVY_LANE_HELD_ENV = "ARCHESTRA_HEAVY_LANE";

export interface HeavyCommand {
  command: string;
  args: string[];
  /** What a waiting command and the pause notice call it: "type-check (frontend)". */
  label: string;
  /** Its expected peak, wrappers included; decides whether the servers make room. */
  peakBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Run through the lane. Default: whether the envelope is small (`heavyLaneActive`). */
  lane?: boolean;
  /** The dev stack script whose `pause` and `resume` make room (default `scripts/dev-lite.sh`). */
  devLiteScript?: string;
}

/**
 * Runs the command through the lane when it is active, else directly. The
 * result is spawnSync's: a command killed by a signal under the lane exits
 * 128 + that signal, as `flock` reports it.
 */
export function runHeavy(heavy: HeavyCommand): SpawnSyncReturns<Buffer> {
  const env = heavy.env ?? process.env;
  const envelope = detectResourceEnvelope(env);
  const lane =
    (heavy.lane ?? heavyLaneActive(envelope)) &&
    env[HEAVY_LANE_HELD_ENV] !== "held" &&
    hasFlock();
  const options = {
    stdio: "inherit" as const,
    cwd: heavy.cwd,
    shell: process.platform === "win32",
  };
  if (!lane) {
    return spawnSync(heavy.command, heavy.args, { ...options, env });
  }
  const lock = path.join(tmpdir(), "archestra-heavy.lock");
  const holder = `${lock}.holder`;
  sayWhoHolds(lock, holder, heavy.label);
  const devLite = heavy.devLiteScript ?? DEV_LITE_SCRIPT;
  const pause =
    pausesServers(envelope, heavy.peakBytes) && supportsPause(devLite);
  const ceilings = heavyLaneCeilings(envelope);
  const why =
    heavy.peakBytes === undefined
      ? ""
      : `it needs about ${gib(heavy.peakBytes)}, and beside them this pod has ${gib(ceilings.besideServersBytes)} for it`;
  return spawnSync(
    "flock",
    [
      lock,
      "bash",
      "-c",
      HELD_SCRIPT,
      "heavy-lane",
      holder,
      heavy.label,
      pause ? "1" : "0",
      devLite,
      pausedFile(env),
      why,
      heavy.command,
      ...heavy.args,
    ],
    { ...options, env: { ...env, [HEAVY_LANE_HELD_ENV]: "held" } },
  );
}

// ===== Internal helpers =====

const GIB = 1024 ** 3;
const DEV_LITE_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dev-lite.sh",
);

/**
 * Runs under the lock: records the holder for waiters, pauses the servers when
 * asked and they run, runs the command, resumes them. A no-op INT/TERM/HUP
 * handler keeps this shell alive to resume while the signal reaches the
 * command (handlers, unlike ignored signals, are not inherited).
 */
const HELD_SCRIPT = `
holder="$1" label="$2" pause="$3" dev_lite="$4" paused_file="$5" why="$6"
shift 6
printf '%s\\t%s\\t%s\\n' "$$" "$(date +%s)" "$label" > "$holder" 2>/dev/null || :
resume=0
if [ "$pause" = 1 ] && [ ! -e "$paused_file" ]; then
  bash "$dev_lite" pause > /dev/null 2>&1 || :
  if [ -e "$paused_file" ]; then
    resume=1
    echo "heavy-lane: stopped the dev stack's backend and frontend while $label runs: $why. They start again when it ends; PostgreSQL keeps running." >&2
  fi
fi
trap ':' INT TERM HUP
"$@"
status=$?
if [ "$resume" = 1 ]; then
  echo "heavy-lane: starting the dev stack's backend and frontend again" >&2
  bash "$dev_lite" resume > /dev/null 2>&1 \\
    || echo "heavy-lane: the backend and frontend did not start again: run 'archestra-dev-lite resume'" >&2
fi
: > "$holder" 2>/dev/null || :
exit "$status"
`;

function hasFlock(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Whether this checkout's dev stack can pause (`dev-lite.sh pause`). */
function supportsPause(devLite: string): boolean {
  try {
    return /^cmd_pause\(\)/m.test(readFileSync(devLite, "utf8"));
  } catch {
    return false;
  }
}

function pausedFile(env: NodeJS.ProcessEnv): string {
  const stateDir =
    env.ARCHESTRA_DEV_LITE_STATE_DIR ||
    path.join(env.HOME || homedir(), ".archestra-dev-lite");
  return path.join(stateDir, "paused");
}

/** When another heavy command holds the lane, say which one this waits for. */
function sayWhoHolds(lock: string, holder: string, label: string): void {
  const probe = spawnSync(
    "flock",
    ["--nonblock", "--conflict-exit-code", "75", lock, "true"],
    {
      stdio: "ignore",
    },
  );
  if (probe.status !== 75) return;
  let held = "another memory-heavy command";
  if (existsSync(holder)) {
    const [pid, started, name] = readFileSync(holder, "utf8")
      .trim()
      .split("\t");
    if (name) {
      const seconds = Math.max(
        0,
        Math.round(Date.now() / 1000 - Number(started)),
      );
      held = `${name} (pid ${pid}, running ${seconds} s)`;
    }
  }
  process.stderr.write(
    `heavy-lane: ${label} waits for ${held}: one memory-heavy command runs at a time in this pod.\n`,
  );
}

function gib(bytes: number): string {
  return `${Math.round((bytes / GIB) * 10) / 10} GiB`;
}

// ===== CLI =====

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? [] : argv.slice(0, separator);
  const [command, ...args] =
    separator === -1 ? argv : argv.slice(separator + 1);
  if (!command) {
    process.stderr.write(
      "usage: node scripts/heavy-lane.ts [--label <text>] [--peak-gib <n>] [--dev-lite <script>] -- <command> [args...]\n",
    );
    process.exit(64);
  }
  const flag = (name: string) => {
    const index = flags.indexOf(name);
    return index === -1 ? undefined : flags[index + 1];
  };
  const peak = Number(flag("--peak-gib"));
  const result = runHeavy({
    command,
    args,
    label: flag("--label") ?? path.basename(command),
    peakBytes: Number.isFinite(peak) && peak > 0 ? peak * GIB : undefined,
    devLiteScript: flag("--dev-lite"),
  });
  if (result.error) throw result.error;
  process.exit(
    result.status ??
      (result.signal ? 128 + constants.signals[result.signal] : 1),
  );
}
