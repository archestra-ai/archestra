import { z } from "zod";

export const ImagePullPolicySchema = z.enum([
  "Always",
  "IfNotPresent",
  "Never",
]);

export type ImagePullPolicy = z.infer<typeof ImagePullPolicySchema>;

/**
 * Pull policy a local MCP server's container gets when its catalog does not
 * pin one. Mutable tags (`:latest`, or no tag at all) use `Always`, so a
 * rollout runs the image the tag points at now rather than whatever copy the
 * node cached. Pinned tags and digests use `IfNotPresent`, so a node-cached
 * copy can start the pod while the registry is unreachable. Bare names (no
 * registry, no namespace) are local node images and use `Never`; anything
 * else would make a dev cluster try to pull an image that only exists on the
 * node.
 */
export function getDefaultMcpImagePullPolicy(
  dockerImage: string,
): ImagePullPolicy {
  if (!dockerImage.includes("/") && !dockerImage.includes(".")) return "Never";
  return usesMutableImageTag(dockerImage) ? "Always" : "IfNotPresent";
}

// ===
// Internal helpers
// ===

function usesMutableImageTag(dockerImage: string): boolean {
  if (dockerImage.includes("@")) return false;
  // Only the last path segment can carry a tag; an earlier colon is a
  // registry port (`registry.example.com:5000/team/server`).
  const name = dockerImage.slice(dockerImage.lastIndexOf("/") + 1);
  const tagStart = name.lastIndexOf(":");
  return tagStart === -1 || name.slice(tagStart + 1) === "latest";
}
