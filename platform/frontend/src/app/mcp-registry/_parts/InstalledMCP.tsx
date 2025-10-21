"use client";

import { Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GetMcpServersResponses } from "@/lib/clients/api";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp-server.query";

export function InstalledMCP({
  initialData,
}: {
  initialData?: GetMcpServersResponses["200"];
}) {
  const { data: servers } = useMcpServers({ initialData });
  const deleteMutation = useDeleteMcpServer();
  const [serverSearchQuery, setServerSearchQuery] = useState("");

  const handleDelete = useCallback(
    async (server: GetMcpServersResponses["200"][number]) => {
      try {
        await deleteMutation.mutateAsync(server.id);
        toast.success(`Successfully uninstalled ${server.name}`);
      } catch (error) {
        toast.error(`Failed to uninstall ${server.name}`);
        console.error("Delete error:", error);
      }
    },
    [deleteMutation],
  );

  const filteredServers = useMemo(() => {
    if (!serverSearchQuery.trim()) return servers || [];
    return (servers || []).filter((server) =>
      server.name.toLowerCase().includes(serverSearchQuery.toLowerCase()),
    );
  }, [servers, serverSearchQuery]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search installed servers..."
          value={serverSearchQuery}
          onChange={(e) => setServerSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredServers?.map((server) => (
          <div key={server.id} className="rounded-lg border p-4 space-y-3">
            <div>
              <h3 className="font-medium">{server.name}</h3>
              <p className="text-sm text-muted-foreground">
                {server.catalogId ? "From catalog" : "Custom server"}
              </p>
              <p className="text-sm text-muted-foreground">
                Installed: {new Date(server.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              onClick={() => handleDelete(server)}
              disabled={deleteMutation.isPending}
              size="sm"
              variant="destructive"
              className="w-full"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {deleteMutation.isPending ? "Uninstalling..." : "Uninstall"}
            </Button>
          </div>
        ))}
      </div>
      {filteredServers?.length === 0 && serverSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            No installed servers match "{serverSearchQuery}".
          </p>
        </div>
      )}
      {servers?.length === 0 && !serverSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No servers installed.</p>
        </div>
      )}
    </div>
  );
}
