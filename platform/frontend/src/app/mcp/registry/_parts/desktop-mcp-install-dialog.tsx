"use client";

import {
  CheckCircle2,
  Circle,
  Clock,
  Laptop,
  Loader2,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { McpBridgeSetup } from "@/components/mcp-bridge-setup";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type DesktopDevice,
  useDesktopDevices,
  useDesktopMcpInstallationStatus,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { desktopServerErrorSentence } from "@/lib/mcp/desktop-mcp";
import { cn } from "@/lib/utils/tailwind";
import {
  DESKTOP_MCP_NO_TARGET_REASON,
  DESKTOP_MCP_PROGRESS_STEPS,
  DESKTOP_MCP_SLOW_AFTER_MS,
  type DesktopMcpAddCase,
  type DesktopMcpProgress,
  type DesktopMcpProgressHint,
  desktopMcpAddCase,
  desktopMcpProgress,
  desktopMcpStepLabel,
  desktopMcpStepStatus,
  hasDesktopTarget,
} from "./desktop-mcp-install";
import type { CatalogItem } from "./mcp-server-card";
import { useChatWithCatalogItem } from "./use-chat-with-catalog-item";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (catalogItem: CatalogItem) => Promise<{ id: string } | null>;
  catalogItem: CatalogItem;
  isAdding: boolean;
};

/**
 * Adds a desktop MCP catalog item to the user's computer. The installation
 * is always the user's own: the MCP bridge on their computer runs the server.
 *
 * With the MCP bridge on a device, the dialog follows the link until the
 * tools are read, then says the server is ready. With none, it creates the
 * installation and shows the MCP bridge setup, the same one as the Device
 * page; once the device is linked it goes on to the same steps.
 *
 * `onAdd` resolves with the created installation, or null when it was
 * refused (a toast says why) and the dialog stays for another try.
 */
export function DesktopMcpInstallDialog(props: Props) {
  // A dialog opened for another item starts over.
  return <DesktopMcpAddFlow key={props.catalogItem.id} {...props} />;
}

/**
 * One dialog through the whole link, under one title: the intro, then the
 * steps the device takes, live, then one line that the server is linked.
 * Only its body and footer change, so it does not open again. It can be closed at any time; the row
 * keeps "Waiting for your computer" until the tools are read.
 */
function DesktopMcpAddFlow({
  isOpen,
  onClose,
  onAdd,
  catalogItem,
  isAdding,
}: Props) {
  const appName = useAppName();
  const { startChat, isCreating } = useChatWithCatalogItem();
  const [added, setAdded] = useState<{
    id: string;
    at: number;
    /** Added before any device ran the MCP bridge: it is set up first. */
    bridgeSetup: boolean;
  } | null>(null);
  const { data: installStatus } = useDesktopMcpInstallationStatus(
    added?.id ?? null,
  );
  // Followed live until the tools are read: after that nothing here waits.
  const devices = useDesktopDevices({ live: installStatus !== "success" });
  const addCase = desktopMcpAddCase(devices);
  const elapsedMs = useElapsedAtMark(
    added?.at ?? null,
    DESKTOP_MCP_SLOW_AFTER_MS,
  );
  const name = catalogItem.name;
  const canAdd = hasDesktopTarget(catalogItem.desktopConfig);

  const add = async () => {
    const server = await onAdd(catalogItem);
    if (!server) return;
    setAdded({
      id: server.id,
      at: Date.now(),
      bridgeSetup: addCase.kind === "no-bridge",
    });
  };

  // The device is linked: the steps start now, so "taking longer" counts
  // from here and not from the time the setup took.
  const linked = addCase.kind === "bridge";
  useEffect(() => {
    if (linked && added?.bridgeSetup) {
      setAdded({ ...added, at: Date.now(), bridgeSetup: false });
    }
  }, [linked, added]);

  const device = addCase.kind === "bridge" ? addCase.device : null;
  // What the computer reports for the server; nothing until its next sync.
  const reported = device?.servers.find(
    (server) => server.catalogId === catalogItem.id,
  );
  const progress =
    added && !added.bridgeSetup
      ? desktopMcpProgress({
          installStatus,
          device: device
            ? { online: device.online, serverState: reported?.state }
            : null,
          elapsedMs,
        })
      : null;

  const view: {
    icon: ReactNode;
    title: string;
    body: ReactNode;
    footer: ReactNode;
  } = added?.bridgeSetup
    ? {
        icon: <Laptop className="h-5 w-5" />,
        title: "Set up the MCP bridge",
        body: <McpBridgeSetup device={null} />,
        footer: (
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        ),
      }
    : !progress
      ? {
          icon: <Laptop className="h-5 w-5" />,
          title: `Link ${name} to your device`,
          body: (
            <AddIntro
              canAdd={canAdd}
              description={addDescription({ addCase, appName, name })}
            />
          ),
          footer: (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isAdding}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void add()}
                disabled={isAdding || !canAdd || addCase.kind === "loading"}
              >
                {isAdding && <Loader2 className="animate-spin" />}
                <span>
                  {addCase.kind === "no-bridge"
                    ? "Set up the MCP bridge"
                    : "Link to my device"}
                </span>
              </Button>
            </>
          ),
        }
      : progress.done
        ? {
            icon: <Laptop className="h-5 w-5" />,
            title: `Link ${name} to your device`,
            body: (
              <output className="flex items-center gap-2 text-sm">
                <CheckCircle2
                  className="size-4 shrink-0 text-green-600"
                  aria-hidden
                />
                <span>{`${name} is linked to your device`}</span>
              </output>
            ),
            footer: (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isCreating}
                  onClick={() => {
                    void startChat(catalogItem).then(onClose);
                  }}
                >
                  {isCreating && <Loader2 className="animate-spin" />}
                  <span>Open chat</span>
                </Button>
                <Button type="button" onClick={onClose}>
                  Done
                </Button>
              </>
            ),
          }
        : {
            icon: <Laptop className="h-5 w-5" />,
            title: `Link ${name} to your device`,
            body: (
              <>
                <ProgressSteps name={name} progress={progress} />
                {progress.hint ? (
                  <ProgressHint
                    hint={progress.hint}
                    name={name}
                    startError={desktopServerErrorSentence({
                      error: reported?.lastError,
                      name,
                      command: reported?.command,
                      url: reported?.url,
                    })}
                  />
                ) : null}
              </>
            ),
            footer: (
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            ),
          };

  return (
    <StandardDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      // As wide as the MCP bridge setup dialog while it shows the setup, so
      // the command keeps its lines.
      className={added?.bridgeSetup ? "max-w-3xl" : undefined}
      bodyClassName="space-y-4"
      title={
        // Left on a phone too, and clear of the close button.
        <span className="flex items-center gap-2 pr-6 text-left leading-snug">
          <span className="shrink-0">{view.icon}</span>
          <span className="min-w-0">{view.title}</span>
        </span>
      }
      footer={view.footer}
    >
      {view.body}
    </StandardDialog>
  );
}

function AddIntro({
  canAdd,
  description,
}: {
  canAdd: boolean;
  description: string | null;
}) {
  if (!canAdd) {
    return (
      <InlineNotice variant="warning">
        <TriangleAlert />
        <span className="font-medium">Not set up yet</span>
        <InlineNoticeText>{DESKTOP_MCP_NO_TARGET_REASON}</InlineNoticeText>
      </InlineNotice>
    );
  }
  if (!description) {
    return (
      <div className="space-y-2" aria-busy>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground text-pretty">{description}</p>
  );
}

/** The intro sentence, or null while the viewer's devices load. */
function addDescription(params: {
  addCase: DesktopMcpAddCase<DesktopDevice>;
  appName: string;
  name: string;
}): string | null {
  const { addCase, appName, name } = params;
  switch (addCase.kind) {
    case "no-bridge":
      return `The MCP bridge on your device starts ${name}, a program that is already there. Set up the MCP bridge once, and ${name} is ready right after.`;
    case "bridge":
      return `The MCP bridge on ${addCase.device.name} starts ${name}, a program that is already there. Agents in ${appName} can then use it.`;
    case "error":
      return `The MCP bridge on your device starts ${name}, a program that is already there. Agents in ${appName} can then use it.`;
    case "loading":
      return null;
  }
}

function ProgressSteps({
  name,
  progress,
}: {
  name: string;
  progress: DesktopMcpProgress;
}) {
  return (
    <ol className="space-y-2.5 text-sm" aria-live="polite">
      {DESKTOP_MCP_PROGRESS_STEPS.map((step) => {
        const status = desktopMcpStepStatus(step, progress);
        return (
          <li
            key={step}
            className={cn(
              "flex items-center gap-2.5",
              status === "upcoming" && "text-muted-foreground",
              status === "current" && "font-medium",
            )}
            aria-current={status === "current" ? "step" : undefined}
          >
            {status === "done" ? (
              <CheckCircle2
                className="size-4 shrink-0 text-green-600"
                aria-hidden
              />
            ) : status === "current" ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <Circle className="size-4 shrink-0" aria-hidden />
            )}
            <span>{desktopMcpStepLabel(step, name)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ProgressHint({
  hint,
  name,
  startError,
}: {
  hint: DesktopMcpProgressHint;
  name: string;
  /** Why the server did not start, when the computer said so. */
  startError: string | null;
}) {
  const notice: { icon: ReactNode; title: string; text: string } =
    hint === "offline"
      ? {
          icon: <WifiOff />,
          title: "Your device is offline.",
          text: `${name} is linked as soon as it's back.`,
        }
      : hint === "failed"
        ? {
            icon: <Clock />,
            title: `${name} hasn't started yet.`,
            text: startError
              ? `${startError} The MCP bridge keeps trying.`
              : "The MCP bridge keeps trying.",
          }
        : {
            icon: <Clock />,
            title: "This is taking a little longer.",
            text: `You can close this window. ${name} keeps getting ready in the background.`,
          };
  return (
    <InlineNotice variant="neutral">
      {notice.icon}
      <InlineNoticeBody>
        <span className="font-medium">{notice.title}</span>
        <InlineNoticeText>{notice.text}</InlineNoticeText>
      </InlineNoticeBody>
    </InlineNotice>
  );
}

/**
 * The time since `since`, read once: when `markMs` have passed, the one
 * moment the dialog waits for. 0 until then, and while `since` is null.
 */
function useElapsedAtMark(since: number | null, markMs: number): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(
      () => setElapsedMs(Math.max(markMs, Date.now() - since)),
      Math.max(0, since + markMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [since, markMs]);
  return elapsedMs;
}
