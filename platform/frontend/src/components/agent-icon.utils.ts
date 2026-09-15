import { siAnthropic, siGithub } from "simple-icons";

/** Values the shared Agent icon controls render as images rather than emoji. */
export function isAgentImageIcon(
  icon: string | null | undefined,
): icon is string {
  return (
    icon?.startsWith("data:image/") === true || icon?.startsWith("/") === true
  );
}

export function getBuiltInServiceIconPath(
  icon: string | null | undefined,
): string | null {
  return icon && Object.hasOwn(BUILT_IN_SERVICE_ICON_PATHS, icon)
    ? BUILT_IN_SERVICE_ICON_PATHS[icon]
    : null;
}

export function isBuiltInServiceIcon(
  icon: string | null | undefined,
): icon is string {
  return getBuiltInServiceIconPath(icon) !== null;
}

/**
 * Built-in vector service logos selectable via the "logo:<slug>" icon
 * convention (e.g. the GitHub App credential type). Not free-form: these are
 * the only slugs the shared icon controls know how to render as an SVG mark
 * rather than falling back to literal emoji text.
 */
const BUILT_IN_SERVICE_ICON_PATHS: Record<string, string> = {
  "logo:github": siGithub.path,
  "logo:anthropic": siAnthropic.path,
};
