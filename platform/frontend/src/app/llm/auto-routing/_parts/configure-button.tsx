"use client";

import { Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAutoRoutingSettings } from "@/lib/auto-routing.query";
import { ConfigureAutoRoutingDialog } from "./configure-dialog";

/** Opens the Configure dialog, for members who may change auto routing. */
export function ConfigureAutoRoutingButton({
  variant = "default",
  children = "Configure",
}: {
  variant?: "default" | "outline";
  children?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: settings } = useAutoRoutingSettings();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (!settings || !canUpdate) return null;
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Settings2 />
        <span>{children}</span>
      </Button>
      {open && (
        <ConfigureAutoRoutingDialog
          settings={settings}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
