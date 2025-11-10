"use client";

import { CheckCircle, Clock, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export default function InstallationRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "approved" | "declined"
  >("all");

  const { data: requests, isLoading } = useMcpServerInstallationRequests(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
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
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead className="w-24">Actions</TableHead>
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
                        <TableCell>
                          <Skeleton className="h-8 w-16" />
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
                      <TableHead className="w-24">Actions</TableHead>
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
    <TableRow className="cursor-pointer hover:bg-muted/50">
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
                : "Local Server"}
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
      <TableCell>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/mcp-catalog/installation-requests/${request.id}`}>
            View
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}
