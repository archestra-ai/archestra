"""Required screenshot gate: PR entry is deferred; queue capture must succeed."""

import os
import sys


def main():
    event = os.environ["EVENT_NAME"]
    result = os.environ["CAPTURE_RESULT"]
    required = event == "merge_group" or (
        event == "workflow_dispatch" and os.environ.get("VALIDATION_ONLY") == "true"
    )
    if required:
        if result != "success":
            print(f"Screenshot capture must succeed; got {result!r}.", file=sys.stderr)
            return 1
        message = "All docs screenshots captured and image policy validated; no images published."
    elif event == "pull_request" or event == "workflow_dispatch":
        if result != "skipped":
            print(f"Unexpected capture result for deferred validation: {result!r}", file=sys.stderr)
            return 1
        message = (
            "Screenshot execution deferred to merge queue; this PR-entry check does not validate screenshots."
            if event == "pull_request"
            else "Screenshot publication requested separately; merge-queue validation is deferred."
        )
    else:
        print(f"Unsupported event: {event!r}", file=sys.stderr)
        return 1
    print(message)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as output:
            output.write(message + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
