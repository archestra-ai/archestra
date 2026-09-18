"""PTY client for exercising a terminal executable at its process boundary."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time


def until(check, message, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(message)


class Viewer:
    def __init__(self, command, cols=80, rows=24):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["TERM"] = "xterm-256color"
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.execv(command[0], command)
        os.set_inheritable(self.fd, False)
        self.output = bytearray()
        self.status = None

    def drain(self, duration=0.1):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if not select.select([self.fd], [], [], 0.02)[0]:
                continue
            try:
                data = os.read(self.fd, 65536)
                if not data:
                    return
                self.output.extend(data)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise

    def expect(self, text):
        needle = text.encode()

        def received():
            self.drain()
            return needle in self.output

        until(received, f"Terminal never displayed {text!r}: {bytes(self.output)!r}")

    def send(self, text):
        os.write(self.fd, text.encode())

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def wait(self):
        def exited():
            if self.status is None:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    self.status = os.waitstatus_to_exitcode(status)
            return self.status is not None

        until(exited, "Terminal attachment did not exit")
        return self.status

    def disconnect(self):
        # Closing the client PTY models a transport disappearing, without a
        # vendor-specific detach shortcut or terminating the terminal child.
        os.close(self.fd)
        self.fd = -1
        self.wait()

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1
        if self.status is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            self.wait()
