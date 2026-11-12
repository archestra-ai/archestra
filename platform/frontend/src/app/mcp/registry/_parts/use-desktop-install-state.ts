import { useSession } from "@/lib/auth/auth.query";
import { useDesktopComputer } from "@/lib/desktop-device.query";
import {
  type DesktopMcpInstallState,
  desktopInstallStateOfRow,
} from "./desktop-mcp-install";

type Item = Parameters<typeof desktopInstallStateOfRow>[0]["item"];
type Servers = Parameters<typeof desktopInstallStateOfRow>[0]["servers"];

/**
 * The viewer's state with each of the catalog items a list, a card or the
 * server page shows: see {@link desktopInstallStateOfRow}. The viewer's
 * devices are read only when a state depends on them, which is when the
 * viewer linked one of the items.
 */
export function useDesktopInstallState(params: {
  items: Item[];
  /** The installations of those items; undefined while they load. */
  servers: Servers;
}): (item: Item) => DesktopMcpInstallState | null {
  const { items, servers } = params;
  const { data: session } = useSession();
  const viewerId = session?.user?.id;
  const stateOf = (item: Item, hasComputer?: boolean | "checking") =>
    desktopInstallStateOfRow({ item, servers, viewerId, hasComputer });
  const { hasComputer } = useDesktopComputer({
    enabled: items.some((item) => {
      const state = stateOf(item);
      return state === "installed" || state === "waiting";
    }),
  });
  return (item) => stateOf(item, hasComputer);
}
