# VEX

`archestra.openvex.json` says which reported vulnerabilities do not affect
Archestra's images as shipped, and why. It is an
[OpenVEX](https://github.com/openvex/spec) document: scanners such as Grype and
Trivy read it and drop the findings it covers, so a security team scanning our
images sees what matters.

## What a Statement Says

Each statement names one vulnerability, the images it covers by short name
(`pkg:oci/platform`, `pkg:oci/agent-codex`), the vulnerable package by its
package URL, and a status:

- **`not_affected`**: the image ships the package, but the vulnerability cannot
  be exploited in it. It needs a `justification` from the OpenVEX list and an
  `impact_statement` a customer's engineer can check without asking us.
- **`fixed`**: the image ships a fix the scanner does not see (a backport).

We do not publish `affected` or `under_investigation` here. A vulnerability
that affects an image is fixed in a release, or announced as an advisory.

## How Statements Get Here

1. The **VEX Triage** agent (`.github/workflows/vex-triage.yml`, weekly)
   scans the latest stable release's images, investigates each untriaged
   Critical and High finding, and opens or updates the pull request from
   `automation/vex-triage` with its evidence.
2. A person checks the evidence and merges it. A statement is a claim we sign:
   when the evidence does not convince you, ask for more or drop the statement.
3. Each release attests every image's statements, pinned to its digest, next to
   its SBOMs (`docs/pages/admin/deployment/verify-releases.md`).

To write one by hand, use the script; it refuses a statement without its reasons:

```bash
python3 .github/scripts/vex.py set --vulnerability CVE-2026-12345 \
  --product platform --subcomponent pkg:npm/example@1.2.3 \
  --status not_affected --justification vulnerable_code_not_in_execute_path \
  --impact-statement "Only the build uses example's CLI; the image never runs it."
python3 .github/scripts/vex.py validate
```

## Check That a Statement Works

Render the image's statements, pinned to its digest, and scan with them. The
finding must disappear:

```bash
IMAGE=docker.io/archestra/platform@$(crane digest --platform linux/amd64 docker.io/archestra/platform:1.4.35)
python3 .github/scripts/vex.py render --image "$IMAGE" > platform.vex.json
grype "registry:$IMAGE" --vex platform.vex.json
trivy image --vex platform.vex.json "$IMAGE"
```
