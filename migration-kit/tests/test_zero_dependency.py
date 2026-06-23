"""machine-checked guarantee that the shipped code stays zero-dependency.

the portability promise (stock python>=3.10, no uv/pip/network) holds only if scripts/ and
install.py import nothing outside the standard library. this asserts exactly that, so a stray
third-party import is caught in review rather than on an air-gapped host.
"""
import ast
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
SCRIPTS = KIT / "scripts"
# local modules resolve by filename (e.g. `from contracts import ...`), not by install.
LOCAL_MODULES = {path.stem for path in SCRIPTS.glob("*.py")}
# install.py is also shipped, stdlib-only, curl|python3 runtime code -- held to the same bar.
SHIPPED = sorted(SCRIPTS.glob("*.py")) + [KIT / "install.py"]


def _top_level_imports(tree: ast.AST) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(tree):
        match node:
            case ast.Import(names=names):
                modules.update(alias.name.split(".", 1)[0] for alias in names)
            case ast.ImportFrom(level=0, module=str(module)):
                modules.add(module.split(".", 1)[0])
    return modules


def test_shipped_code_imports_only_stdlib_or_local() -> None:
    assert all(path.exists() for path in SHIPPED), f"missing shipped file under {KIT}"
    allowed = sys.stdlib_module_names | LOCAL_MODULES
    for path in SHIPPED:
        foreign = _top_level_imports(ast.parse(path.read_text(encoding="utf-8"))) - allowed
        assert not foreign, f"{path.name} imports non-stdlib module(s): {sorted(foreign)}"
