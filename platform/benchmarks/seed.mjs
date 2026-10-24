import { pathToFileURL } from "node:url";
import { benchmarkPorts } from "./ports.mjs";

export async function createBenchmarkVirtualKey(portOffset) {
  const { backend } = benchmarkPorts(portOffset);
  const base = `http://127.0.0.1:${backend}`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:13000",
  };
  const login = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers,
    body: JSON.stringify({
      email: "admin@example.com",
      password: "local-benchmark-password",
    }),
  });
  if (!login.ok)
    throw new Error(`Benchmark sign-in failed: HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie) throw new Error("Benchmark sign-in returned no session cookie");
  const response = await fetch(`${base}/api/llm-virtual-keys`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { ...headers, cookie },
    body: JSON.stringify({
      name: "Proxy benchmark",
      keyType: "passthrough",
    }),
  });
  if (!response.ok)
    throw new Error(
      `Benchmark virtual key creation failed: HTTP ${response.status}`,
    );
  const { value } = await response.json();
  if (typeof value !== "string" || !value)
    throw new Error("Benchmark virtual key creation returned no token");
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Captured into a shell variable; never written to the measurements artifact.
  process.stdout.write(await createBenchmarkVirtualKey(process.argv[2]));
}
