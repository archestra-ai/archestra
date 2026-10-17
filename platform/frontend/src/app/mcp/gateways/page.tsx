import McpGatewaysPage from "./page.client";

export default function McpGatewaysPageServer() {
  // Access is enforced by the client page guard, and the lists load from the
  // client cache, so a navigation here waits on no server render.
  return <McpGatewaysPage />;
}
