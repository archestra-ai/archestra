export const BUNDLE_STEPS = [
  { id: "details", title: "Details" },
  { id: "capabilities", title: "Capabilities" },
] as const;

export type BundleStep = (typeof BUNDLE_STEPS)[number]["id"];

export function bundleDetailHref(id: string): string {
  return `/bundles/${encodeURIComponent(id)}`;
}

export function bundleEditHref(id: string, step?: BundleStep): string {
  const href = `${bundleDetailHref(id)}/edit`;
  return step ? `${href}?step=${step}` : href;
}

export function bundleConnectionHref(id: string): string {
  return `/connection?bundleId=${encodeURIComponent(id)}`;
}

export function resolveBundleStep(value: string | null): BundleStep {
  return BUNDLE_STEPS.some((step) => step.id === value)
    ? (value as BundleStep)
    : "details";
}
