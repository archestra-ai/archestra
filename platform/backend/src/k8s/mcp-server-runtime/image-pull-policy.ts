import {
  getDefaultMcpImagePullPolicy,
  type ImagePullPolicy,
} from "@archestra/shared/mcp-image-pull-policy";

/**
 * The pull policy a local MCP server's container runs with.
 *
 * A policy pinned on the catalog (`localConfig.imagePullPolicy`) wins.
 * Otherwise the image decides: mutable tags (`:latest`, untagged) use
 * `Always` so every rollout runs the image the tag points at now; pinned tags
 * and digests use `IfNotPresent`, so the image a node already holds is the
 * wake's dependency cache and a hibernated server can scale back up during a
 * registry outage; bare local image names use `Never`.
 *
 * A refresh-image request (`forceFreshPull`) is an explicit admin action
 * asking for the current image right now, so it pulls with `Always` for that
 * one rollout. The policy renormalizes the next time the Deployment object
 * itself is built: an install, a restart, or a catalog reinstall. Hibernating
 * and waking are not among them — they patch replicas and annotations on the
 * existing object — so a deployment a refresh left on `Always` stays
 * registry-dependent across every sleep until one of those rebuilds it. A
 * `Never` policy has no registry to fetch a fresher image from, so a refresh
 * keeps it.
 */
export function getMcpImagePullPolicy(
  dockerImage: string,
  options?: { configured?: ImagePullPolicy; forceFreshPull?: boolean },
): ImagePullPolicy {
  const policy =
    options?.configured ?? getDefaultMcpImagePullPolicy(dockerImage);
  if (options?.forceFreshPull && policy !== "Never") return "Always";
  return policy;
}
