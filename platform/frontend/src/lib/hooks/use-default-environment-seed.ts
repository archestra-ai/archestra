"use client";

import type { EnvironmentDefaultableResource } from "@archestra/shared";
import { useEffect, useRef } from "react";
import { useDefaultEnvironmentIdForResource } from "@/lib/environment.query";

/**
 * Pre-selects a create form's environment field with the org's configured
 * landing environment for this resource kind, so the form shows what the
 * backend would pick anyway.
 *
 * Seeds once per enabled stretch, and only after the answer is trustworthy: the
 * environments list and the caller's deploy-to-restricted permission both load
 * asynchronously, and seeding on a partial answer would either write the wrong
 * environment or overwrite a choice the user has already made. A dialog that
 * stays mounted between opens therefore passes `enabled: open && creating` and
 * gets a fresh seed each time it reopens.
 *
 * Pass `enabled: false` on edit forms — an existing resource's environment must
 * never be replaced by a default. Callers that reset their form fields in an
 * effect should call this hook *after* that effect so the reset cannot land on
 * top of the seed.
 */
export function useDefaultEnvironmentSeed(params: {
  resource: EnvironmentDefaultableResource;
  enabled: boolean;
  apply: (environmentId: string) => void;
}): void {
  const { resource, enabled, apply } = params;
  const { environmentId, isResolved } =
    useDefaultEnvironmentIdForResource(resource);
  const seeded = useRef(false);
  // Kept in a ref so a caller passing an inline closure does not re-run (and
  // re-seed) the effect on every render.
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!enabled) {
      // Arm the next enabled stretch (a dialog reopening for another new item).
      seeded.current = false;
      return;
    }
    if (!isResolved || seeded.current) return;
    seeded.current = true;
    // Null is the Default environment, which is what the field already holds.
    if (environmentId) applyRef.current(environmentId);
  }, [enabled, isResolved, environmentId]);
}
