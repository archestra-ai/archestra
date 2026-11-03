import { LockKeyhole } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

interface EnterpriseLicenseRequiredProps {
  /** The name of the feature that requires the enterprise license */
  featureName: string;
}

export function EnterpriseLicenseRequired({
  featureName,
}: EnterpriseLicenseRequiredProps) {
  return (
    <InlineNotice variant="neutral">
      <LockKeyhole aria-hidden="true" />
      <span className="font-medium">Enterprise license required</span>
      <InlineNoticeText>
        Activate an Enterprise license to use {featureName}.
      </InlineNoticeText>
      <a
        href="mailto:sales@archestra.ai"
        className="ml-auto underline underline-offset-4"
      >
        Contact sales
      </a>
    </InlineNotice>
  );
}
