import sys
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
# make the bundled scripts and the installer importable as top-level modules in tests.
sys.path.insert(0, str(KIT / "scripts"))
sys.path.insert(0, str(KIT))
