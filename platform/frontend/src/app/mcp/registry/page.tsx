import McpRegistryClient from "./page.client";

export default function McpRegistryPage() {
  // Access is enforced by the client page guard, and the catalog and installs
  // load from the client cache, so a navigation here waits on no server render.
  return <McpRegistryClient />;
}
