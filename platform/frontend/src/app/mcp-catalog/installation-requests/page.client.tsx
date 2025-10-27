"use client";

import { format } from "date-fns";
import { Check, Clock, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRole } from "@/lib/auth.hook";
import { useMcpServerInstallationRequests } from "@/lib/mcp-server-installation-request.query";

export default function InstallationRequestsPageClient() {
  const role = useRole();
  const isAdmin = role === "admin";
  const [statusFilter, setStatusFilter] = useState<
    "pending" | "approved" | "declined" | undefined
  >(undefined);

  const { data: requests } = useMcpServerInstallationRequests({
    status: statusFilter,
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
            <Clock className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="bg-green-500/10 text-green-600">
            <Check className="mr-1 h-3 w-3" />
            Approved
          </Badge>
        );
      case "declined":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-600">
            <X className="mr-1 h-3 w-3" />
            Declined
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            MCP Server Installation Requests
          </h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Review and manage installation requests from team members."
              : "View your MCP server installation requests and their status."}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Filter:</label>
              <Select
                value={statusFilter || "all"}
                onValueChange={(value) =>
                  setStatusFilter(
                    value === "all"
                      ? undefined
                      : (value as "pending" | "approved" | "declined"),
                  )
                }
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Requests</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {requests && requests.length > 0 ? (
          <div className="space-y-4">
            {requests.map((request) => (
              <Card key={request.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-lg">
                        Request #{request.id.slice(0, 8)}
                      </CardTitle>
                      <CardDescription>
                        Requested on{" "}
                        {format(new Date(request.createdAt), "MMM d, yyyy")}
                      </CardDescription>
                    </div>
                    {getStatusBadge(request.status)}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      {request.requestNotes && (
                        <p className="text-sm text-muted-foreground">
                          {request.requestNotes}
                        </p>
                      )}
                      {request.reviewedAt && (
                        <p className="text-xs text-muted-foreground">
                          Reviewed on{" "}
                          {format(new Date(request.reviewedAt), "MMM d, yyyy")}
                        </p>
                      )}
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`/mcp-catalog/installation-requests/${request.id}`}
                      >
                        View Details
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-muted-foreground">
              No installation requests found.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
