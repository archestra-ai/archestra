"use client";

import { Clock, Laptop, Loader2, TriangleAlert, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  McpBridgeSetup,
  McpBridgeSetupStatus,
  SetupStep,
  StepsStatus,
} from "@/components/mcp-bridge-setup";
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
  desktopConnectActionLabel,
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
  /**
   * The button that opened the dialog said already what it does (Connect,
   * or Install MCP bridge and connect): the dialog starts at once, with no
   * intro.
   */
  startAtOnce?: boolean;
};

/**
 * Connects a desktop MCP server from the user's linked device to the app.
 * The installation is always the user's own: the MCP bridge on their device
 * runs the server.
 *
 * With a linked device, the dialog follows the connection until the tools
 * are read, then says the server is connected. With none, it creates the
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
 * One dialog through the whole connection, under one title: the intro, then
 * the numbered steps the device takes, live, in the look of the MCP bridge
 * setup. Only its body and footer change, so it does not open again. It can
 * be closed at any time; the row keeps "Waiting for your device" until the
 * tools are read.
 */
function DesktopMcpAddFlow({
  isOpen,
  onClose,
  onAdd,
  catalogItem,
  isAdding,
  startAtOnce = false,
}: Props) {
  const appName = useAppName();
  const { startChat, isCreating } = useChatWithCatalogItem();
  const [added, setAdded] = useState<{
    id: string;
    at: number;
    /** Added before any device ran the MCP bridge: it is set up first. */
    bridgeSetup: boolean;
    /** The setup was shown: the dialog keeps its width to the end. */
    viaSetup: boolean;
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
      viaSetup: addCase.kind === "no-bridge",
    });
  };

  // Started from a button that named the action: no intro, once the devices
  // are known (they decide whether the setup comes first).
  const startedAtOnce = useRef(false);
  useEffect(() => {
    if (
      !startAtOnce ||
      startedAtOnce.current ||
      !canAdd ||
      addCase.kind === "loading"
    ) {
      return;
    }
    startedAtOnce.current = true;
    void add();
  });

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

  const title = `Connect ${name} from your device to ${appName}`;
  const description = connectDescription({ addCase, appName, name });
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
          <>
            <McpBridgeSetupStatus device={null} />
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </>
        ),
      }
    : !progress
      ? {
          icon: <Laptop className="h-5 w-5" />,
          title,
          body: canAdd ? (
            <ProgressSteps
              name={name}
              description={description}
              progress={null}
              hint={null}
            />
          ) : (
            <NotSetUpNotice />
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
                <span>{desktopConnectActionLabel(addCase)}</span>
              </Button>
            </>
          ),
        }
      : {
          icon: <Laptop className="h-5 w-5" />,
          title,
          body: (
            <ProgressSteps
              name={name}
              description={description}
              progress={progress}
              hint={
                !progress.done && progress.hint ? (
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
                ) : null
              }
            />
          ),
          footer: progress.done ? (
            <>
              <StepsStatus done>{`${name} is connected`}</StepsStatus>
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
          ) : (
            <>
              <StepsStatus done={false}>{`Connecting ${name}...`}</StepsStatus>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </>
          ),
        };

  return (
    <StandardDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      // As wide as the MCP bridge setup dialog when the flow shows the setup,
      // so the command keeps its lines; then the same width to the end, so
      // the dialog does not jump between its steps.
      className={
        (added ? added.viaSetup : addCase.kind === "no-bridge")
          ? "max-w-3xl"
          : undefined
      }
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

function NotSetUpNotice() {
  return (
    <InlineNotice variant="warning">
      <TriangleAlert />
      <span className="font-medium">Not set up yet</span>
      <InlineNoticeText>{DESKTOP_MCP_NO_TARGET_REASON}</InlineNoticeText>
    </InlineNotice>
  );
}

/** The intro sentence, or null while the viewer's devices load. */
function connectDescription(params: {
  addCase: DesktopMcpAddCase<DesktopDevice>;
  appName: string;
  name: string;
}): string | null {
  const { addCase, appName, name } = params;
  switch (addCase.kind) {
    case "no-bridge":
      return `Set up the MCP bridge on your device once, and ${name} is ready right after. Agents in ${appName} can then use it.`;
    case "bridge":
      return `The MCP bridge on ${addCase.device.name} starts ${name}. Agents in ${appName} can then use it.`;
    case "error":
      return `The MCP bridge on your device starts ${name}. Agents in ${appName} can then use it.`;
    case "loading":
      return null;
  }
}

/**
 * The intro line and the numbered steps, as the MCP bridge setup draws
 * them: before Connect (`progress` null) the first step is next, then they
 * follow the device. A note on why it takes long goes under the step it is
 * about. A skeleton stands for the intro line while the devices load.
 */
function ProgressSteps({
  name,
  description,
  progress,
  hint,
}: {
  name: string;
  description: string | null;
  progress: DesktopMcpProgress | null;
  hint: ReactNode;
}) {
  return (
    <div className="space-y-5 text-sm">
      {description ? (
        <p className="text-muted-foreground text-pretty">{description}</p>
      ) : (
        <Skeleton className="h-5 w-2/3" aria-busy />
      )}
      <ol className="space-y-[18px]" aria-live="polite">
        {DESKTOP_MCP_PROGRESS_STEPS.map((step, index) => {
          const status = progress
            ? desktopMcpStepStatus(step, progress)
            : index === 0
              ? "next"
              : "upcoming";
          return (
            <SetupStep
              key={step}
              number={index + 1}
              state={
                status === "current"
                  ? "working"
                  : status === "next"
                    ? "current"
                    : status
              }
              multiline
            >
              <div
                className="flex min-w-0 flex-1 flex-col gap-2.5"
                aria-current={status === "current" ? "step" : undefined}
              >
                <p
                  className={cn(
                    "pt-[3px]",
                    status === "current" || status === "next"
                      ? "font-medium"
                      : status === "done"
                        ? "text-foreground/80"
                        : "text-muted-foreground",
                  )}
                >
                  {desktopMcpStepLabel(step, name)}
                </p>
                {status === "current" ? hint : null}
              </div>
            </SetupStep>
          );
        })}
      </ol>
    </div>
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
          text: `${name} connects as soon as it's back.`,
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
