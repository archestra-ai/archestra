"use client";

import type { archestraApiTypes } from "@shared";
import { CheckCircle, Clock, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type McpServerInstallationRequest,
  useMcpServerInstallationRequests,
} from "@/lib/mcp-server-installation-request.query";
import { installationRequestStatusConfig } from "./status-config";

type RequestStatus = NonNullable<
  NonNullable<
    archestraApiTypes.GetMcpServerInstallationRequestsData["query"]
  >["status"]
>;
type RequestStatusFilter = "all" | RequestStatus;

export default function InstallationRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");

  const { data: requests, isLoading } = useMcpServerInstallationRequests(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );

  return (
    <div>
      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as RequestStatusFilter)}
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
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Requested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      "skeleton-1",
                      "skeleton-2",
                      "skeleton-3",
                      "skeleton-4",
                    ].map((id) => (
                      <TableRow key={id}>
                        <TableCell>
                          <Skeleton className="h-4 w-32" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-6 w-16" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-48" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : requests && requests.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Requested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requests.map((request) => (
                      <RequestRow key={request.id} request={request} />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
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
  );
}

function RequestRow({ request }: { request: McpServerInstallationRequest }) {
  const router = useRouter();
  const status = installationRequestStatusConfig[request.status];
  const StatusIcon = status.icon;

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      onClick={() =>
        router.push(`/mcp/registry/installation-requests/${request.id}`)
      }
    >
      <TableCell>
        <div className="space-y-1">
          <p className="font-medium">Installation Request</p>
          {request.externalCatalogId && (
            <p className="text-xs text-muted-foreground font-mono">
              External: {request.externalCatalogId}
            </p>
          )}
          {request.customServerConfig && (
            <p className="text-xs text-muted-foreground">
              Custom:{" "}
              {request.customServerConfig.type === "remote"
                ? request.customServerConfig.name
                : "Self-hosted Server"}
            </p>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={status.color}>
          <StatusIcon className="h-3 w-3 mr-1" />
          {status.label}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="max-w-xs">
          {request.requestReason ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {request.requestReason}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No reason provided
            </p>
          )}
        </div>
      </TableCell>
      <TableCell>
        <p className="text-sm text-muted-foreground">
          {new Date(request.createdAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
      </TableCell>
    </TableRow>
  );
}
