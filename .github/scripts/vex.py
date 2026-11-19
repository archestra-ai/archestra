#!/usr/bin/env python3
"""Edit and check vex/archestra.openvex.json, the OpenVEX document of our images.

The document says, per vulnerability and image, whether the vulnerability
affects the image as shipped (https://github.com/openvex/spec). Each release
attests the statements about each image, pinned to its digest, next to its
SBOMs (archestra-ai/.github actions/attest-release-image), and release-publisher
copies that attestation to every registry the image is published to. The VEX
Triage agent (archestra-ai/infra, archestra/automation) proposes statements in
pull requests; people merge them.

Products are images by short name, `pkg:oci/<image>` (`pkg:oci/platform`,
`pkg:oci/agent-codex`), so one statement covers the image in every registry.

  validate [--document PATH]
      Checks the document. CI runs it through test_vex.py.

  set --vulnerability ID --product IMAGE [--product IMAGE ...] --status STATUS
      [--subcomponent PURL ...] [--justification J] [--impact-statement TEXT]
      [--action-statement TEXT] [--status-notes TEXT] [--document PATH]
      Records one statement. A product that an earlier statement of the same
      vulnerability named moves to this one, so each vulnerability and image
      has one status. Bumps the document's version and timestamp.

  render --image NAME@sha256:DIGEST [--document PATH]
      Prints the statements about one image, pinned to its digest under that
      name, as the release attests them. Feed it to a scanner to check that a
      statement suppresses its finding: `grype <image> --vex FILE`,
      `trivy image --vex FILE <image>`.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

DOCUMENT = Path(__file__).resolve().parents[2] / "vex" / "archestra.openvex.json"
CONTEXT = "https://openvex.dev/ns/v0.2.0"
STATUSES = ("not_affected", "affected", "fixed", "under_investigation")
JUSTIFICATIONS = (
    "component_not_present",
    "vulnerable_code_not_present",
    "vulnerable_code_not_in_execute_path",
    "vulnerable_code_cannot_be_controlled_by_adversary",
    "inline_mitigations_already_exist",
)
VULNERABILITY = re.compile(r"(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})")
PRODUCT = re.compile(r"pkg:oci/(?P<image>[a-z0-9][a-z0-9._-]*)")
PURL = re.compile(r"pkg:[a-z][a-z0-9.+-]*/\S+")
IMAGE = re.compile(r"(?P<name>[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:/[a-z0-9._-]+)+)(?::[\w][\w.-]{0,127})?@sha256:(?P<digest>[0-9a-f]{64})")


class Invalid(Exception):
    """The document, or a statement for it, breaks a rule."""


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--document", type=Path, default=DOCUMENT)
    record = commands.add_parser("set")
    record.add_argument("--document", type=Path, default=DOCUMENT)
    record.add_argument("--vulnerability", required=True)
    record.add_argument("--product", action="append", required=True, help="Image short name, such as platform.")
    record.add_argument("--subcomponent", action="append", default=[], help="Package URL of the vulnerable package.")
    record.add_argument("--status", choices=STATUSES, required=True)
    record.add_argument("--justification", choices=JUSTIFICATIONS)
    record.add_argument("--impact-statement")
    record.add_argument("--action-statement")
    record.add_argument("--status-notes")
    render = commands.add_parser("render")
    render.add_argument("--document", type=Path, default=DOCUMENT)
    render.add_argument("--image", required=True)
    args = parser.parse_args(argv)

    if args.command == "validate":
        document = load(args.document)
        print(f"{args.document}: {len(document['statements'])} statement(s), version {document['version']}")
    elif args.command == "set":
        set_statement(args)
    else:
        json.dump(rendered(load(args.document), args.image), sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


def load(path):
    """The document at `path`, checked."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    check_document(document)
    return document


def check_document(document):
    if not isinstance(document, dict) or document.get("@context") != CONTEXT:
        raise Invalid(f"not an OpenVEX document: @context must be {CONTEXT}")
    for key in ("@id", "author", "timestamp"):
        if not isinstance(document.get(key), str) or not document[key]:
            raise Invalid(f"the document has no {key}")
    check_time(document["timestamp"], "the document's timestamp")
    if not isinstance(document.get("version"), int) or document["version"] < 1:
        raise Invalid("the document's version must be a positive integer")
    statements = document.get("statements")
    if not isinstance(statements, list):
        raise Invalid("the document has no statements list")
    seen = {}
    for index, statement in enumerate(statements):
        check_statement(statement, f"statement {index}")
        for product in statement["products"]:
            key = (statement["vulnerability"]["name"], product["@id"])
            if key in seen:
                raise Invalid(f"{key[0]} for {key[1]} is in statements {seen[key]} and {index}: keep one status")
            seen[key] = index


def check_statement(statement, where):
    if not isinstance(statement, dict):
        raise Invalid(f"{where} is not an object")
    name = (statement.get("vulnerability") or {}).get("name")
    if not isinstance(name, str) or not VULNERABILITY.fullmatch(name):
        raise Invalid(f"{where} names no CVE or GHSA vulnerability: {name!r}")
    where = f"{where} ({name})"
    products = statement.get("products")
    if not isinstance(products, list) or not products:
        raise Invalid(f"{where} has no products")
    for product in products:
        if not isinstance(product, dict) or not PRODUCT.fullmatch(str(product.get("@id"))):
            raise Invalid(f"{where}: a product must be an image by short name, pkg:oci/<image>: {product!r}")
        for component in product.get("subcomponents") or []:
            if not isinstance(component, dict) or not PURL.fullmatch(str(component.get("@id"))):
                raise Invalid(f"{where}: a subcomponent must be a package URL: {component!r}")
    status = statement.get("status")
    if status not in STATUSES:
        raise Invalid(f"{where} has status {status!r}, not one of {', '.join(STATUSES)}")
    justification = statement.get("justification")
    if justification is not None and justification not in JUSTIFICATIONS:
        raise Invalid(f"{where} has justification {justification!r}, not one of {', '.join(JUSTIFICATIONS)}")
    if status == "not_affected":
        # The spec asks for one of the two; we ask for both, so a reader can
        # check the claim without asking us.
        if not justification or not text(statement.get("impact_statement")):
            raise Invalid(f"{where} is not_affected: give a justification and an impact_statement saying why")
    elif justification:
        raise Invalid(f"{where}: only a not_affected statement has a justification")
    if status == "affected" and not text(statement.get("action_statement")):
        raise Invalid(f"{where} is affected: give an action_statement saying what users should do")
    check_time(statement.get("timestamp"), f"{where}'s timestamp")


def set_statement(args):
    document = load(args.document)
    name = args.vulnerability.strip()
    product_ids = [f"pkg:oci/{product}" for product in dict.fromkeys(args.product)]
    now = timestamp()
    statement = {
        "vulnerability": {"name": name},
        "products": [{"@id": product_id, **({"subcomponents": [{"@id": purl} for purl in args.subcomponent]}
                                            if args.subcomponent else {})} for product_id in product_ids],
        "status": args.status,
        "timestamp": now,
    }
    for key, value in (("justification", args.justification), ("impact_statement", args.impact_statement),
                       ("action_statement", args.action_statement), ("status_notes", args.status_notes)):
        if value:
            statement[key] = value.strip()
    check_statement(statement, "the new statement")

    # The products this statement names leave every earlier statement of the
    # same vulnerability; a statement left with none goes.
    kept = []
    for existing in document["statements"]:
        if existing["vulnerability"]["name"] == name:
            existing["products"] = [p for p in existing["products"] if p["@id"] not in product_ids]
            if not existing["products"]:
                continue
        kept.append(existing)
    kept.append(statement)
    kept.sort(key=lambda s: (s["vulnerability"]["name"], s["products"][0]["@id"]))
    document["statements"] = kept
    document["version"] += 1
    document["timestamp"] = now
    check_document(document)
    args.document.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"{name}: {args.status} for {', '.join(args.product)} (document version {document['version']})")


def rendered(document, image):
    """The statements about `image`, pinned to its digest, as attest-release-image attests them."""
    match = IMAGE.fullmatch(image)
    if not match:
        raise Invalid(f"image must be a repository pinned by digest (<registry>/<path>@sha256:<digest>): {image}")
    name, digest = match["name"], match["digest"]
    short = name.rsplit("/", 1)[-1]
    purl = f"pkg:oci/{short}@sha256%3A{digest}?repository_url={name}"
    statements = []
    for statement in document["statements"]:
        products = [p for p in statement["products"] if p["@id"] == f"pkg:oci/{short}"]
        if products:
            subcomponents = [c for p in products for c in p.get("subcomponents") or []]
            product = {"@id": purl, "identifiers": {"purl": purl}, "hashes": {"sha-256": digest}}
            if subcomponents:
                product["subcomponents"] = subcomponents
            statements.append({**statement, "products": [product]})
    return {
        "@context": CONTEXT,
        "@id": f"{document['@id']}#{name}@sha256:{digest}",
        "author": document["author"],
        "timestamp": document["timestamp"],
        "version": document["version"],
        "statements": statements,
    }


def check_time(value, where):
    try:
        datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise Invalid(f"{where} is not an ISO 8601 time: {value!r}") from None


def text(value):
    return isinstance(value, str) and value.strip() != ""


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Invalid, OSError, json.JSONDecodeError) as error:
        sys.exit(f"::error::vex.py: {error}")
