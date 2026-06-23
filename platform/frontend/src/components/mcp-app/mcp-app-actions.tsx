import { AppWindow, Minimize, SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * App-level actions surfaced as icons inside the shared {@link McpAppTopBar}
 * address pill. Each context enables the subset it wants; `goToAppsPage` /
 * `openStandalone` are additionally gated on an owned-app `appId` being present.
 * The open-in-side-panel control lives separately ({@link McpAppSidebarButton}),
 * in the top bar's right zone.
 */
export type McpAppAction = "goToAppsPage" | "openStandalone" | "fullscreen";

/**
 * Icon-only action buttons for the address pill. Renders nothing when no action
 * resolves, so a pill with no enabled actions shows a bare name.
 */
export function McpAppActions({
  appId,
  actions,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  /** Gates `goToAppsPage` + `openStandalone`; absent for agent-bound tools. */
  appId?: string;
  actions: McpAppAction[];
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const has = (action: McpAppAction) => actions.includes(action);
  // The enter-fullscreen icon is hidden for now; fullscreen is entered only by
  // app request. We still surface an exit affordance while in fullscreen so the
  // user isn't stranded (Escape also works).
  const showExitFullscreen =
    has("fullscreen") && !!onToggleFullscreen && isFullscreen;
  const showAppsPage = has("goToAppsPage") && !!appId;
  const showStandalone = has("openStandalone") && !!appId;

  return (
    <>
      {showExitFullscreen && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          onClick={onToggleFullscreen}
          aria-label="Exit fullscreen"
          title="Exit fullscreen"
        >
          <Minimize className="h-3.5 w-3.5" />
        </Button>
      )}
      {showAppsPage && appId && (
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
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
          className="h-6 w-6 text-muted-foreground"
          aria-label="Open standalone"
          title="Open standalone"
        >
          <Link href={`/apps/${appId}/run`} target="_blank" rel="noreferrer">
            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
    </>
  );
}
