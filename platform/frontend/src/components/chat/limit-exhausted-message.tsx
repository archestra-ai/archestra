"use client";

import { type ChatErrorResponse, LIMIT_SCOPE_LABELS } from "@shared";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  DollarSign,
  Shield,
} from "lucide-react";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { formatLocalDateTime, formatRelativeTimeFromNow } from "@/lib/utils";

interface LimitExhaustedMessageProps {
  chatError: ChatErrorResponse;
}

export function LimitExhaustedMessage({
  chatError,
}: LimitExhaustedMessageProps) {
  const appIconLogo = useAppIconLogo();
  const limitInfo = chatError.limitInfo;

  if (!limitInfo) {
    return null;
  }

  const scopeLabel = LIMIT_SCOPE_LABELS[limitInfo.scope] ?? limitInfo.scope;
  const isReset = new Date(limitInfo.resetsAt).getTime() <= Date.now();

  const resetsLabel = isReset
    ? "already reset"
    : formatRelativeTimeFromNow(limitInfo.resetsAt, {
        neverLabel: "unknown",
        invalidLabel: "unknown",
      });
  const localResetTime = formatLocalDateTime(limitInfo.resetsAt);

  return (
    <Message from="assistant">
      <MessageAvatar src={appIconLogo} name="System" />
      <MessageContent
        className={
          isReset
            ? "border border-green-200 bg-green-50 text-green-900 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-100"
            : "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
        }
        variant="contained"
      >
        <div className="flex items-start gap-2">
          {isReset ? (
            <CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium">
              {isReset ? "Limit has reset" : "Usage limit reached"}
            </p>
            <p className="text-sm opacity-90">
              {isReset ? (
                <>
                  The {scopeLabel.toLowerCase()} usage limit of{" "}
                  <span className="font-semibold">
                    ${limitInfo.limitValue.toFixed(2)}
                  </span>{" "}
                  has been reset.
                </>
              ) : (
                <>
                  The {scopeLabel.toLowerCase()} usage limit of{" "}
                  <span className="font-semibold">
                    ${limitInfo.limitValue.toFixed(2)}
                  </span>{" "}
                  has been exhausted.
                </>
              )}
            </p>
            <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2 sm:gap-x-4">
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                <span className="opacity-70">Scope:</span>
                <span className="font-medium">{scopeLabel}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                <span className="opacity-70">Limit:</span>
                <span className="font-medium">
                  ${limitInfo.limitValue.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                <span className="opacity-70">Resets:</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default font-medium">
                      {resetsLabel}
                    </span>
                  </TooltipTrigger>
                  {localResetTime && (
                    <TooltipContent>
                      <p>Resets on {localResetTime}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="opacity-70">Models:</span>
                <span className="font-medium">
                  {limitInfo.models && limitInfo.models.length > 0
                    ? limitInfo.models.join(", ")
                    : "All models"}
                </span>
              </div>
            </div>
            <p className="text-xs opacity-75">
              {isReset
                ? "The limit has reset. You can try sending your message again."
                : "Ask your administrator to increase this limit if you need to continue."}
            </p>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
