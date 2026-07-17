"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * URL-synced open state for an entity edit/view dialog: the search param holds
 * the id of the entity whose dialog is open, so the dialog survives refresh and
 * its URL is shareable. `open` writes the param, `close` removes it (plus any
 * `alsoClearOnClose` companions), and a URL that already carries the param
 * auto-opens the dialog once the entity loads.
 *
 * Local state stays authoritative for "open" — row clicks open instantly with
 * row data while the URL updates as a side effect, so removing the param
 * externally (e.g. browser back) does not force-close an open dialog.
 * `open`/`close` have stable identities across search-param changes and always
 * read the current params at call time.
 *
 * The caller supplies `entityFromUrl` — the entity the URL id resolves to, from
 * an existing list (`list?.find((x) => x.id === editId)`), a by-id query hook
 * called at the top level (`useConnector(editId ?? undefined)`), or a plain
 * `{ id }` for dialogs on `[id]` routes / dialogs that fetch by id themselves.
 * Read the id from search params so the fetch can run before this hook:
 *
 * ```tsx
 * const editId = useSearchParams().get("edit");
 * const { data: connectorFromUrl } = useConnector(editId ?? undefined);
 * const dialog = useDialogUrlParam({ paramName: "edit", entityFromUrl: connectorFromUrl ?? null });
 * // row click: dialog.open(row) — instant; dialog rendering: open={!!dialog.entity} onClose={dialog.close}
 * ```
 */
export function useDialogUrlParam<T extends { id: string }>({
  paramName,
  entityFromUrl,
  alsoClearOnClose,
}: {
  paramName: string;
  entityFromUrl: T | null | undefined;
  alsoClearOnClose?: string[];
}) {
  const state = useDialogUrlParamState<T>({ paramName, alsoClearOnClose });
  useAutoOpenFromUrl(state, entityFromUrl);

  const { entity, open, close, openedFromUrl, idFromUrl } = state;
  return { entity, open, close, openedFromUrl, idFromUrl };
}

/**
 * URL-synced open state for a dialog identified by param presence alone, for
 * `[id]` routes where the path already names the entity (e.g.
 * `/projects/123?edit`). `setOpen(true)` writes the bare param, `setOpen(false)`
 * removes it, and a URL that already carries the param auto-opens the dialog.
 * `setOpen` has a stable identity across search-param changes.
 *
 * Usage: `const { open, setOpen, openedFromUrl } = useDialogFlagUrlParam("edit");`
 */
export function useDialogFlagUrlParam(paramName: string) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const paramPresent = searchParams.has(paramName);
  const [open, setOpenState] = useState(false);
  const [openedFromUrl, setOpenedFromUrl] = useState(false);
  // Once the param has been handled (opened or closed), don't auto-open again —
  // the URL update from setOpen(false) propagates asynchronously, so without
  // this guard the effect below would reopen the dialog from the stale param.
  const handledRef = useRef(false);

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      handledRef.current = true;
      setOpenState(nextOpen);
      setOpenedFromUrl(false);
      const nextParams = new URLSearchParams(
        searchParamsRef.current.toString(),
      );
      if (nextOpen) {
        nextParams.set(paramName, "");
      } else {
        nextParams.delete(paramName);
      }
      // Strip the dangling "=" of empty-valued params so the URL reads
      // `?edit`, not `?edit=`.
      const nextQueryString = nextParams.toString().replace(/=(?=&|$)/g, "");
      replaceQuery(router, pathname, nextQueryString);
    },
    [router, pathname, paramName],
  );

  useEffect(() => {
    if (!paramPresent) {
      handledRef.current = false;
      return;
    }
    if (!open && !handledRef.current) {
      handledRef.current = true;
      setOpenState(true);
      setOpenedFromUrl(true);
    }
  }, [paramPresent, open]);

  return { open, setOpen, openedFromUrl };
}

/**
 * Shared state and URL plumbing for the id-carrying dialog hooks. Keeps the
 * latest search params (and companion-param list) in refs read at call time,
 * so `open`/`close` stay referentially stable across search-param changes.
 */
function useDialogUrlParamState<T extends { id: string }>({
  paramName,
  alsoClearOnClose,
}: {
  paramName: string;
  alsoClearOnClose?: string[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const alsoClearOnCloseRef = useRef(alsoClearOnClose);
  alsoClearOnCloseRef.current = alsoClearOnClose;

  const idFromUrl = searchParams.get(paramName);
  const [entity, setEntity] = useState<T | null>(null);
  const [openedFromUrl, setOpenedFromUrl] = useState(false);
  const entityRef = useRef(entity);
  entityRef.current = entity;
  // Once an id has been opened (or closed), don't auto-open it again — the URL
  // update from close() propagates asynchronously, so without this guard the
  // auto-open effect would reopen the dialog from the still-stale param.
  const handledIdRef = useRef<string | null>(null);

  const setParam = useCallback(
    (value: string | null) => {
      const nextParams = new URLSearchParams(
        searchParamsRef.current.toString(),
      );
      if (value === null) {
        nextParams.delete(paramName);
        for (const companion of alsoClearOnCloseRef.current ?? []) {
          nextParams.delete(companion);
        }
      } else {
        nextParams.set(paramName, value);
      }
      replaceQuery(router, pathname, nextParams.toString());
    },
    [router, pathname, paramName],
  );

  const open = useCallback(
    (entityData: T) => {
      handledIdRef.current = entityData.id;
      setEntity(entityData);
      setOpenedFromUrl(false);
      setParam(entityData.id);
    },
    [setParam],
  );

  const close = useCallback(() => {
    handledIdRef.current =
      entityRef.current?.id ?? searchParamsRef.current.get(paramName);
    setEntity(null);
    setParam(null);
  }, [paramName, setParam]);

  return {
    idFromUrl,
    entity,
    setEntity,
    openedFromUrl,
    setOpenedFromUrl,
    handledIdRef,
    open,
    close,
  };
}

/** Auto-opens the dialog once the entity for the URL id has loaded. */
function useAutoOpenFromUrl<T extends { id: string }>(
  state: ReturnType<typeof useDialogUrlParamState<T>>,
  entityFromUrl: T | null | undefined,
) {
  const { idFromUrl, entity, setEntity, setOpenedFromUrl, handledIdRef } =
    state;

  useEffect(() => {
    if (!idFromUrl) {
      handledIdRef.current = null;
      return;
    }
    if (
      entityFromUrl &&
      entityFromUrl.id === idFromUrl &&
      entity?.id !== idFromUrl &&
      handledIdRef.current !== idFromUrl
    ) {
      handledIdRef.current = idFromUrl;
      setEntity(entityFromUrl);
      setOpenedFromUrl(true);
    }
  }, [
    idFromUrl,
    entityFromUrl,
    entity?.id,
    setEntity,
    setOpenedFromUrl,
    handledIdRef,
  ]);
}

function replaceQuery(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  queryString: string,
) {
  router.replace(queryString ? `${pathname}?${queryString}` : pathname, {
    scroll: false,
  });
}
