"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  argumentsFromText,
  argumentsToText,
} from "@/components/container-deployment-fields.utils";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  useDesktopDevices,
  useUpdateDesktopMcpArguments,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  desktopArgumentsProgramNotice,
  desktopArgumentsSaveIsFollowed,
  desktopMcpArgumentsError,
} from "@/lib/mcp/desktop-mcp";
import { DesktopMcpArgumentsFields } from "./desktop-mcp-arguments-fields";
import { desktopArgumentsChanged } from "./desktop-mcp-install";

/**
 * Changes the arguments the viewer added to the command of a desktop MCP
 * server they connected. A save stores them and the MCP bridge on the
 * viewer's device starts the server again; `onSaved` then shows that, in the
 * Connect dialog that follows the installation.
 *
 * A device whose program is from before the arguments starts nothing again.
 * The dialog says so before the save, with how to get a newer program; the
 * save then stores the arguments and the dialog closes, with nothing to
 * follow. Nothing follows either when the saved installation is complete
 * all the same, as with a device that did not report its version yet.
 */
export function DesktopMcpArgumentsDialog({
  onClose,
  onSaved,
  name,
  command,
  server,
}: {
  onClose: () => void;
  /**
   * The arguments were changed and the server starts again on the device.
   * Not called for a device that starts nothing again: the dialog closes.
   */
  onSaved: () => void;
  name: string;
  /** The command of the catalog item, exactly as stored. */
  command: string;
  /** The viewer's own installation. */
  server: { id: string; desktopArguments: string[] | null };
}) {
  const appName = useAppName();
  const update = useUpdateDesktopMcpArguments();
  // Whether the device applies arguments decides what follows the save, so
  // nothing is saved before the devices are read.
  const devices = useDesktopDevices({ live: false });
  const notice = desktopArgumentsProgramNotice({
    device: devices.data?.[0],
    appName,
  });
  const [text, setText] = useState(() =>
    argumentsToText(server.desktopArguments),
  );
  const desktopArguments = argumentsFromText(text);
  const error = desktopMcpArgumentsError(desktopArguments);
  const changed = desktopArgumentsChanged(
    server.desktopArguments,
    desktopArguments,
  );

  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      title={`Edit arguments of ${name}`}
      description={
        notice ? undefined : `Saving starts ${name} again on your device.`
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              update.isPending ||
              devices.isPending ||
              !changed ||
              error !== null
            }
            onClick={() => {
              update.mutate(
                { id: server.id, desktopArguments, notice },
                {
                  onSuccess: (saved) => {
                    const followed = desktopArgumentsSaveIsFollowed({
                      notice,
                      installStatus: saved?.localInstallationStatus,
                    });
                    if (followed) onSaved();
                    else onClose();
                  },
                },
              );
            }}
          >
            {update.isPending && <Loader2 className="animate-spin" />}
            <span>Save</span>
          </Button>
        </>
      }
    >
      <DesktopMcpArgumentsFields
        idPrefix="desktop-mcp-edit"
        name={name}
        command={command}
        value={text}
        onValueChange={setText}
        error={error}
        disabled={update.isPending}
        notice={notice}
      />
    </StandardDialog>
  );
}
