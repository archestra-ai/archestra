"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  argumentsFromText,
  argumentsToText,
} from "@/components/container-deployment-fields.utils";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { useUpdateDesktopMcpArguments } from "@/lib/desktop-device.query";
import { desktopMcpArgumentsError } from "@/lib/mcp/desktop-mcp";
import { DesktopMcpArgumentsFields } from "./desktop-mcp-arguments-fields";
import { desktopArgumentsChanged } from "./desktop-mcp-install";

/**
 * Changes the arguments the viewer added to the command of a desktop MCP
 * server they connected. A save stores them and the MCP bridge on the
 * viewer's device starts the server again; `onSaved` then shows that, in the
 * Connect dialog that follows the installation.
 */
export function DesktopMcpArgumentsDialog({
  onClose,
  onSaved,
  name,
  command,
  server,
}: {
  onClose: () => void;
  /** The arguments were changed: the server starts again on the device. */
  onSaved: () => void;
  name: string;
  /** The command of the catalog item, exactly as stored. */
  command: string;
  /** The viewer's own installation. */
  server: { id: string; desktopArguments: string[] | null };
}) {
  const update = useUpdateDesktopMcpArguments();
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
      description={`Saving starts ${name} again on your device.`}
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
            disabled={update.isPending || !changed || error !== null}
            onClick={() => {
              update.mutate(
                { id: server.id, desktopArguments },
                { onSuccess: onSaved },
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
      />
    </StandardDialog>
  );
}
