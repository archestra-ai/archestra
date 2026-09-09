import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

// Cluster-scoped prerequisite shared by local worktrees. Deliberately not a
// Tilt-owned YAML resource: `tilt down` must not delete another workspace's PVCs.
const context = process.argv[2];
if (!["orbstack", "docker-desktop", "kind-kind", "kind-archestra", "colima"].includes(context)) {
  throw new Error("Agent Sandbox development bootstrap requires an explicitly allowed local Kubernetes context");
}
// Freeze the selected local context. A later `gcloud get-credentials` must not
// redirect this running development backend to another cluster.
const cacheDirectory = new URL("../node_modules/.cache/", import.meta.url);
await mkdir(cacheDirectory, { recursive: true });
await writeFile(
  new URL("agent-sandbox.kubeconfig", cacheDirectory),
  kubectl(["config", "view", "--minify", "--flatten", "--raw"]),
  { mode: 0o600 },
);
const response = await fetch(
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.1/sandbox.yaml",
  { signal: AbortSignal.timeout(60_000) },
);
if (!response.ok) throw new Error(`Agent Sandbox manifest download failed: ${response.status}`);
const manifest = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(manifest).digest("hex") !== "e30fa5017c6c39d85780ba94554e372da35b068e63a1c3d1a7d70137b349a9b0") {
  throw new Error("Agent Sandbox manifest checksum mismatch; refusing to install");
}
const storageClasses = JSON.parse(kubectl(["get", "storageclass", "-o", "json"]));
if (!storageClasses.items.some((item) =>
  item.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ||
  item.metadata.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true"
)) {
  throw new Error("Agent Runtime requires a default Kubernetes StorageClass. Configure dynamic volume provisioning on your local cluster first.");
}
console.log(kubectl(["apply", "--server-side", "--field-manager=archestra-dev-agent-sandbox", "-f", "-"], manifest));
console.log(kubectl(["wait", "--for=condition=Established", "crd/sandboxes.agents.x-k8s.io", "--timeout=120s"]));
console.log(kubectl(["rollout", "status", "deployment/agent-sandbox-controller", "-n", "agent-sandbox-system", "--timeout=180s"]));

function kubectl(args, input) {
  const result = spawnSync("kubectl", ["--context", context, ...args], {
    input,
    encoding: "utf8",
    timeout: 200_000,
  });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
