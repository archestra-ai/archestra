#!/usr/bin/env python3
"""Write the VEX statements for one image in the form Docker Scout applies.

vex/openvex.json names each image as a product (`pkg:oci/<short name>`) with
the vulnerable packages as its subcomponents. Scout applies a statement only
when the package itself is a product, so this keeps the statements about the
scanned image and lists that image's packages as their products. A statement
about another image never reaches this scan.

    scout-vex.py --document vex/openvex.json --image <reference> --output DIR

The output directory is what `docker scout cves --vex-location` reads. It holds
no document when no statement covers the image.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# ===
# Public interface
# ===


def image_product(reference):
    """`pkg:oci/<short name>` for an image reference, with or without a scheme, tag or digest."""
    name = re.sub(r"^[a-z]+://", "", reference).split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    return f"pkg:oci/{last.split(':', 1)[0]}"


def scoped(document, product):
    """The document's statements about `product`, each with its packages as products."""
    statements = []
    for statement in document.get("statements") or []:
        packages = [
            component["@id"]
            for item in statement.get("products") or []
            if item.get("@id") == product
            for component in item.get("subcomponents") or []
        ]
        if packages:
            statements.append({
                **{key: value for key, value in statement.items() if key != "products"},
                "products": [{"@id": package} for package in dict.fromkeys(packages)],
            })
    if not statements:
        return None
    return {**document, "@id": f"{document.get('@id', 'vex')}#{product}", "statements": statements}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--document", required=True, type=Path)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)

    product = image_product(args.image)
    result = scoped(json.loads(args.document.read_text(encoding="utf-8")), product)
    args.output.mkdir(parents=True, exist_ok=True)
    if result is None:
        print(f"No VEX statement covers {product}")
        return 0
    (args.output / "openvex.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"{len(result['statements'])} VEX statement(s) cover {product}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
