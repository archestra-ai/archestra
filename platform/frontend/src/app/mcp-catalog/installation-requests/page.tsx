"use client";

import { CheckCircle, Clock, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRole } from "@/lib/auth.hook";
import {
  type McpServerInstallationRequest,
  useMcpServerInstallationRequests,
} from "@/lib/mcp-server-installation-request.query";

export default function InstallationRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "approved" | "declined"
  >("all");
  const userRole = useRole();
  const isAdmin = userRole === "admin";

  const { data: requests, isLoading } = useMcpServerInstallationRequests(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            MCP Server Installation Requests
          </h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Review and manage installation requests from your team members"
              : "View your installation requests and their status"}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <Tabs
          value={statusFilter}
          onValueChange={(v) =>
            setStatusFilter(v as "all" | "pending" | "approved" | "declined")
          }
          className="space-y-4"
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="pending">
              <Clock className="h-4 w-4 mr-1" />
              Pending
            </TabsTrigger>
            <TabsTrigger value="approved">
              <CheckCircle className="h-4 w-4 mr-1" />
              Approved
            </TabsTrigger>
            <TabsTrigger value="declined">
              <XCircle className="h-4 w-4 mr-1" />
              Declined
            </TabsTrigger>
          </TabsList>

          <TabsContent value={statusFilter} className="space-y-4">
            {isLoading ? (
              <div className="grid gap-4 md:grid-cols-2">
                {["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4"].map(
                  (id) => (
                    <Card key={id}>
                      <CardHeader>
                        <Skeleton className="h-6 w-3/4" />
                        <Skeleton className="h-4 w-1/2 mt-2" />
                      </CardHeader>
                      <CardContent>
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full mt-2" />
                      </CardContent>
                    </Card>
                  ),
                )}
              </div>
            ) : requests && requests.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {requests.map((request) => (
                  <RequestCard key={request.id} request={request} />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <p className="text-muted-foreground text-center">
                    No installation requests found
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function RequestCard({ request }: { request: McpServerInstallationRequest }) {
  const statusConfig = {
    pending: {
      icon: Clock,
      color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
      label: "Pending",
    },
    approved: {
      icon: CheckCircle,
      color: "bg-green-500/10 text-green-500 border-green-500/20",
      label: "Approved",
    },
    declined: {
      icon: XCircle,
      color: "bg-red-500/10 text-red-500 border-red-500/20",
      label: "Declined",
    },
  };

  const status = statusConfig[request.status as keyof typeof statusConfig];
  const StatusIcon = status.icon;

  return (
    <Link href={`/mcp-catalog/installation-requests/${request.id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader>
          <div className="flex items-start justify-between">
            <CardTitle className="text-lg">Installation Request</CardTitle>
            <Badge variant="outline" className={status.color}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {status.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Requested{" "}
            {new Date(request.createdAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {request.requestReason && (
            <div>
              <p className="text-sm font-medium mb-1">Reason</p>
              <p className="text-sm text-muted-foreground line-clamp-2">
                {request.requestReason}
              </p>
            </div>
          )}

          {request.status !== "pending" && request.adminResponse && (
            <div>
              <p className="text-sm font-medium mb-1">Admin Response</p>
              <p className="text-sm text-muted-foreground line-clamp-2">
                {request.adminResponse}
              </p>
            </div>
          )}

          {request.notes && request.notes.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {request.notes.length}{" "}
              {request.notes.length === 1 ? "note" : "notes"}
            </p>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" size="sm" asChild>
              <span>View Details</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
