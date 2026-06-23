import {
  AppWindow,
  ExternalLink,
  Maximize2,
  Minimize2,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * App-level actions surfaced as icons in the right slot of the shared
 * {@link McpAppCard} top bar. Each context enables the subset it wants;
 * `goToAppsPage` / `openStandalone` are additionally gated on an owned-app
 * `appId` being present.
 */
export type McpAppAction =
  | "goToAppsPage"
  | "openStandalone"
  | "showInSidebar"
  | "fullscreen";

/**
 * Icon-only action buttons for the card's top-bar right group. Renders nothing
 * when no action resolves, so a card with no enabled actions shows a bare name.
 */
export function McpAppActions({
  appId,
  actions,
  onShowInSidebar,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  /** Gates `goToAppsPage` + `openStandalone`; absent for agent-bound tools. */
  appId?: string;
  actions: McpAppAction[];
  onShowInSidebar?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const has = (action: McpAppAction) => actions.includes(action);
  const showFullscreen = has("fullscreen") && !!onToggleFullscreen;
  const showSidebar = has("showInSidebar") && !!onShowInSidebar;
  const showAppsPage = has("goToAppsPage") && !!appId;
  const showStandalone = has("openStandalone") && !!appId;

  return (
    <>
      {showFullscreen && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      {showAppsPage && appId && (
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label="Go to Apps page"
          title="Go to Apps page"
        >
          <Link href={`/apps/${appId}`}>
            <AppWindow className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
      {showStandalone && appId && (
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label="Open standalone"
          title="Open standalone"
        >
          <Link href={`/apps/${appId}/run`}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
      {showSidebar && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          onClick={onShowInSidebar}
          aria-label="Show in sidebar"
          title="Show in sidebar"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </Button>
      )}
    </>
  );
}
