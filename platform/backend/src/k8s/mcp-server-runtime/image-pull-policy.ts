import type * as k8s from "@kubernetes/client-node";

/**
 * Registry-backed MCP images should always be pulled on pod recreation so
 * mutable tags like `latest` pick up freshly-pushed images. Bare image names
 * are treated as local node images and use `Never`; setting `Always` there
 * would make local dev clusters try to pull an image that may only exist on
 * the node.
 */
export function getMcpImagePullPolicy(
  dockerImage: string,
): k8s.V1Container["imagePullPolicy"] {
  const isBareLocalImage =
    !dockerImage.includes("/") && !dockerImage.includes(".");

  return isBareLocalImage ? "Never" : "Always";
}
