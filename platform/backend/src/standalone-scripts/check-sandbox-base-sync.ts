/**
 * Fails if platform/sandbox_base/ drifts from the runtime warm-base contract in
 * sandbox-core/src/backends/dagger.rs. The sandbox base is built TWO ways — baked
 * (the Dockerfile, used when ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT=true) and at
 * runtime (build_warm_base) — so if the apt set / python deps / venv path / base
 * image / provenance marker diverge, prebuilt mode fails silently in production
 * while non-prebuilt still works. The provenance marker only proves which image
 * is running; this guards that the two build paths agree on the apt set, python
 * dep *names*, venv path, base image, and marker. Resolved versions aren't
 * compared — the baked image pins requirements.lock while the runtime fallback
 * floats `uv add`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const PLATFORM = path.resolve(process.cwd(), "..");
const daggerRs = readFileSync(
  path.join(PLATFORM, "archestra-rs/sandbox-core/src/backends/dagger.rs"),
  "utf8",
);
const dockerfile = readFileSync(
  path.join(PLATFORM, "sandbox_base/Dockerfile"),
  "utf8",
);
const pyproject = readFileSync(
  path.join(PLATFORM, "sandbox_base/pyproject.toml"),
  "utf8",
);

const errors: string[] = [];

function strConst(name: string): string {
  const m = daggerRs.match(new RegExp(`${name}:\\s*&str\\s*=\\s*"([^"]+)"`));
  if (!m) {
    errors.push(`could not parse ${name} from dagger.rs`);
    return "";
  }
  return m[1];
}

function arrayConst(name: string): string[] {
  const m = daggerRs.match(
    new RegExp(`${name}:\\s*&\\[&str\\]\\s*=\\s*&\\[([\\s\\S]*?)\\]`),
  );
  if (!m) {
    errors.push(`could not parse ${name} from dagger.rs`);
    return [];
  }
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function tomlDependencies(): string[] {
  const m = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (!m) {
    errors.push(
      "could not parse dependencies from sandbox_base/pyproject.toml",
    );
    return [];
  }
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// 1. base image (the Dockerfile may pin a @sha256 digest on top of the tag)
const baseImage = strConst("DEFAULT_BASE_IMAGE");
if (baseImage && !dockerfile.includes(`FROM ${baseImage}`)) {
  errors.push(
    `Dockerfile FROM is not the DEFAULT_BASE_IMAGE tag "${baseImage}"`,
  );
}

// 2. apt toolbelt
for (const pkg of arrayConst("DEFAULT_APT_PACKAGES")) {
  if (!new RegExp(`(^|\\s)${pkg}(\\s|$|\\\\)`, "m").test(dockerfile)) {
    errors.push(
      `apt package "${pkg}" (DEFAULT_APT_PACKAGES) missing from Dockerfile`,
    );
  }
}

// 3. python deps: the Dockerfile's pyproject must list exactly the runtime set
const runtimePy = [...arrayConst("DEFAULT_PYTHON_REQUIREMENTS")].sort();
const bakedPy = [...tomlDependencies()].sort();
if (JSON.stringify(runtimePy) !== JSON.stringify(bakedPy)) {
  errors.push(
    `python deps differ — dagger.rs DEFAULT_PYTHON_REQUIREMENTS=[${runtimePy}] vs sandbox_base/pyproject.toml=[${bakedPy}]`,
  );
}

// 4. venv path
const venvDir = strConst("DEFAULT_VENV_DIR");
if (venvDir && !dockerfile.includes(venvDir)) {
  errors.push(
    `venv path "${venvDir}" (DEFAULT_VENV_DIR) missing from Dockerfile`,
  );
}

// 5. provenance marker the prebuilt branch verifies
const marker = strConst("SANDBOX_BASE_MARKER");
if (marker && !dockerfile.includes(marker)) {
  errors.push(
    `provenance marker "${marker}" (SANDBOX_BASE_MARKER) not written by Dockerfile`,
  );
}

if (errors.length > 0) {
  process.stderr.write(
    "sandbox_base/ is out of sync with dagger.rs build_warm_base():\n" +
      errors.map((e) => `  - ${e}`).join("\n") +
      "\nReconcile platform/sandbox_base/ with the DEFAULT_* constants.\n",
  );
  process.exit(1);
}
process.stdout.write("sandbox_base/ is in sync with dagger.rs.\n");
