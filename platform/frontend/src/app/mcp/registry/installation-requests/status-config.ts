import type { archestraApiTypes } from "@shared";
import { CheckCircle, Clock, XCircle } from "lucide-react";

type RequestStatus = NonNullable<
  NonNullable<
    archestraApiTypes.GetMcpServerInstallationRequestsData["query"]
  >["status"]
>;

export const installationRequestStatusConfig: Record<
  RequestStatus,
  { icon: React.ElementType; color: string; label: string }
> = {
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
