import { TriangleAlert } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

export function OpenAppaGithubAppRequirements() {
  return (
    <InlineNotice variant="warning" className="items-start">
      <TriangleAlert aria-hidden />
      <span className="font-medium">GitHub App access</span>
      <InlineNoticeText>
        Install the App on the account that will own this repository. Select All
        repositories and grant Administration, Contents, and Pull requests Read
        &amp; write.
      </InlineNoticeText>
    </InlineNotice>
  );
}
