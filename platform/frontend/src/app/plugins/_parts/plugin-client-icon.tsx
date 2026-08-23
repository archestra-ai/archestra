import { CLIENT_FILTER_OPTIONS } from "@archestra/shared";
import { ClientIcon } from "@/components/provider-icon";

/** Canonical colorful client mark used across every Plugin surface. */
export function PluginClientIcon({
  clientType,
  size = 16,
}: {
  clientType: string;
  size?: number;
}) {
  const filterValue = clientType === "claude-code" ? "claude" : clientType;
  const client = CLIENT_FILTER_OPTIONS.find(
    (option) => option.value === filterValue,
  );
  return client ? <ClientIcon client={client} size={size} /> : null;
}
