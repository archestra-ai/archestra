import type * as k8s from "@kubernetes/client-node";

/**
 * Registry-backed MCP images use `IfNotPresent`: the image a node already
 * holds is the wake's dependency cache, so a hibernated server can scale back
 * up during a registry outage (service down, quota exhausted, network
 * partition) instead of failing an `Always` freshness check against an
 * unreachable registry. Freshness is delivered by the explicit refresh-image
 * flow, which regenerates the deployment with `forceFreshPull` — that rollout
 * pulls the current image, and the policy renormalizes to `IfNotPresent` the
 * next time the Deployment object itself is built: an install, a restart, or a
 * catalog reinstall (which is where a config edit lands). Hibernating and
 * waking are not among them — they patch replicas and annotations on the
 * existing object — so a deployment a refresh left on `Always` stays
 * registry-dependent across every sleep until one of those rebuilds it.
 *
 * Bare image names are treated as local node images and use `Never`; setting
 * anything else there would make local dev clusters try to pull an image that
 * may only exist on the node.
 */
export function getMcpImagePullPolicy(
  dockerImage: string,
  options?: { forceFreshPull?: boolean },
): k8s.V1Container["imagePullPolicy"] {
  const isBareLocalImage =
    !dockerImage.includes("/") && !dockerImage.includes(".");

  if (isBareLocalImage) return "Never";
  return options?.forceFreshPull ? "Always" : "IfNotPresent";
}
