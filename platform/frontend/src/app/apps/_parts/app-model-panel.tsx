"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AppEditConfigDialog } from "./app-edit-config-dialog";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppModelPanel({ app }: { app: App }) {
  const { data: canEdit } = useHasPermissions({ app: ["update"] });
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">Name</p>
        <p className="text-sm">{app.name}</p>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <p className="text-xs font-medium">Description</p>
        <p className="text-sm">{app.description || "No description yet."}</p>
      </div>

      {canEdit ? (
        <>
          <Button
            variant="outline"
            size="sm"
            className="mt-6 self-start"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <AppEditConfigDialog
            app={app}
            open={editOpen}
            onOpenChange={setEditOpen}
          />
        </>
      ) : null}
    </div>
  );
}
