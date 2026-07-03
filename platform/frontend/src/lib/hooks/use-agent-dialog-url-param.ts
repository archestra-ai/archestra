"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/lib/agent.query";

type AgentData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

/**
 * URL-synced open state for an agent edit/view dialog: the search param holds
 * the id of the agent whose dialog is open, so the dialog survives refresh and
 * its URL is shareable. `open` writes the param, `close` removes it, and a URL
 * that already carries the param auto-opens the dialog once the agent loads.
 *
 * Local state stays authoritative for "open" — row clicks open instantly with
 * row data while the URL updates as a side effect, so removing the param
 * externally (e.g. browser back) does not force-close an open dialog.
 */
export function useAgentDialogUrlParam(paramName: "edit" | "view") {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const idFromUrl = searchParams.get(paramName);
  const { data: agentFromUrl } = useProfile(idFromUrl ?? undefined);
  const [agent, setAgent] = useState<AgentData | null>(null);
  const [openedFromUrl, setOpenedFromUrl] = useState(false);
  // Once an id has been opened (or closed), don't auto-open it again — the URL
  // update from close() propagates asynchronously, so without this guard the
  // effect below would reopen the dialog from the still-stale param.
  const handledIdRef = useRef<string | null>(null);

  const setParam = useCallback(
    (value: string | null) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      if (value === null) {
        nextParams.delete(paramName);
      } else {
        nextParams.set(paramName, value);
      }
      const nextQueryString = nextParams.toString();
      router.replace(
        nextQueryString ? `${pathname}?${nextQueryString}` : pathname,
        { scroll: false },
      );
    },
    [searchParams, router, pathname, paramName],
  );

  const open = useCallback(
    (agentData: AgentData) => {
      handledIdRef.current = agentData.id;
      setAgent(agentData);
      setOpenedFromUrl(false);
      setParam(agentData.id);
    },
    [setParam],
  );

  const close = useCallback(() => {
    handledIdRef.current = agent?.id ?? idFromUrl;
    setAgent(null);
    setParam(null);
  }, [agent?.id, idFromUrl, setParam]);

  useEffect(() => {
    if (!idFromUrl) {
      handledIdRef.current = null;
      return;
    }
    if (
      agentFromUrl &&
      agentFromUrl.id === idFromUrl &&
      agent?.id !== idFromUrl &&
      handledIdRef.current !== idFromUrl
    ) {
      handledIdRef.current = idFromUrl;
      setAgent(agentFromUrl as AgentData);
      setOpenedFromUrl(true);
    }
  }, [idFromUrl, agentFromUrl, agent?.id]);

  return { agent, open, close, openedFromUrl };
}
