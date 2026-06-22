"""Run with: uv run --with tensorboard --with pytest pytest scripts/tests/test_export_tensorboard.py

Exercises the real export over the committed sample run dir and reads the emitted event files back
through TensorBoard's event reader — no mocks.
"""

import importlib.util
from pathlib import Path

from tensorboard.backend.event_processing.event_file_loader import EventFileLoader

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
SAMPLE_RUN = Path(__file__).resolve().parent / "sample_run"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "export_tensorboard", SCRIPTS_DIR / "export_tensorboard.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_scalars(run_dir: Path) -> dict[str, list[tuple[int, float]]]:
    scalars: dict[str, list[tuple[int, float]]] = {}
    for event_file in sorted(run_dir.glob("events.out.tfevents.*")):
        for event in EventFileLoader(str(event_file)).Load():
            for value in event.summary.value:
                scalars.setdefault(value.tag, []).append(
                    (event.step, value.tensor.float_val[0])
                )
    return scalars


def test_export_emits_expected_tags(tmp_path):
    module = _load_module()
    step = 4242

    module.export(SAMPLE_RUN, tmp_path, step)

    overall = _read_scalars(tmp_path / "overall")
    assert overall["overall/pass_rate"] == [(step, 0.5)]
    assert overall["overall/total"] == [(step, 2.0)]
    assert overall["overall/passed"] == [(step, 1.0)]
    assert overall["outcomes/passed"] == [(step, 1.0)]
    assert overall["outcomes/failed"] == [(step, 1.0)]

    lane = _read_scalars(tmp_path / "lane=glm")
    assert lane["pass_rate"] == [(step, 0.5)]
    assert lane["pass/basic/alpha"] == [(step, 1.0)]
    assert lane["pass/basic/beta"] == [(step, 0.0)]
    assert lane["turns/basic/alpha"] == [(step, 3.0)]
    assert lane["tool_calls/basic/alpha"] == [(step, 5.0)]
    assert lane["tokens/basic/alpha"] == [(step, 1500.0)]
    assert lane["outcome/passed/basic/alpha"] == [(step, 1.0)]
    assert lane["outcome/failed/basic/beta"] == [(step, 1.0)]

    # A null metric is skipped, never written as 0.0.
    assert "tokens/basic/beta" not in lane


def test_default_step_combines_run_number_and_attempt(monkeypatch):
    module = _load_module()
    monkeypatch.setenv("GITHUB_RUN_NUMBER", "57")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "3")
    assert module.default_step() == 5703
