import type {
  SubscriptionCredentialKind,
  SupportedProvider,
} from "@archestra/shared";
import Image from "next/image";
import { ProviderIcon } from "@/components/provider-icon";

/**
 * Subscription cards and connect rows use the product mark (Grok for
 * SuperGrok). Provider keys and models keep the vendor logo via ProviderIcon.
 */
export function SubscriptionBrandIcon({
  kind,
  provider,
  size = 16,
}: {
  kind?: SubscriptionCredentialKind | null;
  provider: SupportedProvider;
  size?: number;
}) {
  if (kind === "x-premium") {
    return (
      <span
        className="relative inline-flex shrink-0"
        style={{ width: size, height: size }}
      >
        <Image
          src="/icons/grok.png"
          alt="SuperGrok"
          width={size}
          height={size}
          className="dark:hidden"
        />
        <Image
          src="/icons/grok-dark.png"
          alt="SuperGrok"
          width={size}
          height={size}
          className="hidden dark:block"
        />
      </span>
    );
  }
  return <ProviderIcon provider={provider} size={size} />;
}
