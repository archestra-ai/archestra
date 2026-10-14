import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_SERVER_NAME = "openappa-dev";

export const DEV_OPERATIONS = [
  "git_status",
  "git_diff_summary",
  "git_log",
] as const;

export type DevOperation = (typeof DEV_OPERATIONS)[number];

const LOG_LIMIT_DEFAULT = 20;
const LOG_LIMIT_MAX = 50;
const TIMEOUT_MS_DEFAULT = 15_000;
const TIMEOUT_MS_MAX = 60_000;
const OUTPUT_BYTES_DEFAULT = 65_536;
const OUTPUT_BYTES_MAX = 262_144;
const EXPIRY_MAX_MS = 12 * 60 * 60 * 1000;
const ADDRESS_SPACE_BYTES = 512 * 1024 * 1024;
const CPU_SECONDS = 15;
const SANDBOX_WORKSPACE = "/workspace";
const SANDBOX_GIT = "/usr/bin/git";
const PRLIMIT = "/usr/bin/prlimit";
const EMPTY_HOOKS = "/empty-hooks";
const OVERLAY = `[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = false
[openappa]
	overlay = fixed
`;

const LAUNCH_FLAGS = new Set([
  "workspace",
  "task-id",
  "expires",
  "allow",
  "bwrap",
  "git",
  "log-limit",
  "timeout-ms",
  "max-output-bytes",
]);

const REJECTED_ROOTS = new Set([
  "/",
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/opt",
  "/run",
  "/tmp",
  "/proc",
  "/sys",
  "/dev",
  "/bin",
  "/lib",
]);

const CREDENTIAL_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

const FD_PROBE =
  "import os,sys\nbad=[]\nfor name in os.listdir('/proc/self/fd'):\n n=int(name)\n if n<=2: continue\n try:\n  os.write(n,b'X')\n  bad.append(name)\n except OSError:\n  pass\nsys.stdout.write('WRITABLE_FD '+','.join(bad) if bad else 'NO_WRITABLE_FD')\n";

const TRUSTED_CHILD = new Set([
  "/usr/bin/git",
  "/usr/bin/cat",
  "/usr/bin/echo",
  "/usr/bin/readlink",
  "/usr/bin/python3",
]);

export class DevelopmentExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DevelopmentExecutorError";
    this.code = code;
  }
}

/** @public — launch binding consumed by the operator CLI and tests */
export type LaunchScope = {
  workspace: string;
  taskId: string;
  expiresAtMs: number;
  allow: readonly DevOperation[];
  bwrap: string;
  git: string;
  logLimit: number;
  timeoutMs: number;
  maxOutputBytes: number;
};

type SandboxPlan = {
  prlimit: string;
  bwrap: string;
  args: string[];
  gitArgv: string[][];
};

type Inflight = {
  kill: () => void;
  done: Promise<void>;
};

export class BoundScope {
  readonly launch: LaunchScope;
  readonly prlimit: string;
  readonly rootDev: number;
  readonly rootIno: number;
  rootFd: number;
  readonly inflight = new Set<Inflight>();
  closed = false;

  constructor(params: {
    launch: LaunchScope;
    prlimit: string;
    rootFd: number;
    rootDev: number;
    rootIno: number;
  }) {
    this.launch = params.launch;
    this.prlimit = params.prlimit;
    this.rootFd = params.rootFd;
    this.rootDev = params.rootDev;
    this.rootIno = params.rootIno;
  }
}

export function claudeToolName(operation: DevOperation): string {
  return `mcp__${DEV_SERVER_NAME}__${operation}`;
}

export function canonicalToolName(operation: DevOperation): string {
  return `mcp/${DEV_SERVER_NAME}/${operation}`;
}

export const POLICY_SNIPPET = buildPolicySnippet();

export function parseLaunchArgs(argv: readonly string[]): LaunchScope {
  const flags = readFlags(argv);
  for (const key of ["workspace", "task-id", "expires", "allow", "bwrap"]) {
    if (!flags.get(key)) {
      throw new DevelopmentExecutorError(
        "missing_scope",
        `launch is missing --${key}`,
      );
    }
  }
  const workspace = flags.get("workspace") ?? "";
  if (!path.isAbsolute(workspace) || REJECTED_ROOTS.has(workspace)) {
    throw new DevelopmentExecutorError(
      "bad_workspace",
      "workspace must be an absolute path and not a filesystem root",
    );
  }
  return {
    workspace,
    taskId: parseTaskId(flags.get("task-id") ?? ""),
    expiresAtMs: parseExpiry(flags.get("expires") ?? ""),
    allow: parseAllow(flags.get("allow") ?? ""),
    bwrap: flags.get("bwrap") ?? "",
    git: flags.get("git") ?? SANDBOX_GIT,
    logLimit: boundedInt(
      flags.get("log-limit"),
      LOG_LIMIT_DEFAULT,
      1,
      LOG_LIMIT_MAX,
      "log-limit",
    ),
    timeoutMs: boundedInt(
      flags.get("timeout-ms"),
      TIMEOUT_MS_DEFAULT,
      1000,
      TIMEOUT_MS_MAX,
      "timeout-ms",
    ),
    maxOutputBytes: boundedInt(
      flags.get("max-output-bytes"),
      OUTPUT_BYTES_DEFAULT,
      1024,
      OUTPUT_BYTES_MAX,
      "max-output-bytes",
    ),
  };
}

export function bindLaunchScope(launch: LaunchScope): BoundScope {
  const workspace = canonicalWorkspace(launch.workspace);
  const rootFd = openSync(
    workspace,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const root = fstatSync(rootFd);
    assertAnchoredGit(rootFd);
    const bwrap = trustedExecutable(launch.bwrap, workspace, "bwrap");
    const prlimit = trustedExecutable(PRLIMIT, workspace, "prlimit");
    trustedGit(launch.git, workspace);
    return new BoundScope({
      launch: { ...launch, workspace, bwrap, git: SANDBOX_GIT },
      prlimit,
      rootFd,
      rootDev: root.dev,
      rootIno: root.ino,
    });
  } catch (error) {
    closeSync(rootFd);
    throw error;
  }
}

export async function closeBoundScope(scope: BoundScope): Promise<void> {
  if (scope.closed) return;
  scope.closed = true;
  for (const child of scope.inflight) child.kill();
  await Promise.all([...scope.inflight].map((child) => child.done));
  closeFd(scope, "rootFd");
}

export function rejectToolInput(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new DevelopmentExecutorError(
      "unknown_tool_input",
      "tool input must be an empty object",
    );
  }
  if (Object.keys(input).length > 0) {
    throw new DevelopmentExecutorError(
      "unknown_tool_input",
      "tool input cannot choose workspace, command, argv, path, task, remote, or expiry",
    );
  }
}

export function planOperation(
  scope: BoundScope,
  operation: DevOperation,
): SandboxPlan {
  assertOpen(scope);
  assertAllowed(scope.launch, operation);
  const gitBase = [
    SANDBOX_GIT,
    "--no-pager",
    "--no-optional-locks",
    ...gitPin(),
    ...fixedGitConfig(),
  ];
  const gitArgv = gitCommands(gitBase, operation, scope.launch.logLimit);
  return {
    prlimit: scope.prlimit,
    bwrap: scope.launch.bwrap,
    args: [
      ...prlimitArgs(),
      "--",
      scope.launch.bwrap,
      ...bwrapArgs(gitArgv[0] ?? gitBase, scope),
    ],
    gitArgv,
  };
}

export async function executeOperation(params: {
  scope: BoundScope;
  operation: DevOperation;
  input: unknown;
  now?: number;
  timeoutMs?: number;
}): Promise<string> {
  rejectToolInput(params.input);
  assertFresh(params.scope.launch, params.now ?? Date.now());
  const plan = planOperation(params.scope, params.operation);
  const sections = [`task=${params.scope.launch.taskId}`];
  for (const argv of plan.gitArgv) {
    const result = await runSandboxed({
      scope: params.scope,
      argv,
      timeoutMs: params.timeoutMs ?? params.scope.launch.timeoutMs,
      maxOutputBytes: params.scope.launch.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      throw new DevelopmentExecutorError(
        "operation_failed",
        `${params.operation} failed closed (exit ${result.exitCode})`,
      );
    }
    sections.push(result.stdout);
  }
  return sections.join("\n");
}

export async function verifyIsolation(scope: BoundScope): Promise<void> {
  const positive = await runProbe(scope, ["/usr/bin/echo", "SANDBOX_OK"]);
  if (positive.exitCode !== 0 || !positive.stdout.includes("SANDBOX_OK")) {
    throw new DevelopmentExecutorError(
      "sandbox_probe_failed",
      "sandbox probe did not succeed; isolation was not checked",
    );
  }
  let hostNet: string;
  try {
    hostNet = readlinkSync("/proc/self/ns/net");
  } catch {
    throw new DevelopmentExecutorError(
      "sandbox_probe_failed",
      "cannot read the host network namespace",
    );
  }
  const sandboxNet = await runProbe(scope, [
    "/usr/bin/readlink",
    "/proc/self/ns/net",
  ]);
  if (sandboxNet.exitCode !== 0 || !sandboxNet.stdout.startsWith("net:[")) {
    throw new DevelopmentExecutorError(
      "sandbox_probe_failed",
      "cannot read the sandbox network namespace",
    );
  }
  if (sandboxNet.stdout.trim() === hostNet) {
    throw new DevelopmentExecutorError(
      "isolation_failed",
      "sandbox shares the host network namespace",
    );
  }
  const marker = `HOST_FILE_SENTINEL_${randomBytes(4).toString("hex")}`;
  const canary = path.join(
    tmpdir(),
    `openappa-dev-canary-${randomBytes(4).toString("hex")}`,
  );
  writeFileSync(canary, marker, { mode: 0o600 });
  try {
    if (readFileSync(canary, "utf8") !== marker) {
      throw new DevelopmentExecutorError(
        "sandbox_probe_failed",
        "host canary was not readable before the sandbox check",
      );
    }
    const outside = await runProbe(scope, ["/usr/bin/cat", canary]);
    if (outside.exitCode === 0 || outside.stdout.includes(marker)) {
      throw new DevelopmentExecutorError(
        "isolation_failed",
        "sandbox can read outside the bound workspace",
      );
    }
  } finally {
    try {
      unlinkSync(canary);
    } catch {
      // already removed
    }
  }
  const config = await runProbe(scope, [
    "/usr/bin/cat",
    `${SANDBOX_WORKSPACE}/.git/config`,
  ]);
  if (config.exitCode !== 0 || !config.stdout.includes("overlay = fixed")) {
    throw new DevelopmentExecutorError(
      "sandbox_probe_failed",
      "sandbox did not receive the fixed git config",
    );
  }
  const fds = await runProbe(scope, ["/usr/bin/python3", "-I", "-c", FD_PROBE]);
  if (fds.exitCode !== 0 || fds.stdout.trim() !== "NO_WRITABLE_FD") {
    throw new DevelopmentExecutorError(
      "isolation_failed",
      "sandbox inherited a writable host descriptor",
    );
  }
}

export function buildClaudeMcpConfig(params: {
  nodePath: string;
  tsxLoader: string;
  scriptPath: string;
  launchArgs: readonly string[];
}): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [DEV_SERVER_NAME]: {
          type: "stdio",
          command: params.nodePath,
          args: [
            "--import",
            params.tsxLoader,
            params.scriptPath,
            ...params.launchArgs,
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function resolveTsxLoader(scriptUrl: string): string {
  const loader = fileURLToPath(
    new URL("../../node_modules/tsx/dist/esm/index.mjs", scriptUrl),
  );
  try {
    lstatSync(loader);
  } catch {
    throw new DevelopmentExecutorError(
      "missing_tsx",
      "tsx loader is not installed next to the backend package",
    );
  }
  return loader;
}

function buildPolicySnippet(): string {
  const contract = (name: string, operation: DevOperation) => `[[policy.tool]]
name = "${name}"
description = "Closed read-only ${operation} inside the operator-bound workspace. No shell and no path arguments."
parameters = { type = "object", properties = {}, additionalProperties = false }
delta = { trust = "suspicious", audience = ["self"] }
`;
  const blocks = DEV_OPERATIONS.flatMap((operation) => [
    contract(claudeToolName(operation), operation),
    contract(canonicalToolName(operation), operation),
  ]);
  return `# Opt-in only. Do not replace the catch-all and do not attach an annotator.
# The Claude server key ${DEV_SERVER_NAME} is a policy selector, not proof of which binary is installed.
# Trust is the operator-launched local process. These contracts do not cover host shell, remotes, or tests.

${blocks.join("\n")}`;
}

function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || token === "--" || !token.startsWith("--")) {
      throw new DevelopmentExecutorError(
        "unknown_arg",
        "launch accepts only operator flags; extra arguments are refused",
      );
    }
    const key = token.slice(2);
    if (!LAUNCH_FLAGS.has(key) || flags.has(key)) {
      throw new DevelopmentExecutorError(
        "unknown_arg",
        `refusing launch flag --${key || "(empty)"}`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new DevelopmentExecutorError(
        "missing_flag_value",
        `launch flag --${key} requires a value`,
      );
    }
    flags.set(key, value);
    i += 1;
  }
  return flags;
}

function parseTaskId(input: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(input) ||
    input.includes("..")
  ) {
    throw new DevelopmentExecutorError(
      "bad_task_id",
      "task id must be a launch-bound token, not a path",
    );
  }
  return input;
}

function parseExpiry(input: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) {
    throw new DevelopmentExecutorError(
      "bad_expiry",
      "expiry must be a UTC ISO-8601 timestamp",
    );
  }
  const expiresAtMs = Date.parse(input);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    throw new DevelopmentExecutorError(
      "expired_scope",
      "scope is already expired",
    );
  }
  if (expiresAtMs - now > EXPIRY_MAX_MS) {
    throw new DevelopmentExecutorError(
      "bad_expiry",
      "expiry cannot be more than 12 hours ahead",
    );
  }
  return expiresAtMs;
}

function parseAllow(input: string): DevOperation[] {
  const parts = input.split(",").filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new DevelopmentExecutorError("missing_scope", "allow list is empty");
  }
  const seen = new Set<string>();
  const allow: DevOperation[] = [];
  for (const part of parts) {
    if (
      seen.has(part) ||
      !(DEV_OPERATIONS as readonly string[]).includes(part)
    ) {
      throw new DevelopmentExecutorError(
        "unknown_operation",
        `refusing operation ${part}`,
      );
    }
    seen.add(part);
    allow.push(part as DevOperation);
  }
  return allow;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new DevelopmentExecutorError(
      "bad_bound",
      `--${flag} must be an integer`,
    );
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new DevelopmentExecutorError(
      "bad_bound",
      `--${flag} is outside ${min}..${max}`,
    );
  }
  return value;
}

function canonicalWorkspace(input: string): string {
  if (!path.isAbsolute(input)) {
    throw new DevelopmentExecutorError(
      "bad_workspace",
      "workspace must be an absolute path",
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(input);
  } catch {
    throw new DevelopmentExecutorError(
      "bad_workspace",
      "workspace does not exist",
    );
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new DevelopmentExecutorError(
      "bad_workspace",
      "workspace does not exist",
    );
  }
  if (
    !stat.isDirectory() ||
    REJECTED_ROOTS.has(resolved) ||
    resolved === homedir()
  ) {
    throw new DevelopmentExecutorError(
      "bad_workspace",
      "workspace must be a directory and not a filesystem root",
    );
  }
  for (const segment of resolved.split(path.sep)) {
    if (CREDENTIAL_SEGMENTS.has(segment)) {
      throw new DevelopmentExecutorError(
        "bad_workspace",
        "workspace overlaps a credential directory",
      );
    }
  }
  return resolved;
}

function assertAnchoredGit(rootFd: number): void {
  const gitPath = `/proc/self/fd/${rootFd}/.git`;
  const configPath = `${gitPath}/config`;
  let gitStat: ReturnType<typeof lstatSync>;
  try {
    gitStat = lstatSync(gitPath);
  } catch {
    throw new DevelopmentExecutorError(
      "bad_git_dir",
      "workspace .git is missing; linked worktrees are refused",
    );
  }
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    throw new DevelopmentExecutorError(
      "bad_git_dir",
      "workspace .git must be a real directory; linked worktrees are refused",
    );
  }
  let configStat: ReturnType<typeof lstatSync>;
  try {
    configStat = lstatSync(configPath);
  } catch {
    throw new DevelopmentExecutorError(
      "bad_git_config",
      "workspace .git/config is missing or unsupported",
    );
  }
  if (configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new DevelopmentExecutorError(
      "bad_git_config",
      "workspace .git/config must be a regular file; symlinks are refused",
    );
  }
}

function trustedExecutable(
  input: string,
  workspace: string,
  label: string,
): string {
  if (!path.isAbsolute(input)) {
    throw new DevelopmentExecutorError(
      "bad_executable",
      `${label} must be an absolute path`,
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(input);
  } catch {
    throw new DevelopmentExecutorError(
      "missing_runtime",
      `${label} does not exist`,
    );
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new DevelopmentExecutorError(
      "missing_runtime",
      `${label} is not an executable file`,
    );
  }
  if (
    resolved === workspace ||
    resolved.startsWith(`${workspace}${path.sep}`)
  ) {
    throw new DevelopmentExecutorError(
      "bad_executable",
      `${label} must not live inside the workspace`,
    );
  }
  return resolved;
}

function trustedGit(input: string, workspace: string): void {
  const resolved = trustedExecutable(input, workspace, "git");
  let system = "";
  try {
    system = realpathSync(SANDBOX_GIT);
  } catch {
    throw new DevelopmentExecutorError("missing_runtime", "git does not exist");
  }
  if (resolved !== system) {
    throw new DevelopmentExecutorError(
      "bad_executable",
      "git must be the system /usr/bin/git",
    );
  }
}

function openOverlayFd(): number {
  const file = path.join(
    tmpdir(),
    `openappa-dev-gitconfig-${randomBytes(8).toString("hex")}`,
  );
  const writeFd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(writeFd, OVERLAY);
  } finally {
    closeSync(writeFd);
  }
  const readFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  unlinkSync(file);
  return readFd;
}

function assertOpen(scope: BoundScope): void {
  if (scope.closed || scope.rootFd < 0) {
    throw new DevelopmentExecutorError("closed_scope", "scope is closed");
  }
  const root = fstatSync(scope.rootFd);
  if (root.dev !== scope.rootDev || root.ino !== scope.rootIno) {
    throw new DevelopmentExecutorError(
      "scope_replaced",
      "pinned workspace inode changed",
    );
  }
  assertAnchoredGit(scope.rootFd);
}

function assertFresh(launch: LaunchScope, now: number): void {
  if (now >= launch.expiresAtMs) {
    throw new DevelopmentExecutorError("expired_scope", "scope is expired");
  }
}

function assertAllowed(launch: LaunchScope, operation: DevOperation): void {
  if (!launch.allow.includes(operation)) {
    throw new DevelopmentExecutorError(
      "operation_denied",
      `${operation} is not in the launch allow list`,
    );
  }
}

function gitPin(): string[] {
  return [
    `--git-dir=${SANDBOX_WORKSPACE}/.git`,
    `--work-tree=${SANDBOX_WORKSPACE}`,
  ];
}

function fixedGitConfig(): string[] {
  const pairs = [
    "core.fsmonitor=",
    "core.fsmonitorHookVersion=",
    `core.hooksPath=${EMPTY_HOOKS}`,
    "core.sshCommand=",
    "core.askPass=",
    "core.pager=",
    "core.editor=",
    "diff.external=",
    "core.attributesFile=/dev/null",
    "protocol.file.allow=never",
    "protocol.ext.allow=never",
    "protocol.allow=never",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "status.submoduleSummary=false",
    "log.showSignature=false",
    "gpg.program=/bin/false",
    "gpg.ssh.program=/bin/false",
    "credential.helper=",
    `safe.directory=${SANDBOX_WORKSPACE}`,
    "advice.detachedHead=false",
    "alias.status=",
    "alias.diff=",
    "alias.log=",
  ];
  return pairs.flatMap((value) => ["-c", value]);
}

function gitCommands(
  base: string[],
  operation: DevOperation,
  logLimit: number,
): string[][] {
  if (operation === "git_status") {
    return [
      [
        ...base,
        "status",
        "--porcelain=v1",
        "-b",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
    ];
  }
  if (operation === "git_diff_summary") {
    const diff = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      "--ignore-submodules=all",
    ];
    return [
      [...base, ...diff, "HEAD"],
      [...base, "diff", "--cached", ...diff.slice(1)],
    ];
  }
  return [
    [
      ...base,
      "log",
      "-n",
      String(logLimit),
      "--no-show-signature",
      "--format=%H%x09%ad%x09%s",
      "--date=short",
    ],
  ];
}

function prlimitArgs(): string[] {
  return [`--as=${ADDRESS_SPACE_BYTES}`, `--cpu=${CPU_SECONDS}`];
}

function bwrapArgs(
  command: readonly string[],
  scope: BoundScope,
  configFd?: number,
): string[] {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    EMPTY_HOOKS,
    "--ro-bind-fd",
    String(scope.rootFd),
    SANDBOX_WORKSPACE,
    ...(configFd === undefined
      ? []
      : [
          "--ro-bind-data",
          String(configFd),
          `${SANDBOX_WORKSPACE}/.git/config`,
        ]),
    "--chdir",
    SANDBOX_WORKSPACE,
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--",
    ...command,
  ];
}

async function runSandboxed(params: {
  scope: BoundScope;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{ exitCode: number; stdout: string }> {
  assertOpen(params.scope);
  // Bound aggregate process memory as well as the per-process prlimit budget.
  if (params.scope.inflight.size >= 4) {
    throw new DevelopmentExecutorError(
      "scope_busy",
      "four operations are already running in this scope; retry after they finish",
    );
  }
  const executable = params.argv[0];
  if (executable === undefined || !TRUSTED_CHILD.has(executable)) {
    throw new DevelopmentExecutorError(
      "untrusted_argv",
      "refusing an executable outside the closed sandbox set",
    );
  }
  const configFd = openOverlayFd();
  let child: ChildProcess;
  try {
    child = spawn(
      params.scope.prlimit,
      [
        ...prlimitArgs(),
        "--",
        params.scope.launch.bwrap,
        ...bwrapArgs(params.argv, params.scope, configFd),
      ],
      {
        shell: false,
        detached: true,
        env: { PATH: "/usr/bin:/bin" },
        stdio: stdioFor(params.scope.rootFd, configFd),
      },
    );
  } finally {
    closeSync(configFd);
  }
  const inflight = track(params.scope, child);
  try {
    return await collectChild(child, params.timeoutMs, params.maxOutputBytes);
  } finally {
    inflight.kill();
    await inflight.done;
  }
}

function stdioFor(
  rootFd: number,
  configFd: number,
): Array<"ignore" | "pipe" | number> {
  const stdio: Array<"ignore" | "pipe" | number> = Array.from(
    { length: Math.max(rootFd, configFd) + 1 },
    () => "ignore",
  );
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  stdio[rootFd] = rootFd;
  stdio[configFd] = configFd;
  return stdio;
}

function track(scope: BoundScope, child: ChildProcess): Inflight {
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const inflight = {
    kill: () => killGroup(child),
    done,
  };
  scope.inflight.add(inflight);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    scope.inflight.delete(inflight);
    settle();
  };
  child.once("close", finish);
  child.once("error", () => {
    killGroup(child);
    finish();
  });
  return inflight;
}

function collectChild(
  child: ChildProcess,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let abort: "timeout" | "output_bound" | "sandbox_failed" | null = null;
    const timer = setTimeout(() => {
      abort = abort ?? "timeout";
      killGroup(child);
    }, timeoutMs);
    const fail = (
      code: "timeout" | "output_bound" | "sandbox_failed",
      message: string,
    ) => {
      clearTimeout(timer);
      reject(new DevelopmentExecutorError(code, message));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > maxOutputBytes) {
        abort = abort ?? "output_bound";
        killGroup(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.length > maxOutputBytes) {
        abort = abort ?? "output_bound";
        killGroup(child);
      }
    });
    child.once("error", () => {
      abort = abort ?? "sandbox_failed";
      killGroup(child);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      killGroup(child);
      if (abort === "timeout") {
        fail("timeout", "sandbox command timed out");
        return;
      }
      if (abort === "output_bound") {
        fail("output_bound", "sandbox output exceeded the launch bound");
        return;
      }
      if (abort === "sandbox_failed") {
        fail("sandbox_failed", "sandbox failed to start; no shell fallback");
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: stdout.toString("utf8") });
    });
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already reaped
    }
  }
}

function runProbe(
  scope: BoundScope,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string }> {
  return runSandboxed({
    scope,
    argv,
    timeoutMs: 5_000,
    maxOutputBytes: 8192,
  });
}

function closeFd(scope: BoundScope, key: "rootFd"): void {
  const fd = scope[key];
  if (fd < 0) return;
  scope[key] = -1;
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}
