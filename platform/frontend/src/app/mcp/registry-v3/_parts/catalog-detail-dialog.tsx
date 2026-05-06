"use client";

import { Server, Trash2, X } from "lucide-react";
import { useState } from "react";
import { DeleteCatalogDialog } from "@/app/mcp/registry/_parts/delete-catalog-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils";
import { ConfigurationSection } from "./sections/configuration";
import { CredentialsSection } from "./sections/credentials";
import { PresetsSection } from "./sections/presets";
import type { CatalogItem } from "./types";

type Page = "configuration" | "presets" | "credentials";

const navItems: { id: Page; label: string }[] = [
  { id: "configuration", label: "Configuration" },
  { id: "presets", label: "Presets" },
  { id: "credentials", label: "Credentials" },
];

const titles: Record<Page, string> = {
  configuration: "Configuration",
  presets: "Presets",
  credentials: "Credentials",
};

export function CatalogDetailDialog({
  cat,
  open,
  onOpenChange,
}: {
  cat: CatalogItem | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [page, setPage] = useState<Page>("configuration");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: servers = [] } = useMcpServers();

  if (!cat) return null;

  const installCount = servers.filter((s) => s.catalogId === cat.id).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-6xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{cat.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Catalog item settings
        </DialogDescription>

        <nav className="flex w-[220px] shrink-0 flex-col border-r">
          <div className="flex min-h-[72px] items-center border-b px-4 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="rounded bg-muted p-1.5">
                <Server className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{cat.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {cat.multitenant ? "Multi-tenant" : "Single-tenant"} ·{" "}
                  {cat.serverType}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-0.5 px-2 py-3">
            {navItems.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={cn(
                  "h-9 w-full justify-start px-3 font-normal",
                  page === item.id &&
                    "bg-accent font-medium text-accent-foreground",
                )}
                onClick={() => setPage(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-[72px] shrink-0 items-center justify-between border-b px-4 py-4">
            <h2 className="text-lg font-semibold">{titles[page]}</h2>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-xs opacity-70 hover:opacity-100"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {page === "configuration" && <ConfigurationSection cat={cat} />}
            {page === "presets" && <PresetsSection cat={cat} />}
            {page === "credentials" && <CredentialsSection cat={cat} />}
          </ScrollArea>
        </div>
      </DialogContent>
      <DeleteCatalogDialog
        item={deleteOpen ? cat : null}
        installationCount={installCount}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => onOpenChange(false)}
      />
    </Dialog>
  );
}
