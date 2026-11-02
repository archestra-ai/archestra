"""archestra-memory-warden stops the agent's largest command near the memory
limit, and never the client, PID 1 or anything detached from the agent."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

GIB = 1 << 30
WARDEN = next(
    path
    for path in (
        Path("/usr/local/bin/archestra-memory-warden"),
        Path(__file__).resolve().parent.parent / "bin" / "archestra-memory-warden",
    )
    if path.exists()
)


def load_warden():
    loader = importlib.machinery.SourceFileLoader("archestra_memory_warden", str(WARDEN))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


warden = load_warden()


def process(ppid, pgid, score, anon, cmd="sh"):
    return {"ppid": ppid, "pgid": pgid, "comm": cmd.split()[0], "score": score, "anon": anon, "cmd": cmd}


class TriggerTest(unittest.TestCase):
    def test_counts_only_memory_the_kernel_cannot_reclaim(self):
        stat = "anon 100\nfile 5000\nshmem 10\nkernel_stack 1\npagetables 2\nslab_reclaimable 700\nslab_unreclaimable 3\nsock 4\n"
        self.assertEqual(warden.unreclaimable_bytes(stat), 120)

    def test_reserve_scales_with_the_limit_within_bounds(self):
        self.assertEqual(warden.reserve_bytes(4 * GIB), int(0.3 * GIB))
        self.assertEqual(warden.reserve_bytes(8 * GIB), int(0.6 * GIB))
        self.assertEqual(warden.reserve_bytes(24 * GIB), GIB)

    def test_stops_near_the_limit_or_when_thrashing_close_to_it(self):
        limit = 4 * GIB
        self.assertIsNone(warden.trigger(limit, int(3.6 * GIB), 0.0))
        self.assertEqual(warden.trigger(limit, int(3.75 * GIB), 0.0), "limit")
        self.assertEqual(warden.trigger(limit, int(3.5 * GIB), 35.0), "pressure")
        self.assertIsNone(warden.trigger(limit, int(2.0 * GIB), 90.0))
        self.assertIsNone(warden.trigger(None, 10 * GIB, 90.0))


class VictimTest(unittest.TestCase):
    # 10 is the agent's tmux server, 11 the client, 12 its shell command (its
    # own group) with 13 a compiler under it. 20 and 30 are a dev server and
    # PostgreSQL the agent started; they carry the score but run detached.
    table = {
        1: process(0, 1, "0", 1),
        10: process(1, 10, "0", 5, "tmux: server"),
        11: process(10, 11, "0", 900 * (1 << 20), "claude"),
        12: process(11, 12, "1000", 3 << 20, "bash -c pnpm type-check"),
        13: process(12, 12, "1000", 2 * GIB, "tsc --noEmit"),
        20: process(1, 20, "1000", 600 << 20, "node dist/server.mjs"),
        30: process(1, 30, "1000", 300 << 20, "postgres"),
    }

    def test_stops_the_agents_command_group_with_the_most_memory(self):
        pids, anon, cmd = warden.choose_victim(self.table, {10}, own_pid=99)
        self.assertEqual(pids, [12, 13])
        self.assertEqual(anon, 2 * GIB + (3 << 20))
        self.assertEqual(cmd, "bash -c pnpm type-check")

    def test_never_the_client_or_a_detached_server(self):
        table = {pid: info for pid, info in self.table.items() if pid not in (12, 13)}
        self.assertIsNone(warden.choose_victim(table, {10}, own_pid=99))

    def test_a_command_in_the_clients_group_is_stopped_alone(self):
        table = dict(self.table)
        table[14] = process(11, 11, "1000", 3 * GIB, "vitest")
        pids, _, cmd = warden.choose_victim(table, {10}, own_pid=99)
        self.assertEqual((pids, cmd), ([14], "vitest"))


class EndToEndTest(unittest.TestCase):
    def test_one_check_kills_the_command_and_records_it(self):
        with tempfile.TemporaryDirectory() as directory:
            cgroup = Path(directory)
            (cgroup / "memory.max").write_text(f"{4 * GIB}\n")
            (cgroup / "memory.stat").write_text(f"anon {int(3.9 * GIB)}\nfile {GIB}\n")
            (cgroup / "memory.pressure").write_text("some avg10=0.00\nfull avg10=0.00\n")
            log = cgroup / "warden.log"
            command = subprocess.Popen(
                ["sh", "-c", "echo 1000 > /proc/self/oom_score_adj && exec sleep 30"],
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                for _ in range(50):
                    score = Path(f"/proc/{command.pid}/oom_score_adj").read_text().strip()
                    if score == "1000":
                        break
                env = dict(
                    os.environ,
                    ARCHESTRA_MEMORY_WARDEN_CGROUP=str(cgroup),
                    ARCHESTRA_MEMORY_WARDEN_LOG=str(log),
                    ARCHESTRA_MEMORY_WARDEN_AGENT_ROOT=str(os.getpid()),
                    ARCHESTRA_MEMORY_WARDEN_ONCE="1",
                )
                result = subprocess.run([sys.executable, str(WARDEN)], env=env, timeout=30)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(command.wait(timeout=10), -signal.SIGKILL)
                self.assertIn("archestra-memory-warden: stopped this command", command.stderr.read().decode())
                record = json.loads(log.read_text().splitlines()[0])
                self.assertEqual(record["reason"], "limit")
                self.assertEqual(record["pids"], [command.pid])
                self.assertEqual(record["limit_bytes"], 4 * GIB)
            finally:
                if command.poll() is None:
                    command.kill()
                command.wait()
                command.stderr.close()


if __name__ == "__main__":
    unittest.main()
