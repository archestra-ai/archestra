# /// script
# requires-python = ">=3.11"
# dependencies = ["google-cloud-storage>=2.18"]
# ///
"""Publish a finished benchmark run from inside the k8s Job: upload artifacts to GCS, post the Slack
summary, and encode harness health in the exit code.

The runner no longer waits for the run — the pod owns reporting end to end. Health (zero passes ⇒
broken harness) is the exit code, so the pod's terminal phase tells CI whether the run was sound.

GCS auth is Workload Identity (ADC); Slack uses stdlib urllib so the alpine image needs no extra CLI.
GCS init and uploads are best-effort: a failure there must never stop the Slack self-report, since for
a run that clears the CI fast-fail window Slack and the GCS aggregate are the only signals.
"""

import argparse
import json
import logging
import os
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from google.cloud import storage

logger = logging.getLogger(__name__)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tb", type=Path, required=True, help="TensorBoard event dir to publish"
    )
    parser.add_argument(
        "--run-dir",
        type=Path,
        required=True,
        help="bench run dir (aggregate.json, report.md)",
    )
    parser.add_argument("--tarball", type=Path, required=True, help="packaged run.tgz")
    args = parser.parse_args()

    run_id = f"{os.environ['GITHUB_RUN_NUMBER']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    summary = _summarize(args.run_dir / "aggregate.json")

    warnings: list[str] = []
    if os.environ.get("BENCH_TB_EXPORT_OK", "1") != "1":
        warnings.append("TensorBoard export failed")
    warnings += _upload(run_id, tb=args.tb, run_dir=args.run_dir, tarball=args.tarball)
    gcs_bucket = os.environ["GCS_BUCKET"]
    links = {
        "report": _https_url(gcs_bucket, f"runs/{run_id}/report.md"),
        "details": _https_url(gcs_bucket, f"runs/{run_id}/aggregate.json"),
    }
    _post_slack(summary, warnings, links=links)

    return 0 if summary.healthy and not warnings else 1


class _Summary:
    def __init__(self, *, healthy: bool, text: str):
        self.healthy = healthy
        self.text = text


def _summarize(aggregate_path: Path) -> _Summary:
    # A hard bench crash can leave no aggregate, or a half-written one — both must still produce a
    # failure summary so the pod reports rather than dying here.
    # The bot name already carries "benchmark", so the text omits it.
    failed = _Summary(healthy=False, text="❌ FAILED — no usable aggregate produced")
    if not aggregate_path.is_file():
        return failed
    try:
        agg = json.loads(aggregate_path.read_text())
        passed, total = agg["passed"], agg["total"]
        outcomes = " ".join(f"{k}={v}" for k, v in agg["outcomes"].items())
        pass_rate = agg["pass_rate"]
    except (OSError, ValueError, KeyError, TypeError):
        logger.exception("could not parse %s", aggregate_path)
        return failed
    if total == 0 or passed == 0:
        return _Summary(
            healthy=False,
            text=f"⚠️ {passed}/{total} passed — harness likely broken · {outcomes}",
        )
    rate = int(pass_rate * 100)
    return _Summary(
        healthy=True, text=f"✅ {passed}/{total} passed ({rate}%) · {outcomes}"
    )


def _upload(run_id: str, *, tb: Path, run_dir: Path, tarball: Path) -> list[str]:
    """Upload artifacts; return a list of human-readable warnings (empty ⇒ all good)."""
    try:
        bucket = _bucket(os.environ["GCS_BUCKET"])
    except Exception:
        logger.exception("GCS client init failed")
        return ["GCS upload unavailable"]

    warnings: list[str] = []
    # Required: the run's record. Missing one is a real failure to surface. The explicit charset keeps
    # report.md / aggregate.json from rendering as latin-1 (mojibake) when opened via the browser URL.
    for local, remote, content_type in (
        (tarball, f"runs/{run_id}/run.tgz", None),
        (
            run_dir / "aggregate.json",
            f"runs/{run_id}/aggregate.json",
            "application/json; charset=utf-8",
        ),
        (
            run_dir / "report.md",
            f"runs/{run_id}/report.md",
            "text/plain; charset=utf-8",
        ),
    ):
        if not local.is_file():
            warnings.append(f"missing {local.name}")
        elif not _upload_one(bucket, local, remote, content_type=content_type):
            warnings.append(f"upload failed: {remote}")

    # Optional: the TensorBoard event tree (overall/ and lane=<lane>/), uploaded verbatim.
    tb_files = [f for f in tb.rglob("*") if f.is_file()]
    if not tb_files:
        warnings.append("no TensorBoard files to upload")
    for local in tb_files:
        remote = f"tb/daily/{local.relative_to(tb).as_posix()}"
        if not _upload_one(bucket, local, remote):
            warnings.append(f"upload failed: {remote}")
    return warnings


def _upload_one(
    bucket: storage.Bucket, local: Path, remote: str, *, content_type: str | None = None
) -> bool:
    try:
        bucket.blob(remote).upload_from_filename(str(local), content_type=content_type)
        logger.info("uploaded %s -> %s", local, remote)
        return True
    except Exception:
        logger.exception("failed to upload %s -> %s", local, remote)
        return False


def _post_slack(
    summary: _Summary, warnings: list[str], *, links: dict[str, str]
) -> None:
    webhook = os.environ.get("SLACK_BENCH_WEBHOOK_URL", "").strip()
    if not webhook:
        logger.info("no Slack webhook configured; skipping")
        return
    text = summary.text
    if warnings:
        text += " · ⚠️ " + "; ".join(warnings)
    for label, url in links.items():
        text += f" · <{url}|{label}>"
    run_url = os.environ.get("RUN_URL", "").strip()
    if run_url:
        text += f" · <{run_url}|run>"
    payload = json.dumps({"text": text}).encode()
    request = urllib.request.Request(
        webhook, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            logger.info("posted Slack summary (%s)", response.status)
    except Exception:
        logger.exception("failed to post Slack summary")


def _bucket_name(gcs_bucket: str) -> str:
    return urlparse(gcs_bucket).netloc if gcs_bucket.startswith("gs://") else gcs_bucket


def _bucket(gcs_bucket: str) -> storage.Bucket:
    return storage.Client().bucket(_bucket_name(gcs_bucket))


def _https_url(gcs_bucket: str, remote: str) -> str:
    # Authenticated browser URL (bucket members only); gs:// isn't clickable in Slack.
    return f"https://storage.cloud.google.com/{_bucket_name(gcs_bucket)}/{remote}"


if __name__ == "__main__":
    raise SystemExit(main())
