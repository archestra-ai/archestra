import { type LogMonitorProvider } from '@backend/database/schema/mcpServer';
import { whatsappQrCodeMonitor } from '@backend/server/plugins/mcp-setup/whatsapp-qr-code-monitor';

export type GetLogs = (lines?: number) => Promise<string>;
type LogMonitorCleanup = () => void;
export type LogMonitor = (serverId: string, getLogs: GetLogs, options?: { startAt?: Date }) => LogMonitorCleanup;

export const mcpLogMonitorRegistry: Record<LogMonitorProvider, LogMonitor> = {
  whatsapp: whatsappQrCodeMonitor,
};
