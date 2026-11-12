"use client";

import { Check, CheckCircle2, Laptop, Loader2 } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  OneOf,
  ScriptBlock,
  TextButton,
} from "@/app/connection/connect-page-parts";
import { useConnectionBaseUrl } from "@/app/connection/connection-flow.utils";
import { detectPlatform } from "@/app/connection/platform.utils";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import {
  type DesktopDevice,
  useDecideDesktopDeviceSignIn,
  useDesktopDeviceSetupCode,
  useDesktopDeviceSetupSignIn,
  useDesktopDevices,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { bridgeCommand } from "@/lib/mcp/mcp-bridge-command";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Sets up the MCP bridge on the user's device: one line on why, then three
 * numbered steps in the order the user does them. The command sits in step
 * 1. The Device page and the chat open it in {@link McpBridgeSetupDialog};
 * the registry's Link dialog shows it as one of its own steps, so all three
 * look and move the same. {@link McpBridgeSetupStatus} goes in the footer of
 * the dialog around it.
 *
 * The command carries a setup code: the program sends it with its sign-in,
 * and step 2 here shows that sign-in with Approve and Deny, so no approval
 * page opens in another tab. Without a code (it could not be had) the
 * program opens the approval page, as before.
 *
 * `device` is the user's device once it is linked, null before. The caller
 * reads it live (`useDesktopDevices`), so the steps turn done by themselves.
 */
export function McpBridgeSetup({ device }: { device: DesktopDevice | null }) {
  const appName = useAppName();
  const { data: organization } = useOrganization();
  const baseUrl = useConnectionBaseUrl(organization?.connectionBaseUrls);
  const [windows, setWindows] = useState(false);
  useEffect(() => setWindows(detectPlatform() === "windows"), []);
  const { data: setupCode } = useDesktopDeviceSetupCode({
    enabled: device === null,
  });
  const command = bridgeCommand(baseUrl, windows, setupCode ?? undefined);
  const { data: request } = useDesktopDeviceSetupSignIn({
    setupCode,
    enabled: device === null,
  });
  const decide = useDecideDesktopDeviceSignIn(request?.id ?? "");
  // The answer the user gave to the request that is shown, by its id: a
  // command run again starts a new request, which needs a new answer.
  const [answer, setAnswer] = useState<{
    id: string;
    decision: "approve" | "deny";
  } | null>(null);
  const answered = request && answer?.id === request.id ? answer : null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const done = device !== null;
  const approved = done || answered?.decision === "approve";
  const commandRan = approved || Boolean(request);

  return (
    <div className="space-y-5 text-sm">
      <p className="text-muted-foreground text-pretty">
        {`Connect your device to ${appName}, so it can use MCP servers running there.`}
      </p>
      <ol className="space-y-[18px]">
        <SetupStep number={1} state={commandRan ? "done" : "current"}>
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-[3px]">
              <p className={commandRan ? "text-foreground/80" : "font-medium"}>
                {`Run the command to install the ${appName} CLI.`}
              </p>
              <TextButton
                onClick={() => setWindows(!windows)}
                className="ml-auto text-muted-foreground"
              >
                {/* Flush right, so the label ends at the box's edge either way. */}
                <OneOf inline shown={windows ? 0 : 1} className="text-right">
                  <span>Use the macOS / Linux command</span>
                  <span>Use the Windows command</span>
                </OneOf>
              </TextButton>
            </div>
            <ScriptBlock
              command={command}
              copied={copied}
              disabled={false}
              onCopy={() => {
                void copyToClipboard(command).then(() => setCopied(true));
              }}
              // The dialog is narrower than the Connect page, and the step
              // indents the box: a smaller type keeps each line of the
              // command on one line; a longer address wraps instead of
              // scrolling, clear of the Copy button.
              className="mt-0 rounded-xl [&_pre]:break-all [&_pre]:py-3.5 [&_pre]:pl-4 [&_pre]:text-[13px] [&_pre]:leading-[22px] [&_pre]:whitespace-pre-wrap"
            />
            <p className="text-muted-foreground">
              <OneOf inline shown={windows ? 1 : 0}>
                <span>Paste it in a terminal on your device.</span>
                <span>Paste it in PowerShell on your device.</span>
              </OneOf>
            </p>
          </div>
        </SetupStep>
        <SetupStep
          number={2}
          state={approved ? "done" : request ? "current" : "upcoming"}
          multiline={Boolean(request) && !approved}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <p
              className={cn(
                request && !approved
                  ? "pt-[3px] font-medium"
                  : "text-foreground/80",
              )}
            >
              {setupCode
                ? "Approve your device here."
                : "Approve your device on the browser page it opens."}
            </p>
            {request && !approved ? (
              <SignInRequest
                deviceName={request.deviceName}
                userCode={request.userCode}
                denied={answered?.decision === "deny"}
                pending={decide.isPending}
                onDecide={(decision) => {
                  decide.mutate(
                    { decision },
                    {
                      onSuccess: () => setAnswer({ id: request.id, decision }),
                    },
                  );
                }}
              />
            ) : null}
          </div>
        </SetupStep>
        <SetupStep
          number={3}
          state={done ? "done" : approved ? "current" : "upcoming"}
        >
          <p
            className={approved && !done ? "font-medium" : "text-foreground/80"}
          >
            The MCP bridge will run in the background.
          </p>
        </SetupStep>
      </ol>
    </div>
  );
}

/**
 * The live line for the footer of a dialog around {@link McpBridgeSetup}:
 * it waits for the device, then names it.
 */
export function McpBridgeSetupStatus({
  device,
}: {
  device: DesktopDevice | null;
}) {
  return (
    <output
      aria-live="polite"
      className="flex min-w-0 items-center gap-2 self-center text-sm sm:mr-auto"
    >
      {device ? (
        <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-hidden />
      ) : (
        <Loader2
          className="size-4 shrink-0 animate-spin text-muted-foreground"
          aria-hidden
        />
      )}
      <span
        key={device ? "linked" : "waiting"}
        className={cn(
          "truncate",
          device ? "font-medium" : "text-muted-foreground",
        )}
      >
        {device ? `${device.name} is linked` : "Waiting for your device..."}
      </span>
    </output>
  );
}

/**
 * The sign-in that the command started, in step 2: which device, the code to
 * compare with the terminal, and the answer.
 */
function SignInRequest({
  deviceName,
  userCode,
  denied,
  pending,
  onDecide,
}: {
  deviceName: string;
  userCode: string;
  denied: boolean;
  pending: boolean;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  if (denied) {
    return (
      <p className="text-muted-foreground">
        {`You denied ${deviceName}. To link a device, run the command again.`}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-background px-4 py-3.5">
      <Laptop className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          <span>{deviceName}</span>
          <span> wants to link</span>
        </p>
        <p className="text-muted-foreground">
          <span>Make sure your terminal shows the code </span>
          <span className="font-mono font-medium text-foreground">
            {userCode}
          </span>
          <span>.</span>
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onDecide("deny")}
        >
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => onDecide("approve")}
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          <span>Approve</span>
        </Button>
      </div>
    </div>
  );
}

/** One numbered step: the number in a circle, then its content. */
function SetupStep({
  number,
  state,
  multiline = false,
  children,
}: {
  number: number;
  state: "current" | "upcoming" | "done";
  /** Holds more than one line: the circle stays at its top. */
  multiline?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex gap-3.5",
        // A one-line step centres its text on the circle.
        number > 1 && !multiline && "items-center",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-[26px] shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
          state === "current" && "bg-primary text-primary-foreground",
          state === "upcoming" &&
            "border border-muted-foreground/40 text-muted-foreground",
          state === "done" && "bg-green-600/10 text-green-600",
        )}
      >
        {state === "done" ? (
          <Check className="size-3.5" strokeWidth={3} />
        ) : (
          <span>{number}</span>
        )}
      </span>
      {children}
    </li>
  );
}

/**
 * Opens the one MCP bridge setup dialog of the app, which
 * {@link McpBridgeSetupHost} keeps. For a place that disappears once the
 * device is linked, such as the "Device not linked" status: a dialog of its
 * own would close with it, before it shows that the device is linked.
 */
export function openMcpBridgeSetup() {
  setupDialog.set(true);
}

/** The dialog that {@link openMcpBridgeSetup} opens; mounted once, app-wide. */
export function McpBridgeSetupHost() {
  const open = useSyncExternalStore(
    setupDialog.subscribe,
    setupDialog.get,
    () => false,
  );
  return <McpBridgeSetupDialog open={open} onOpenChange={setupDialog.set} />;
}

/** Whether the app-wide setup dialog is open, for its few readers. */
const setupDialog = (() => {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: () => open,
    set: (next: boolean) => {
      open = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

/**
 * {@link McpBridgeSetup} in a dialog of its own, in the shape of the
 * registry's Link dialog. It follows the user's devices while it is open.
 */
export function McpBridgeSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const devices = useDesktopDevices({ enabled: open });
  const device = devices.data?.[0] ?? null;
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      size="medium"
      // Wide enough for the command's lines on one line each.
      className="max-w-3xl"
      title={
        <span className="flex items-center gap-2 pr-6 text-left leading-snug">
          <Laptop className="h-5 w-5 shrink-0" />
          <span className="min-w-0">Set up the MCP bridge</span>
        </span>
      }
      footer={
        <>
          <McpBridgeSetupStatus device={device} />
          <Button
            type="button"
            variant={device ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            <OneOf inline shown={device ? 1 : 0}>
              <span>Close</span>
              <span>Done</span>
            </OneOf>
          </Button>
        </>
      }
    >
      <McpBridgeSetup device={device} />
    </StandardDialog>
  );
}
