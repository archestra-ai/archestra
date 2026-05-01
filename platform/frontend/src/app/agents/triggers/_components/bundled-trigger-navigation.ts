import type { BundledChatOpsAdapter } from "@/lib/chatops/chatops.query";

export interface TriggerNavigationEntry {
    href: string;
    active: boolean;
}

export interface BundledTriggerNavigationEntry extends TriggerNavigationEntry {
    adapterId: BundledChatOpsAdapter["adapterId"];
    displayName: BundledChatOpsAdapter["displayName"];
    description: BundledChatOpsAdapter["description"];
    status: BundledChatOpsAdapter["status"];
    pid: BundledChatOpsAdapter["pid"];
    lastStartedAt: BundledChatOpsAdapter["lastStartedAt"];
    lastExitAt: BundledChatOpsAdapter["lastExitAt"];
    errorMessage: BundledChatOpsAdapter["errorMessage"];
}

export function buildBundledTriggerNavigation(
    adapters: BundledChatOpsAdapter[] | null | undefined,
): BundledTriggerNavigationEntry[] {
    return (adapters ?? []).map((adapter) => ({
        ...adapter,
        href: `/agents/triggers/${adapter.adapterId}`,
        active: adapter.status === "running",
    }));
}

export function getFirstTriggerHref(
    fixedTriggers: readonly TriggerNavigationEntry[],
    bundledTriggers: readonly TriggerNavigationEntry[],
): string {
    return (
        [...fixedTriggers, ...bundledTriggers].find((trigger) => trigger.active)
            ?.href ?? fixedTriggers[0]?.href ?? "/agents/triggers"
    );
}