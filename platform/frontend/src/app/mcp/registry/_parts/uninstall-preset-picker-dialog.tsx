"use client";

import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface UninstallPresetPickerInstall {
  server: { id: string; name: string };
  presetName: string;
  isDefault: boolean;
}

interface UninstallPresetPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installs: UninstallPresetPickerInstall[];
  onPick: (server: { id: string; name: string }) => void;
}

export function UninstallPresetPickerDialog({
  open,
  onOpenChange,
  installs,
  onPick,
}: UninstallPresetPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Uninstall from which preset?</DialogTitle>
          <DialogDescription>
            This server is installed across multiple presets. Pick which
            installation to uninstall.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          {installs.map(({ server, presetName, isDefault }) => (
            <button
              key={server.id}
              type="button"
              className="flex items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-accent transition-colors"
              onClick={() => onPick(server)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-sm truncate">{presetName}</span>
                {isDefault && (
                  <Badge variant="outline" className="text-[10px]">
                    default
                  </Badge>
                )}
              </div>
              <Trash2 className="h-4 w-4 text-destructive shrink-0" />
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
