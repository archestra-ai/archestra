import { readFileSync } from "node:fs";
import * as https from "node:https";

/** This cluster's API server, as a pod sees it, and the pod's identity. */
export interface InClusterApi {
  host: string;
  port: number;
  ca: Buffer;
  /** The namespace this pod runs in. */
  namespace: string;
  /**
   * The pod's ServiceAccount token. Kubernetes rotates the file, so it is
   * read for every request.
   */
  token(): string;
}

const SERVICE_ACCOUNT_DIRECTORY =
  "/var/run/secrets/kubernetes.io/serviceaccount";

/** The API server and identity of the pod this process runs in. */
export function inClusterApi(
  env: NodeJS.ProcessEnv = process.env,
  directory = SERVICE_ACCOUNT_DIRECTORY,
): InClusterApi {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) {
    throw new Error(
      "KUBERNETES_SERVICE_HOST is not set: the cluster agent runs only inside a Kubernetes pod",
    );
  }
  return {
    host,
    port: Number(env.KUBERNETES_SERVICE_PORT ?? 443),
    ca: readFileSync(`${directory}/ca.crt`),
    namespace: readFileSync(`${directory}/namespace`, "utf8").trim(),
    token: () => readFileSync(`${directory}/token`, "utf8").trim(),
  };
}

/** The IP address of a running pod, as this cluster's API server reports it. */
export function runningPodIp(
  api: InClusterApi,
  namespace: string,
  pod: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: api.host,
        port: api.port,
        ca: api.ca,
        path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`,
        headers: {
          authorization: `Bearer ${api.token()}`,
          accept: "application/json",
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `pod ${namespace}/${pod}: the API server answered ${response.statusCode}`,
              ),
            );
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            status?: { phase?: string; podIP?: string };
          };
          if (body.status?.phase !== "Running" || !body.status.podIP) {
            reject(new Error(`pod ${namespace}/${pod} is not running`));
            return;
          }
          resolve(body.status.podIP);
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("the API server did not answer")),
    );
    request.on("error", reject);
  });
}
