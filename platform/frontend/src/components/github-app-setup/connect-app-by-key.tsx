"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PrivateKeyDrop,
  type PrivateKeyStatus,
  PrivateKeyStatusLine,
} from "./private-key-drop";

export interface AppKeyFields {
  appId: string;
  privateKey: string;
}

/**
 * The fields to connect a GitHub App by its ID and private key. Once both are
 * filled the key is checked: right away when a key is dropped, after a pause
 * when the App ID is typed. The dialog's footer connects.
 */
export function ConnectAppByKey({
  status,
  onFieldsChange,
  onCheck,
  defaultAppId = "",
}: {
  status: PrivateKeyStatus;
  /** The App in use, when replacing its key: only the key is then new. */
  defaultAppId?: string;
  /** Every edit, with both fields or null; an earlier check no longer holds. */
  onFieldsChange: (fields: AppKeyFields | null) => void;
  onCheck: (fields: AppKeyFields) => void;
}) {
  const [appId, setAppId] = useState(defaultAppId);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const pendingCheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendingCheck.current) clearTimeout(pendingCheck.current);
    },
    [],
  );

  function clearPendingCheck() {
    if (pendingCheck.current) clearTimeout(pendingCheck.current);
    pendingCheck.current = null;
  }

  function change(next: { appId: string; privateKey: string | null }) {
    clearPendingCheck();
    const fields =
      next.appId.trim() && next.privateKey
        ? { appId: next.appId.trim(), privateKey: next.privateKey }
        : null;
    onFieldsChange(fields);
    return fields;
  }

  return (
    <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <Label htmlFor="github-app-key-app-id">App ID</Label>
        <Input
          id="github-app-key-app-id"
          inputMode="numeric"
          autoComplete="off"
          value={appId}
          aria-describedby={STATUS_ID}
          onChange={(event) => {
            setAppId(event.target.value);
            const fields = change({ appId: event.target.value, privateKey });
            if (fields)
              pendingCheck.current = setTimeout(
                () => onCheck(fields),
                CHECK_DELAY_MS,
              );
          }}
        />
      </div>
      <PrivateKeyDrop
        id="github-app-key-pem"
        describedBy={STATUS_ID}
        onKey={(key) => {
          setPrivateKey(key);
          const fields = change({ appId, privateKey: key });
          if (fields) onCheck(fields);
        }}
      />
      <PrivateKeyStatusLine
        id={STATUS_ID}
        status={status}
        className="sm:col-span-2"
      />
    </div>
  );
}

const STATUS_ID = "github-app-key-status";

/** How long typing in the App ID pauses before the key is checked. */
const CHECK_DELAY_MS = 500;
