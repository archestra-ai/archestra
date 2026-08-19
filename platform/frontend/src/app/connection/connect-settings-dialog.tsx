"use client";

import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { ConnectSettingsSection } from "./connect-settings-section";

/**
 * Admin-only entry point to the connect-page configuration (defaults and base
 * URLs). Renders nothing for members. Which clients and providers the page
 * offers is a per-role allow-list now, edited under Settings → Roles.
 */
export function ConnectSettingsDialog() {
  const { data: canUpdateSettings } = useHasPermissions({
    organizationSettings: ["update"],
  });
  if (!canUpdateSettings) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          data-testid="connect-page-settings"
        >
          <Settings2 className="mr-2 h-4 w-4" />
          Page settings
          <Badge variant="secondary" className="ml-2">
            Admin
          </Badge>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect page settings</DialogTitle>
          <DialogDescription>
            Admin only — these defaults configure the connect page for everyone
            in your organization. Which clients and providers it offers is set
            per role, under Settings → Roles.
          </DialogDescription>
        </DialogHeader>
        <ConnectSettingsSection />
      </DialogContent>
    </Dialog>
  );
}
