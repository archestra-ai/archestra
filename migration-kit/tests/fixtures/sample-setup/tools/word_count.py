#!/usr/bin/env python3
"""sample local tool: count words in a text file."""
import json
import sys

def main() -> int:
    text = open(sys.argv[1]).read()
    print(json.dumps({"words": len(text.split())}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
