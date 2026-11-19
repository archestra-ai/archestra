"use client";

import { Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAutoRouter, useAutoRouters } from "@/lib/auto-routing.query";
import { ConfigureAutoRoutingDialog } from "./configure-dialog";

/** Opens the Configure dialog of the page's router, for members who may change it. */
export function ConfigureAutoRoutingButton({
  variant = "default",
  children = "Configure",
}: {
  variant?: "default" | "outline";
  children?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: router } = useAutoRouter();
  const { data: routers = [] } = useAutoRouters();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (!router || !canUpdate) return null;
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Settings2 />
        <span>{children}</span>
      </Button>
      {open && (
        <ConfigureAutoRoutingDialog
          router={router}
          existingNames={routers
            .filter((other) => other.id !== router.id)
            .map((other) => other.name)}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
