// "mcp-apps-demo" is a pseudo-type: demo servers are marked with the
// MCP_APPS_DEMO_CATEGORY catalog category, hidden from every other type view,
// and revealed only by picking this type explicitly.
export type ServerType =
  | "all"
  | "remote"
  | "local"
  | "desktop"
  | "mcp-apps-demo";

// Catalog category reserved for servers that only exist to exercise the MCP
// Apps feature. Surfaced in the UI as the "MCP Apps Demo" type, not as a
// selectable category.
export const MCP_APPS_DEMO_CATEGORY = "MCP Apps Demo";

// Typed to accept a plain string so it composes with both the generated
// category union and the server manifest's nullable category without casts.
export const isDemoCategory = (category: string | null | undefined) =>
  category === MCP_APPS_DEMO_CATEGORY;

/**
 * The servers the catalog list shows for a type, in the order it shows them.
 *
 * The catalog sends servers by GitHub stars. Desktop servers carry the stars
 * of large upstream repositories, so under "All types" they would fill the top
 * of the list; there they go after the rest, each group keeping its order.
 */
export function catalogServersForType<T extends CatalogServer>(
  servers: T[],
  type: ServerType,
): T[] {
  // The demo pseudo-type shows only MCP Apps demo servers.
  if (type === "mcp-apps-demo") {
    return servers.filter((server) => isDemoCategory(server.category));
  }

  // Demo servers are hidden from every other type view, including "all".
  const visible = servers.filter((server) => !isDemoCategory(server.category));
  if (type !== "all") {
    return visible.filter((server) => server.server.type === type);
  }

  return [
    ...visible.filter((server) => server.server.type !== "desktop"),
    ...visible.filter((server) => server.server.type === "desktop"),
  ];
}

type CatalogServer = {
  category?: string | null;
  server: { type: string };
};
