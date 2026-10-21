#!/usr/bin/env python3
"""Check Terraform request contracts and compile/test against the current API.

Run from platform/ with Go installed. The provider checkout is copied before any
code generation. No platform server, credentials, or Terraform apply is needed.
"""

import argparse
import hashlib
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


class OfflineGenerationError(ValueError):
    pass


class ClientGenerationError(ValueError):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", type=Path, required=True,
                        help="Checkout of terraform-provider-archestra")
    parser.add_argument("--spec", type=Path,
                        default=Path(__file__).resolve().parents[2] / "docs/openapi.json")
    args = parser.parse_args()
    env = clean_env() | {"ARCHESTRA_TERRAFORM_OPENAPI": str(args.spec.resolve())}
    try:
        with tempfile.TemporaryDirectory(prefix="terraform-provider-check-") as work:
            provider = Path(work) / "provider"
            shutil.copytree(args.provider.resolve(), provider,
                            ignore=shutil.ignore_patterns(".git", ".codegen", "crossplane"))
            print("Regenerating the API client with the provider's pinned tools...", flush=True)
            generate_client(provider=provider, spec=args.spec.resolve(), env=env)
            original = Path(work) / "original"
            shutil.copytree(args.provider.resolve(), original,
                            ignore=shutil.ignore_patterns(".git", ".codegen", "crossplane"))
            contract = Path(__file__).with_name("terraform-provider") / "platform_contract_test.go"
            shutil.copyfile(contract, original / "internal/provider/platform_contract_test.go")
            print("Checking existing provider requests against platform OpenAPI...", flush=True)
            requests = subprocess.run(
                ["go", "-C", str(original), "test", "./internal/provider",
                 "-run", "^TestPlatformTerraform", "-count=1", "-timeout=120s"], env=env,
            )
            print("Compiling and running provider unit tests with the current API...", flush=True)
            tests = subprocess.run(
                ["go", "-C", str(provider), "test", "./...", "-count=1", "-timeout=120s"], env=env,
            )
            if requests.returncode or tests.returncode:
                print("Terraform provider compatibility failed: "
                      f"request contracts={requests.returncode}, regenerated unit tests={tests.returncode}.\n"
                      "Synchronize provider main using the Update Terraform Provider repair workflow.", file=sys.stderr)
                return 1
    except ClientGenerationError as error:
        print(error, file=sys.stderr)
        return 1
    except OfflineGenerationError as error:
        print(error, file=sys.stderr)
        return 2
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Terraform provider check could not run: {error}", file=sys.stderr)
        return 2
    print("Terraform provider request contracts and regenerated unit tests passed.")
    return 0


def clean_env():
    env = os.environ | {"GOFLAGS": "-mod=readonly", "TF_ACC": ""}
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "ARCHESTRA_API_KEY", "ARCHESTRA_BASE_URL"):
        env.pop(key, None)
    return env


def has_credential_target(makefile):
    # Inspect declarations only; never execute tooling to discover the layout.
    return bool(re.search(r"^codegen-credential-client\s*:(?!=)", makefile, re.M))


def generate_client(*, provider, spec, env):
    # The provider owns normalization, operation selection, flags and bridges.
    # Run its canonical pipeline only in the isolated trusted checkout copy.
    selected_hash = hashlib.sha256(spec.read_bytes()).hexdigest()
    credential = has_credential_target((provider / "Makefile").read_text())
    targets = ["codegen-api-client"] + (["codegen-credential-client"] if credential else [])
    result = subprocess.run(
        ["make", "-C", str(provider), *targets],
        env=env | {"OPENAPI_SPEC": str(spec.resolve()),
                   "ARCHESTRA_OPENAPI_SPEC": str(spec.resolve()),
                   "ARCHESTRA_BASE_URL": "http://127.0.0.1:9"},
    )
    def verify_source(name):
        source = provider / ".codegen" / name
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != selected_hash:
            raise OfflineGenerationError(
                "The provider revision does not read OPENAPI_SPEC in make codegen-api-client; "
                "choose a provider_ref with offline generation (provider v3 or later)."
            )
    verify_source("openapi.raw.json")
    if result.returncode:
        raise ClientGenerationError(
            f"Client generation failed for the selected spec (make exit {result.returncode}); "
            "the provider's codegen must handle this API change."
        )
    if credential:
        verify_source("credentials-source.json")
    print(f"All generated-client source SHA256 hashes match the selected spec: {selected_hash}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
