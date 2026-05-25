import asyncio
import json
import logging
import os
import resource
import signal
import sys
import traceback

logger = logging.getLogger(__name__)

timeout_seconds = int(sys.argv[1])
max_output_bytes = int(sys.argv[2])
cpu_seconds = int(sys.argv[3])
memory_bytes = int(sys.argv[4])
max_processes = int(sys.argv[5])
result_file = sys.argv[6]
workdir = sys.argv[7]
venv_python = sys.argv[8]
script_file = sys.argv[9]

# grace period to drain stdout/stderr after the process exits; bounds the wait
# so a grandchild that escaped the process group cannot hold the pipes open.
output_drain_grace_seconds = 5


def write_text(path, value):
    with open(path, "w", encoding="utf-8") as file:
        file.write(value)


def finalize(stdout_data, stderr_data, exit_code, truncated, timed_out):
    stdout_text = stdout_data.decode("utf-8", errors="replace")
    stderr_text = stderr_data.decode("utf-8", errors="replace")
    if truncated["stdout"]:
        stdout_text += "\n...[output truncated]"
    if truncated["stderr"]:
        stderr_text += "\n...[output truncated]"

    write_text(
        result_file,
        json.dumps(
            {
                "stdout": stdout_text,
                "stderr": stderr_text,
                "exitCode": exit_code,
                "truncated": truncated["stdout"] or truncated["stderr"],
                "timedOut": timed_out,
            },
            ensure_ascii=False,
        ),
    )


def append_output(buffer, truncated, stream_name, chunk):
    remaining = max_output_bytes - len(buffer)
    if remaining > 0:
        buffer.extend(chunk[:remaining])
    if len(chunk) > remaining:
        truncated[stream_name] = True


async def read_stream(stream, buffer, truncated, stream_name):
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            return
        append_output(buffer, truncated, stream_name, chunk)


def normalize_exit_code(return_code):
    if return_code < 0:
        return 128 + abs(return_code)
    return return_code


def apply_limits():
    os.setsid()
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))
    except AttributeError:
        logger.exception("RLIMIT_NPROC is unavailable; process limit not applied")
    except ValueError:
        logger.exception("RLIMIT_NPROC limit is invalid; process limit not applied")
    except OSError:
        logger.exception("failed to apply RLIMIT_NPROC; process limit not applied")


async def run():
    # packages are installed into the venv beforehand (outside this process), so
    # RLIMIT_CPU here applies only to the user script, not to dependency installs.
    command = [venv_python, script_file]
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=workdir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        preexec_fn=apply_limits,
    )
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("failed to capture subprocess output")

    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    truncated = {"stdout": False, "stderr": False}
    stdout_task = asyncio.create_task(
        read_stream(process.stdout, stdout_buffer, truncated, "stdout")
    )
    stderr_task = asyncio.create_task(
        read_stream(process.stderr, stderr_buffer, truncated, "stderr")
    )

    try:
        return_code = await asyncio.wait_for(process.wait(), timeout_seconds)
        timed_out = False
    except asyncio.TimeoutError:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            await process.wait()
        except ProcessLookupError:
            pass
        return_code = 124

    try:
        await asyncio.wait_for(
            asyncio.gather(stdout_task, stderr_task),
            timeout=output_drain_grace_seconds,
        )
    except asyncio.TimeoutError:
        for task in (stdout_task, stderr_task):
            task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    if not timed_out:
        return_code = normalize_exit_code(return_code)
    finalize(stdout_buffer, stderr_buffer, return_code, truncated, timed_out)


try:
    asyncio.run(run())
except BaseException:
    no_truncation = {"stdout": False, "stderr": False}
    finalize(
        b"",
        traceback.format_exc().encode("utf-8", errors="replace"),
        127,
        no_truncation,
        False,
    )
