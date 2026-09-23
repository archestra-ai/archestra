"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOpenappaNavigation } from "./openappa-navigation";
import { ToolTable } from "./tool-table";

/**
 * One server's coverage: its facts, what needs a look, and its tools. Opens
 * from the `server` URL parameter, so a row, a chip or a link anywhere on the
 * page opens it through `openServer`.
 *
 * Scaffold placeholder; WP4 replaces the body.
 */
export function ServerDialog() {
  const { server, closeServer } = useOpenappaNavigation();
  return (
    <Dialog
      open={server !== null}
      onOpenChange={(open) => !open && closeServer()}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Server</DialogTitle>
          <DialogDescription>
            The server dialog is not built yet.
          </DialogDescription>
        </DialogHeader>
        {server !== null && <ToolTable catalogId={server} hideServer />}
      </DialogContent>
    </Dialog>
  );
}
