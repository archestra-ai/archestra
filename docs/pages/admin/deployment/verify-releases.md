---
title: Verify Releases
description: Check that an Archestra image was built by Archestra, and get its signed SBOM and VEX statements for your vulnerability scanner.
order: 10
lastUpdated: 2026-11-20
---

Prove that the Archestra image you run is the one Archestra released, and see every package inside it, without trusting the registry. Each release image carries signed attestations next to it in its registry: where it was built, its SBOM, and scans for live credentials and malware. `gh`, cosign, and admission controllers such as Kyverno read them.

## What Each Image Carries

Every attestation is signed with a GitHub Actions identity from an Archestra workflow run, and logged in the public Sigstore transparency log. Provenance comes from the merge-queue run that built the image. The other attestations come from the release run.

| Attestation | Tells you | Predicate type | Signed by |
| --- | --- | --- | --- |
| Build provenance | The repository, commit, and workflow run that built the image | `https://slsa.dev/provenance/v1` | `archestra-ai/.github/.github/workflows/attest-provenance.yml` |
| SBOM (SPDX) | Every package in the image, in SPDX 2.3 | `https://spdx.dev/Document/v2.3` | `archestra-ai/.github/.github/workflows/release-publish.yml` |
| SBOM (CycloneDX) | The same packages, in CycloneDX | `https://cyclonedx.org/bom` | `archestra-ai/.github/.github/workflows/release-publish.yml` |
| Secret scan | How many credentials a scan found, by type and whether they were live | `https://archestra.ai/attestations/secret-scan/v1` | `archestra-ai/.github/.github/workflows/release-publish.yml` |
| Malware scan | What a ClamAV scan of every file in the image found, and which signature database it used | `https://archestra.ai/attestations/malware-scan/v1` | `archestra-ai/.github/.github/workflows/release-publish.yml` |
| VEX | Which reported vulnerabilities do not affect the image, and why | `https://openvex.dev/ns/v0.2.0` | `archestra-ai/.github/.github/workflows/release-publish.yml` |
| Verification summary | That the build provenance passed Archestra's [SLSA Build L3](https://slsa.dev/spec/v1.0/levels#build-l3) policy, so you can check one attestation instead | `https://slsa.dev/verification_summary/v1` | `archestra-ai/.github/.github/workflows/release-publish.yml` |

They cover `docker.io/archestra/platform`, plus `mcp-server-base`, `p4-shim`, `sandbox-base`, and `agent-*` under `ghcr.io/archestra-ai/`.

What to know:

- The SBOMs list the `linux/amd64` image. The `linux/arm64` image is built from the same source and is covered by the same provenance.
- An image with a live credential or a malware detection is never released. The secret scan holds counts only, never a secret or where it was found.
- Each image is built and scanned in Archestra's merge queue, and the release publishes those exact bytes. Its provenance is signed there, in a job that runs none of the build's steps, so a build cannot forge it ([SLSA Build L3](https://slsa.dev/spec/v1.0/levels#build-l3)). The certificate names Archestra's repository, the merge group's commit, and the run that built the image.

## Verify Archestra Images

Check the platform image your cluster runs. Each command exits non-zero for an image Archestra did not release.

```bash
IMAGE=$(kubectl -n archestra get deployment archestra-platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
DIGEST=${IMAGE#*@}

# Built by Archestra's merge queue
gh attestation verify "oci://docker.io/archestra/platform@$DIGEST" \
  --repo archestra-ai/archestra --bundle-from-oci \
  --signer-workflow archestra-ai/.github/.github/workflows/attest-provenance.yml

# Its SBOM, from the release run
gh attestation verify "oci://docker.io/archestra/platform@$DIGEST" \
  --repo archestra-ai/archestra --bundle-from-oci \
  --signer-workflow archestra-ai/.github/.github/workflows/release-publish.yml \
  --predicate-type https://spdx.dev/Document/v2.3

# Its provenance passed SLSA Build L3, in one check
gh attestation verify "oci://docker.io/archestra/platform@$DIGEST" \
  --repo archestra-ai/archestra --bundle-from-oci \
  --signer-workflow archestra-ai/.github/.github/workflows/release-publish.yml \
  --predicate-type https://slsa.dev/verification_summary/v1
```

To check without `gh`, use cosign. The identity is the shared signing workflow, so also pin Archestra's repository and the merge queue's `merge_group` trigger:

```bash
cosign verify-attestation --new-bundle-format --type slsaprovenance1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/archestra-ai/\.github/\.github/workflows/attest-provenance\.yml@' \
  --certificate-github-workflow-repository archestra-ai/archestra \
  --certificate-github-workflow-trigger merge_group \
  "docker.io/archestra/platform@$DIGEST"
```

Only the merge queue runs with `merge_group`, and it merges reviewed changes to `main` and `release/*`.

## Scan the SBOM

Feed an image's SBOM to your vulnerability scanner instead of pulling and scanning the image yourself. Verify and extract it in one command:

```bash
gh attestation verify "oci://docker.io/archestra/platform@$DIGEST" \
  --repo archestra-ai/archestra --bundle-from-oci \
  --signer-workflow archestra-ai/.github/.github/workflows/release-publish.yml \
  --predicate-type https://cyclonedx.org/bom --format json \
  | jq '.[0].verificationResult.statement.predicate' > platform.cdx.json
```

- **Dependency-Track and other CycloneDX tools:** upload `platform.cdx.json`.
- **Grype, Trivy, and license tools:** use `--predicate-type https://spdx.dev/Document/v2.3` to get the SPDX file, then run `grype sbom:platform.spdx.json` or `trivy sbom platform.spdx.json`.

## Drop Findings That Do Not Affect the Image

Stop chasing CVEs that cannot be exploited in an Archestra image. A scanner reports a vulnerable package whether or not the image ever runs the vulnerable code. Archestra investigates those findings and signs a [VEX](https://github.com/openvex/spec) statement for each one that does not apply, with the reason. Your scanner reads the statements and drops those findings.

1. Verify and extract the image's statements:

   ```bash
   gh attestation verify "oci://docker.io/archestra/platform@$DIGEST" \
     --repo archestra-ai/archestra --bundle-from-oci \
     --signer-workflow archestra-ai/.github/.github/workflows/release-publish.yml \
     --predicate-type https://openvex.dev/ns/v0.2.0 --format json \
     | jq '.[0].verificationResult.statement.predicate' > platform.vex.json
   ```

2. Scan with them:

   ```bash
   grype "docker.io/archestra/platform@$DIGEST" --vex platform.vex.json
   trivy image --vex platform.vex.json "docker.io/archestra/platform@$DIGEST"
   ```

The findings the statements cover no longer appear. To list them anyway, add `--show-suppressed` to the Grype command.

What to know:

- Each statement says why: the vulnerable code is not in the image, is never run, or cannot be reached by an attacker. Read `impact_statement` in `platform.vex.json` to check a claim.
- An image that no statement covers has no VEX attestation, so `gh attestation verify` fails for it. Scan it as usual.
- Statements are added as Archestra investigates new advisories. The newest are in [`vex/openvex.json`](https://github.com/archestra-ai/archestra/blob/main/vex/openvex.json), which Grype and Trivy read as is.

## How Fast Vulnerabilities Get Fixed

Archestra fixes a critical vulnerability in its release images within 7 days of a fix being available upstream, and a high one within 30 days. Medium and low vulnerabilities are fixed in regular releases.

What to know:

- A fix lands in the next release candidate and is backported to the latest stable line as a patch release. Earlier stable lines get no fixes, so upgrade to the latest one.
- Archestra never releases an image with a fixable critical or high vulnerability. Base images are checked for updates daily, and the next release's images are built and scanned nightly, so an advisory is caught between releases.
- A finding that cannot be exploited in the image gets a [VEX statement](#drop-findings-that-do-not-affect-the-image), so your scanner drops it. Archestra triages the latest stable release and release candidate each week.

## Admit Only Archestra Images

Make your cluster refuse any Archestra image that Archestra did not build. Kyverno and Sigstore policy-controller run in your cluster next to the chart. The chart does not install either.

- **Kyverno:** this [`SigstoreBundle` policy](https://kyverno.io/docs/policy-types/cluster-policy/verify-images/sigstore/) rejects a pod whose Archestra image fails the provenance check. Pods with other images pass through.

  ```yaml
  apiVersion: kyverno.io/v1
  kind: ClusterPolicy
  metadata:
    name: verify-archestra-images
  spec:
    webhookTimeoutSeconds: 30
    rules:
      - name: archestra-build-provenance
        match:
          any:
            - resources:
                kinds: [Pod]
        verifyImages:
          - type: SigstoreBundle
            failureAction: Enforce
            imageReferences:
              - "docker.io/archestra/platform*"
              - "ghcr.io/archestra-ai/mcp-server-base*"
              - "ghcr.io/archestra-ai/p4-shim*"
              - "ghcr.io/archestra-ai/sandbox-base*"
              - "ghcr.io/archestra-ai/agent-*"
            attestations:
              - type: https://slsa.dev/provenance/v1
                attestors:
                  - entries:
                      - keyless:
                          issuer: https://token.actions.githubusercontent.com
                          subjectRegExp: '^https://github\.com/archestra-ai/\.github/\.github/workflows/attest-provenance\.yml@'
                          additionalExtensions:
                            githubWorkflowRepository: archestra-ai/archestra
                            githubWorkflowTrigger: merge_group
                          rekor:
                            url: https://rekor.sigstore.dev
  ```

- **Sigstore policy-controller:** set `signatureFormat: bundle` in a `ClusterImagePolicy` with the issuer and identity above. See [Sigstore bundle format](https://docs.sigstore.dev/policy-controller/overview/).
- **GKE Binary Authorization:** its [Sigstore signature check](https://docs.cloud.google.com/binary-authorization/docs/cv-sigstore-check) verifies only public-key signatures in Artifact Registry, so it cannot check these attestations. On GKE, use Kyverno or policy-controller.

What to know:

- The policy admits every Archestra release line, release candidates included. The chart's image tags decide which version runs.
- A registry mirror must copy the attestations with the image: `oras cp -r <image>@<digest> <mirror>/<image>` does. Point the policy's image references at the mirror.
- An older release may have its attestations on GitHub only. If `--bundle-from-oci` finds none, drop the flag to check with GitHub instead.
