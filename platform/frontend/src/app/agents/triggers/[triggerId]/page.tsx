"use client";

import { AlertTriangle, Bot, LoaderCircle, Play, Square } from "lucide-react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { PermissionButton } from "@/components/ui/permission-button";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    useBundledChatOpsAdapters,
    useStartBundledChatOpsAdapter,
    useStopBundledChatOpsAdapter,
} from "@/lib/chatops/chatops.query";
import { cn } from "@/lib/utils";

function getStatusCopy(status: string, errorMessage: string | null) {
    switch (status) {
        case "running":
            return "The bundled adapter process is active under the backend runtime manager.";
        case "starting":
            return "The backend is starting the bundled adapter process.";
        case "error":
            return errorMessage || "The bundled adapter exited unexpectedly.";
        default:
            return "The bundled adapter is available in this deployment but is not running yet.";
    }
}

function getStatusBadgeClassName(status: string) {
    if (status === "running") {
        return "bg-green-500/10 text-green-600 dark:text-green-400";
    }

    if (status === "error") {
        return "bg-destructive/10 text-destructive";
    }

    return "bg-muted text-muted-foreground";
}

export default function BundledTriggerPage() {
    const params = useParams();
    const triggerIdParam = params.triggerId;
    const triggerId = Array.isArray(triggerIdParam)
        ? triggerIdParam[0]
        : triggerIdParam;

    const { data: bundledAdapters, isLoading } = useBundledChatOpsAdapters();
    const startMutation = useStartBundledChatOpsAdapter();
    const stopMutation = useStopBundledChatOpsAdapter();

    const adapter = bundledAdapters?.find((item) => item.adapterId === triggerId);

    if (!triggerId) {
        return null;
    }

    if (isLoading) {
        return (
            <Card data-testid="bundled-trigger-card" className="max-w-3xl">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                        Loading bundled trigger
                    </CardTitle>
                    <CardDescription>
                        Fetching bundled ChatOps adapter metadata.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    if (!adapter) {
        return (
            <Card data-testid="bundled-trigger-card" className="max-w-3xl border-dashed">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        Trigger unavailable
                    </CardTitle>
                    <CardDescription>
                        This bundled ChatOps adapter is not present in the current catalog.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    const statusCopy = getStatusCopy(adapter.status, adapter.errorMessage);
    const isRunning = adapter.status === "running";
    const isStarting = adapter.status === "starting";
    const showConnectionPage = isRunning && adapter.hasConnectionPage;

    return (
        <div className="flex flex-col gap-4">
            <Card data-testid="bundled-trigger-card" className="max-w-3xl">
                <CardHeader>
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
                            <Bot className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <CardTitle>{adapter.displayName}</CardTitle>
                            <CardDescription>{adapter.description}</CardDescription>
                        </div>
                    </div>
                    <CardAction>
                        <div className="flex items-center gap-2">
                            {!isRunning && !isStarting && (
                                <PermissionButton
                                    data-testid="bundled-trigger-start-button"
                                    permissions={{ agentTrigger: ["update"] }}
                                    size="sm"
                                    disabled={startMutation.isPending}
                                    onClick={() => {
                                        void startMutation.mutateAsync(adapter.adapterId);
                                    }}
                                >
                                    <Play className="mr-1 h-4 w-4" />
                                    {startMutation.isPending ? "Starting..." : "Start"}
                                </PermissionButton>
                            )}
                            {isRunning && (
                                <PermissionButton
                                    data-testid="bundled-trigger-stop-button"
                                    permissions={{ agentTrigger: ["update"] }}
                                    variant="destructive"
                                    size="sm"
                                    disabled={stopMutation.isPending}
                                    onClick={() => {
                                        void stopMutation.mutateAsync(adapter.adapterId);
                                    }}
                                >
                                    <Square className="mr-1 h-4 w-4" />
                                    {stopMutation.isPending ? "Stopping..." : "Stop"}
                                </PermissionButton>
                            )}
                            {isStarting && (
                                <PermissionButton
                                    data-testid="bundled-trigger-start-button"
                                    permissions={{ agentTrigger: ["update"] }}
                                    size="sm"
                                    disabled
                                >
                                    <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />
                                    Starting...
                                </PermissionButton>
                            )}
                        </div>
                    </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Badge
                            variant="secondary"
                            className={cn("border-transparent", getStatusBadgeClassName(adapter.status))}
                        >
                            {isRunning ? "Active" : adapter.status === "starting" ? "Starting" : adapter.status === "error" ? "Error" : "Configure"}
                        </Badge>
                        {adapter.pid ? (
                            <span className="text-sm text-muted-foreground">
                                PID {adapter.pid}
                            </span>
                        ) : null}
                        {adapter.lastStartedAt ? (
                            <span className="text-sm text-muted-foreground">
                                Last started {new Date(adapter.lastStartedAt).toLocaleString()}
                            </span>
                        ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">{statusCopy}</p>
                </CardContent>
            </Card>

            {showConnectionPage && (
                <Card data-testid="bundled-trigger-connection-page" className="max-w-3xl">
                    <CardContent className="p-4">
                        <iframe
                            src={`/api/chatops/generic/builtin-adapters/${adapter.adapterId}/connection-page`}
                            title={`${adapter.displayName} Connection Page`}
                            className="w-full rounded-md border"
                            style={{ height: 500, border: "1px solid hsl(var(--border))" }}
                        />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
