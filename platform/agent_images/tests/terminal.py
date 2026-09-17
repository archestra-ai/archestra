"""Real Herdr/PTY contract tests; run in a disposable maintained runtime image."""

import fcntl
import json
import os
from pathlib import Path
import pty
import runpy
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import unicodedata
import unittest
import uuid

HELPER = shutil.which('archestra-terminal')
TUI_RUN = shutil.which('archestra-tui-run')
ROOT = Path('/var/run/archestra')


def until(check, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.05)
    raise AssertionError('Terminal condition did not become true')


def call(*args, input=None, check=True, env=None):
    environment = os.environ.copy()
    environment.update(env or {})
    return subprocess.run([HELPER, *args], input=input, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=check, timeout=20,
                          env=environment)


class Client:
    def __init__(self, cols=90, rows=30, wait_ready=True):
        self.pid, self.fd = pty.fork()
        self.detach_output = b''
        if self.pid == 0:
            os.execv(HELPER, [HELPER, 'attach'])
        os.set_blocking(self.fd, False)
        self.resize(cols, rows)
        if wait_ready:
            self.wait_ready()

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        # Docker's PTY master does not consistently deliver SIGWINCH to the
        # attached child process. Real host terminals deliver it from the
        # kernel; send the equivalent signal here after changing the size.
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def wait_ready(self):
        """Wait until the attach child has switched its slave PTY to raw mode."""
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                attributes = termios.tcgetattr(self.fd)
            except OSError:
                break
            if not attributes[3] & (termios.ICANON | termios.ECHO):
                return
            time.sleep(.01)
        raise AssertionError('Terminal attach did not become raw-ready')

    def read(self, seconds=.3):
        result = b''
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], .03)[0]:
                try:
                    result += os.read(self.fd, 65536)
                except OSError:
                    break
        return result

    def write(self, data):
        view = memoryview(data)
        deadline = time.monotonic() + 10
        while view:
            if time.monotonic() >= deadline:
                raise AssertionError('Terminal attach write did not drain')
            try:
                written = os.write(self.fd, view)
            except InterruptedError:
                continue
            except BlockingIOError:
                select.select([], [self.fd], [], .05)
                continue
            view = view[written:]

    def close(self):
        if self.fd is not None:
            try:
                waited, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                waited = self.pid
            if waited == self.pid:
                self.detach_output = self.read(.2)
                os.close(self.fd)
                self.fd = None
                return
            self.write(b'\x02d')
            until(lambda: os.waitpid(self.pid, os.WNOHANG)[0] != 0)
            self.detach_output = self.read(.2)
            os.close(self.fd)
            self.fd = None

    def disconnect(self):
        """Drop the transport without sending the helper's detach chord."""
        if self.fd is not None:
            # Closing a PTY master is not a reliable way to terminate an
            # attach process when it is blocked in the socket side of the
            # select loop. Kill the exact attach process, reap it, and then
            # close the master so the server observes a real socket close.
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            os.close(self.fd)
            self.fd = None


class ProtocolClient:
    """Minimal browser-side control client for explicit attach/resize events."""
    def __init__(self, cols, rows):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(str(ROOT / 'terminal' / 'control.sock'))
        self.send({'op': 'attach', 'cols': cols, 'rows': rows})

    def send(self, message):
        self.sock.sendall(json.dumps(message).encode() + b'\n')

    def resize(self, cols, rows):
        self.send({'op': 'resize', 'cols': cols, 'rows': rows})

    def close(self):
        self.sock.close()


class TerminalContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert HELPER, 'This image must include archestra-terminal'
        assert TUI_RUN, 'This image must include archestra-tui-run'
        ROOT.joinpath('turns').mkdir(parents=True, exist_ok=True)
        cls.errors = open('/tmp/terminal-test-errors', 'wb')
        cls.start_controller()

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.errors.close()

    def setUp(self):
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        call('stop', check=False)

    def start(self, program):
        prefix = ROOT / 'turns' / str(uuid.uuid4())
        prefix.with_suffix('.session').write_text('exec python3 -u -c ' + shlex.quote(program) + '\n')
        call('start', str(prefix))
        return prefix

    def client(self):
        result = Client()
        self.clients.append(result)
        return result

    def test_repeated_native_attention_uses_the_event_journal(self):
        prefix = ROOT / 'turns' / str(uuid.uuid4())
        attempt = str(uuid.uuid4())
        context = str(prefix) + '.events/context.json'
        subprocess.run(['archestra-agent-event', 'context', '--path', context,
                        '--task', prefix.name, '--attempt', attempt],
                       check=True, stdout=subprocess.DEVNULL)
        prefix.with_suffix('.session').write_text('sleep 30\n')
        call('start', str(prefix))
        environment = {**os.environ, 'HERDR_ENV': '1',
                       'ARCHESTRA_AGENT_RUNTIME_TASK_ID': prefix.name,
                       'ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID': attempt,
                       'ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX': str(prefix)}
        for args in [('set', 'Permission needed'), ('clear',), ('set', 'Permission needed')]:
            subprocess.run(['archestra-agent-attention', *args], env=environment,
                           check=True, capture_output=True, timeout=10)
        output = subprocess.check_output(['archestra-agent-event', 'read', '--task', prefix.name])
        events = [event for event in json.loads(output)['events'] if event['source'] == 'native-attention']
        self.assertEqual([event['attention'] for event in events], ['input_required', None, 'input_required'])

    def test_turn_replacement_waits_for_status_reconciliation(self):
        prefixes = [ROOT / 'turns' / str(uuid.uuid4()) for _ in range(2)]
        for prefix in prefixes:
            subprocess.run(['archestra-agent-event', 'context',
                            '--path', str(prefix) + '.events/context.json',
                            '--task', prefix.name, '--attempt', str(uuid.uuid4())],
                           check=True, stdout=subprocess.DEVNULL)
            prefix.with_suffix('.session').write_text('sleep 30\n')
        call('start', str(prefixes[0]))
        binding = ROOT / 'terminal' / 'pane-binding.json'
        with binding.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            replacement = subprocess.Popen([HELPER, 'start', str(prefixes[1])],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(.5)
            self.assertIsNone(replacement.poll())
            self.assertEqual(json.loads(binding.read_text())['taskId'], prefixes[0].name)
        _, stderr = replacement.communicate(timeout=10)
        self.assertEqual(replacement.returncode, 0, stderr)
        self.assertEqual(json.loads(binding.read_text())['taskId'], prefixes[1].name)

    def test_private_plugin_publishes_real_herdr_status_hooks(self):
        prefix = ROOT / 'turns' / str(uuid.uuid4())
        subprocess.run(['archestra-agent-event', 'context',
                        '--path', str(prefix) + '.events/context.json',
                        '--task', prefix.name, '--attempt', str(uuid.uuid4())],
                       check=True, stdout=subprocess.DEVNULL)
        prefix.with_suffix('.session').write_text('sleep 30\n')
        call('start', str(prefix))
        binding = json.loads((ROOT / 'terminal' / 'pane-binding.json').read_text())

        def events():
            output = subprocess.check_output(['archestra-agent-event', 'read', '--task', prefix.name])
            return [event for event in json.loads(output)['events'] if event['source'] == 'herdr']

        for sequence, state in enumerate(('working', 'blocked', 'idle'), 1):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(5)
                connection.connect(str(ROOT / 'terminal' / 'herdr.sock'))
                connection.sendall(json.dumps({'id': str(sequence), 'method': 'pane.report_agent',
                    'params': {'pane_id': binding['paneId'], 'source': 'custom:runtime-test',
                               'agent': 'runtime-test', 'state': state, 'seq': sequence}}).encode() + b'\n')
                response = json.loads(connection.makefile('rb').readline())
                self.assertNotIn('error', response)
            expected = ('working', None) if state == 'working' else ('idle', 'input_required' if state == 'blocked' else None)
            try:
                until(lambda: any((event['status'], event['attention']) == expected for event in events()))
            except AssertionError as error:
                raise AssertionError(f'Herdr {state} did not reach the journal: {events()}; response: {response}') from error

    @staticmethod
    def run_tui(args, environment, tty_mode=False):
        command = [TUI_RUN, *args]
        if not tty_mode:
            return subprocess.run(command, env=environment, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=20)
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(TUI_RUN, command, environment)
        output = bytearray()
        status = None
        deadline = time.monotonic() + 20
        try:
            while True:
                waited, observed = os.waitpid(pid, os.WNOHANG)
                if waited == pid:
                    status = observed
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('TUI wrapper did not exit')
                if select.select([fd], [], [], .05)[0]:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        pass
                    else:
                        if data:
                            output.extend(data)
            while select.select([fd], [], [], .1)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
        except BaseException:
            if status is None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            raise
        finally:
            os.close(fd)
        return subprocess.CompletedProcess(command, os.waitstatus_to_exitcode(status),
                                           bytes(output), b'')

    @staticmethod
    def process_alive(pid):
        try:
            fields = Path('/proc') / str(pid) / 'stat'
            return fields.read_text().rsplit(')', 1)[1].split()[0] != 'Z'
        except (FileNotFoundError, ProcessLookupError):
            return False

    @classmethod
    def start_controller(cls, env=None):
        environment = os.environ.copy()
        environment.update(env or {})
        cls.server = subprocess.Popen([HELPER, 'serve'], stdout=cls.errors,
                                      stderr=cls.errors, env=environment)
        until(lambda: call('ready', check=False).returncode == 0, seconds=15)

    @classmethod
    def restart_controller(cls, env=None):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.start_controller(env)

    @staticmethod
    def herdr_server_pid():
        result = subprocess.run(['pgrep', '-f', '^herdr server$'], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, check=False, text=True)
        pids = [int(line) for line in result.stdout.split()]
        if len(pids) != 1:
            raise AssertionError(f'Expected one Herdr server, found {pids}')
        return pids[0]

    def test_original_output_is_complete_without_viewers(self):
        prefix = self.start("""
import os,time
for i in range(6000):
    os.write(1 if i%2 else 2, ('record-%05d ☃\\r'%i).encode())
os.write(1,b'\\x1b[2J\\x1b[HEND\\n')
time.sleep(1)
""")
        log = prefix.with_suffix('.log')
        until(lambda: log.exists() and b'END\r\n' in log.read_bytes())
        expected = b''.join(('record-%05d ☃\r' % i).encode() for i in range(6000))
        self.assertEqual(log.read_bytes(), expected + b'\x1b[2J\x1b[HEND\r\n')

    def test_herdr_update_checks_are_disabled(self):
        config = ROOT / 'terminal' / 'config.toml'
        contents = config.read_text()
        self.assertIn('[update]', contents)
        self.assertIn('version_check = false', contents)
        self.assertIn('manifest_check = false', contents)

    def test_shared_attachment_resize_retention_and_attention(self):
        child = Path('/tmp/terminal-contract-child')
        child.unlink(missing_ok=True)
        prefix = self.start("""
import os,signal,sys
from pathlib import Path
Path('/tmp/terminal-contract-child').write_text(str(os.getpid()))
def size(*_):
    s=os.get_terminal_size(); print('SIZE',s.columns,s.lines,flush=True)
signal.signal(signal.SIGWINCH,size)
print('INTERACTIVE READY',flush=True)
while True:
    command=input()
    print('INPUT',command,flush=True)
    if command == 'size': size()
""")
        until(child.exists)
        pid = child.read_text()
        first = self.client()
        self.assertIn(b'INTERACTIVE READY', first.read(2))
        second = self.client()
        self.assertIn(b'INTERACTIVE READY', second.read(2))
        call('retain', prefix.name)
        self.assertEqual(call('retained').stdout.strip(), ('0:' + prefix.name).encode())
        identity = {
            'ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX': str(prefix),
            'ARCHESTRA_AGENT_RUNTIME_TASK_ID': prefix.name,
        }
        frame = call('capture', env=identity).stdout
        self.assertTrue(frame.startswith(b'\x1b]777;archestra-terminal-size='))
        # The controller uses the smallest attached geometry. Resize both
        # clients before asserting the new common size.
        second.resize(103, 35)
        first.resize(103, 35)
        first.write(b'size\r')
        until(lambda: b'SIZE 103 34' in prefix.with_suffix('.log').read_bytes())
        call('attention', 'set', 'Approval required', env=identity)
        self.assertIn(b'Approval required', first.read(.5))
        self.assertIn(b'Approval required', second.read(.5))
        first.close()
        self.assertIn(b'\x1b[?7h', first.detach_output)
        self.assertIn(b'\x1b[?1015l', first.detach_output)
        second.write(b'after-detach\r')
        until(lambda: b'INPUT after-detach' in prefix.with_suffix('.log').read_bytes())
        self.assertEqual(child.read_text(), pid)
        self.assertEqual(call('alive').returncode, 0)

        owner = subprocess.check_output(['pgrep', '-f', '^herdr terminal attach ']).strip()
        # A stopped owner cannot acknowledge SIGTERM.  Recovery must still
        # force-kill and reap it before making the replacement attachment.
        os.kill(int(owner), signal.SIGSTOP)
        third = self.client()
        self.assertIn(b'INTERACTIVE READY', third.read(2))
        second.write(b'after-owner-recovery\r')
        until(lambda: b'INPUT after-owner-recovery' in prefix.with_suffix('.log').read_bytes())
        self.assertEqual(child.read_text(), pid)

    def test_attention_footer_fits_wide_and_combining_labels(self):
        """Attention labels are clipped by terminal cells, not Python chars."""
        runtime = runpy.run_path(HELPER)['Runtime']()
        runtime.size = (3, 4)
        for label in ('界界界', '界\u0301界'):
            runtime.attention = {'active': True, 'label': label}
            footer = runtime.footer()
            styled_label = footer.split(b'\x1b[33;1m', 1)[1].split(b'\x1b[0m', 1)[0]
            rendered = styled_label.decode('utf-8')
            width = sum(
                0 if unicodedata.combining(char) else
                2 if unicodedata.east_asian_width(char) in 'WFA' else 1
                for char in rendered
            )
            self.assertLessEqual(width, runtime.size[0], label)

    def test_per_turn_operations_reject_stale_identity(self):
        prefix = self.start("import time; print('IDENTITY READY', flush=True); time.sleep(30)")
        until(lambda: b'IDENTITY READY' in prefix.with_suffix('.log').read_bytes())
        for args, input_data in (
            (('capture', '--task=stale-task'), None),
            (('steer', '--task=stale-task'), b'ignored'),
            (('attention', 'get', '--task=stale-task'), None),
            (('attention', 'set', 'stale reason', '--task=stale-task'), None),
        ):
            result = call(*args, input=input_data, check=False)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn(b'stale', result.stderr.lower(), args)
        oversized = call(
            'steer', input=b'x' * (512 * 1024 + 1), check=False,
            env={'ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX': str(prefix),
                 'ARCHESTRA_AGENT_RUNTIME_TASK_ID': prefix.name},
        )
        self.assertNotEqual(oversized.returncode, 0)
        self.assertIn(b'exceeds 512 kib', oversized.stderr.lower())

    def test_z1_kill_recorder_stops_controller_before_next_turn(self):
        marker = Path('/tmp/terminal-kill-recorder-next')
        marker.unlink(missing_ok=True)
        prefix = self.start("""
import signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print('RECORDER VICTIM',flush=True)
while True: time.sleep(1)
        """)
        child_state = ROOT / 'terminal' / 'child.json'
        until(lambda: child_state.exists() and json.loads(child_state.read_text()).get('recorder'))
        state = json.loads(child_state.read_text())
        child_pid = state['child']['pid']
        recorder_pid = state['recorder']['pid']
        controller_pid = self.server.pid
        # Hold the controller while the recorder dies so the monitor observes
        # a missing recorder without a completion record, deterministically.
        os.kill(controller_pid, signal.SIGSTOP)
        try:
            os.kill(recorder_pid, signal.SIGKILL)
            until(lambda: not self.process_alive(recorder_pid))
            time.sleep(.5)
        finally:
            os.kill(controller_pid, signal.SIGCONT)
        until(lambda: self.server.poll() is not None)
        until(lambda: not self.process_alive(child_pid))
        self.server.wait(timeout=5)
        self.start_controller()

        next_prefix = self.start("""
from pathlib import Path
import time
Path('/tmp/terminal-kill-recorder-next').write_text('next')
print('NEXT AFTER RECORDER',flush=True)
time.sleep(1)
""")
        until(lambda: b'NEXT AFTER RECORDER' in next_prefix.with_suffix('.log').read_bytes())
        self.assertEqual(marker.read_text(), 'next')

    def test_z2_kill_herdr_server_fails_old_turn_and_recovers(self):
        marker = Path('/tmp/terminal-kill-herdr-server')
        marker.unlink(missing_ok=True)
        prefix = self.start("""
from pathlib import Path
import signal,time
Path('/tmp/terminal-kill-herdr-server').write_text('old\\n')
signal.signal(signal.SIGTERM,signal.SIG_IGN)
while True: time.sleep(1)
""")
        child_state = ROOT / 'terminal' / 'child.json'
        until(lambda: child_state.exists() and json.loads(child_state.read_text()).get('recorder'))
        state = json.loads(child_state.read_text())
        identities = (state['child'], state['recorder'])
        os.kill(self.herdr_server_pid(), signal.SIGKILL)
        until(lambda: self.server.poll() is not None)
        until(lambda: all(not self.process_alive(identity['pid']) for identity in identities))
        self.start_controller()
        time.sleep(.5)
        self.assertEqual(marker.read_text(), 'old\n')

        next_prefix = self.start("""
from pathlib import Path
import time
with Path('/tmp/terminal-kill-herdr-server').open('a') as output:
    output.write('new\\n')
print('NEXT AFTER SERVER',flush=True)
time.sleep(1)
""")
        until(lambda: b'NEXT AFTER SERVER' in next_prefix.with_suffix('.log').read_bytes())
        self.assertEqual(marker.read_text(), 'old\nnew\n')

    def test_z3_kill_controller_never_replays_after_replacement(self):
        marker = Path('/tmp/terminal-kill-controller')
        marker.unlink(missing_ok=True)
        prefix = self.start("""
from pathlib import Path
import signal,time
Path('/tmp/terminal-kill-controller').write_text('old\\n')
signal.signal(signal.SIGTERM,signal.SIG_IGN)
while True: time.sleep(1)
        """)
        child_state = ROOT / 'terminal' / 'child.json'
        until(lambda: child_state.exists() and json.loads(child_state.read_text()).get('recorder'))
        until(lambda: marker.exists() and marker.read_text() == 'old\n')
        state = json.loads(child_state.read_text())
        identities = (state['child'], state['recorder'])
        controller_pid = self.server.pid
        herdr_pid = self.herdr_server_pid()
        os.kill(controller_pid, signal.SIGKILL)
        self.server.wait(timeout=5)
        # PID 1 owns teardown in the integrated runtime. Killing the native
        # server here emulates that container teardown before replacement.
        os.kill(herdr_pid, signal.SIGKILL)
        until(lambda: all(not self.process_alive(identity['pid']) for identity in identities))
        self.start_controller()
        time.sleep(.5)
        self.assertEqual(marker.read_text(), 'old\n')

        next_prefix = self.start("""
from pathlib import Path
import time
with Path('/tmp/terminal-kill-controller').open('a') as output:
    output.write('new\\n')
print('NEXT AFTER CONTROLLER',flush=True)
time.sleep(1)
""")
        until(lambda: b'NEXT AFTER CONTROLLER' in next_prefix.with_suffix('.log').read_bytes())
        self.assertEqual(marker.read_text(), 'old\nnew\n')

    def test_z4_immediate_stop_and_start_preserves_new_child_identity(self):
        prefix = self.start("""
import signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print('OLD RACE TURN',flush=True)
while True: time.sleep(1)
""")
        old_state = ROOT / 'terminal' / 'child.json'
        until(lambda: old_state.exists() and json.loads(old_state.read_text()).get('recorder'))
        next_prefix = ROOT / 'turns' / str(uuid.uuid4())
        next_prefix.with_suffix('.session').write_text(
            'exec python3 -u -c ' + shlex.quote("""
from pathlib import Path
import time
Path('/tmp/terminal-stop-start-race').write_text('new')
print('NEW RACE TURN',flush=True)
time.sleep(1)
""") + '\n')
        stopper = subprocess.Popen([HELPER, 'stop'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        until(lambda: not (ROOT / 'terminal' / 'launch.json').exists())
        starter = subprocess.Popen([HELPER, 'start', str(next_prefix)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, stop_error = stopper.communicate(timeout=10)
        _, start_error = starter.communicate(timeout=10)
        self.assertEqual(stopper.returncode, 0, stop_error)
        self.assertEqual(starter.returncode, 0, start_error)
        until(lambda: b'NEW RACE TURN' in next_prefix.with_suffix('.log').read_bytes())
        time.sleep(.3)
        state = json.loads((ROOT / 'terminal' / 'child.json').read_text())
        self.assertEqual(state['prefix'], str(next_prefix))
        self.assertTrue(self.process_alive(state['child']['pid']))
        self.assertEqual(Path('/tmp/terminal-stop-start-race').read_text(), 'new')

    def test_z5_stop_waits_for_delayed_prespawn_before_replacing_turn(self):
        root = Path('/tmp/terminal-prespawn-race')
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(mode=0o700)
        fake_bin = root / 'bin'
        fake_bin.mkdir()
        stty = fake_bin / 'stty'
        stty.write_text("""#!/bin/sh
touch /tmp/terminal-prespawn-race/entered
while [ ! -f /tmp/terminal-prespawn-race/release ]; do sleep .02; done
""")
        stty.chmod(0o700)
        self.restart_controller({'PATH': str(fake_bin) + ':' + os.environ['PATH']})
        try:
            old_prefix = ROOT / 'turns' / str(uuid.uuid4())
            old_prefix.with_suffix('.session').write_text(
                'exec python3 -u -c ' + shlex.quote("""
from pathlib import Path
Path('/tmp/terminal-prespawn-race/old').write_text('old')
import signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
time.sleep(1)
Path('/tmp/terminal-prespawn-race/old-late').write_text('late')
while True: time.sleep(1)
""") + '\n')
            starter = subprocess.Popen([HELPER, 'start', str(old_prefix)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            until(lambda: (root / 'entered').exists())
            stopper = subprocess.Popen([HELPER, 'stop'], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE)
            time.sleep(.15)
            self.assertIsNone(stopper.poll(), 'stop returned before spawn lock released')
            (root / 'release').touch()
            _, start_error = starter.communicate(timeout=20)
            _, stop_error = stopper.communicate(timeout=20)
            self.assertEqual(starter.returncode, 0, start_error)
            self.assertEqual(stopper.returncode, 0, stop_error)
            # The old command may have reached its first side effect before
            # stop acquired the launch lock. What must not survive is the
            # delayed side effect that proves the old process remained alive.
            time.sleep(1.2)
            self.assertFalse((root / 'old-late').exists())

            next_prefix = self.start("""
from pathlib import Path
Path('/tmp/terminal-prespawn-race/new').write_text('new')
print('NEW AFTER PRESPAWN', flush=True)
import time; time.sleep(1)
""")
            until(lambda: b'NEW AFTER PRESPAWN' in next_prefix.with_suffix('.log').read_bytes())
            state = json.loads((ROOT / 'terminal' / 'child.json').read_text())
            self.assertEqual(state['prefix'], str(next_prefix))
        finally:
            (root / 'release').touch()
            self.restart_controller()
            shutil.rmtree(root, ignore_errors=True)

    def test_z6_delayed_recorder_metadata_fails_closed_then_next_turn_works(self):
        root = Path('/tmp/terminal-delayed-metadata')
        shutil.rmtree(root, ignore_errors=True)
        fake_bin = root / 'bin'
        fake_bin.mkdir(parents=True, mode=0o700)
        python = fake_bin / 'python3'
        python.write_text("""#!/bin/sh
if [ "$(basename -- "$1")" = archestra-pty-record ] && [ ! -e /tmp/terminal-delayed-metadata/seen ]; then
  touch /tmp/terminal-delayed-metadata/seen
  sleep 6
fi
exec /usr/bin/python3 "$@"
""")
        python.chmod(0o700)
        self.restart_controller({'PATH': str(fake_bin) + ':' + os.environ['PATH']})
        try:
            failed_prefix = ROOT / 'turns' / str(uuid.uuid4())
            failed_prefix.with_suffix('.session').write_text(
                'exec python3 -u -c ' + shlex.quote("print('NEVER STARTED')") + '\n')
            result = call('start', str(failed_prefix), check=False)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse((ROOT / 'terminal' / 'launch.json').exists())
            self.assertFalse((ROOT / 'terminal' / 'child.json').exists())

            next_prefix = self.start("""
from pathlib import Path
Path('/tmp/terminal-delayed-metadata/next').write_text('next')
print('NEXT AFTER METADATA', flush=True)
import time; time.sleep(1)
""")
            until(lambda: b'NEXT AFTER METADATA' in next_prefix.with_suffix('.log').read_bytes())
        finally:
            self.restart_controller()
            shutil.rmtree(root, ignore_errors=True)

    def test_runtime_child_inherits_locale_overrides(self):
        self.restart_controller({'TERM': 'screen-256color', 'LANG': 'fr_FR.UTF-8',
                                 'LC_ALL': 'C'})
        try:
            prefix = self.start("""
import os
from pathlib import Path
Path('/tmp/terminal-runtime-locale').write_text('|'.join(os.environ.get(name, '') for name in ('TERM','LANG','LC_ALL')))
print('LOCALE READY', flush=True)
import time; time.sleep(1)
""")
            until(lambda: b'LOCALE READY' in prefix.with_suffix('.log').read_bytes())
            self.assertEqual(Path('/tmp/terminal-runtime-locale').read_text(),
                             'screen-256color|fr_FR.UTF-8|C')
        finally:
            self.restart_controller()

    def test_shared_clients_use_smallest_geometry_and_reexpand_on_detach(self):
        prefix = self.start("""
import signal,time
def size(*_):
    s=os.get_terminal_size(); print('COMMON SIZE',s.columns,s.lines,flush=True)
import os
signal.signal(signal.SIGWINCH,size)
print('GEOMETRY READY',flush=True)
while True: time.sleep(1)
        """)
        until(lambda: b'GEOMETRY READY' in prefix.with_suffix('.log').read_bytes())
        first = ProtocolClient(120, 40)
        second = ProtocolClient(70, 22)
        self.clients.extend((first, second))
        until(lambda: b'COMMON SIZE 70 21' in prefix.with_suffix('.log').read_bytes())
        identity = {'ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX': str(prefix),
                    'ARCHESTRA_AGENT_RUNTIME_TASK_ID': prefix.name}
        frame = call('capture', env=identity).stdout
        self.assertIn(b'archestra-terminal-size=70x21', frame)
        second.close()
        until(lambda: b'COMMON SIZE 120 39' in prefix.with_suffix('.log').read_bytes())
        frame = call('capture', env=identity).stdout
        self.assertIn(b'archestra-terminal-size=120x39', frame)
        self.assertFalse(first.sock._closed)

    def test_large_paste_is_streamed_and_atomic_between_clients(self):
        received = Path('/tmp/terminal-large-paste-received')
        second_received = Path('/tmp/terminal-large-paste-second')
        received.unlink(missing_ok=True)
        second_received.unlink(missing_ok=True)
        # Keep a UTF-8 glyph split across the two writes while taking this
        # transaction beyond one MiB; the controller must stream bytes without
        # decoding or imposing the native pane's single-message limit.
        split = 16384
        paste_body = b'P' * (split - 2) + '☃'.encode() + b'P' * (1024 * 1024)
        paste_start = b'\x1b[200~'
        paste_end = b'\x1b[201~'
        expected_size = len(paste_start) + len(paste_body) + len(paste_end)
        prefix = self.start(f"""
import os,time,tty
from pathlib import Path
tty.setraw(0)
print('LARGE PASTE READY', flush=True)
expected = {expected_size + 1}
buffer = bytearray()
while len(buffer) < expected:
    chunk = os.read(0, 65536)
    if not chunk:
        raise SystemExit('stdin closed during paste')
    buffer.extend(chunk)
Path('/tmp/terminal-large-paste-received').write_bytes(buffer[:{expected_size}])
Path('/tmp/terminal-large-paste-second').write_bytes(buffer[{expected_size}:{expected_size + 1}])
print('LARGE PASTE COMPLETE', flush=True)
time.sleep(1)
""")
        first = self.client()
        second = self.client()
        until(lambda: b'LARGE PASTE READY' in prefix.with_suffix('.log').read_bytes())
        # The first client holds the controller input lock from the bracketed
        # paste start until its end. The second byte must arrive afterward.
        first.write(paste_start + paste_body[:split])
        time.sleep(.1)
        # A browser resize from the waiting client must not hold the runtime
        # lock behind the paste transaction; otherwise the owner cannot send
        # its end event and both requests deadlock.
        second.resize(70, 22)
        second.write(b'Q')
        first.write(paste_body[split:] + paste_end)
        until(received.exists, seconds=20)
        until(second_received.exists, seconds=20)
        self.assertEqual(received.read_bytes(), paste_start + paste_body + paste_end)
        self.assertEqual(second_received.read_bytes(), b'Q')
        until(lambda: b'LARGE PASTE COMPLETE' in prefix.with_suffix('.log').read_bytes())

    def test_paste_disconnect_sends_bounded_end_marker(self):
        received = Path('/tmp/terminal-paste-disconnect')
        received.unlink(missing_ok=True)
        paste_start = b'\x1b[200~'
        paste_body = b'partial-paste'
        paste_end = b'\x1b[201~'
        expected = paste_start + paste_body + paste_end + b'Q'
        prefix = self.start(f"""
import os,time,tty
from pathlib import Path
tty.setraw(0)
print('PASTE DISCONNECT READY', flush=True)
buffer = bytearray()
while len(buffer) < {len(expected)}:
    chunk = os.read(0, 4096)
    if not chunk:
        raise SystemExit('stdin closed during disconnect paste')
    buffer.extend(chunk)
Path('/tmp/terminal-paste-disconnect').write_bytes(buffer[:{len(expected)}])
print('PASTE DISCONNECT COMPLETE', flush=True)
time.sleep(1)
""")
        first = self.client()
        second = self.client()
        until(lambda: b'PASTE DISCONNECT READY' in prefix.with_suffix('.log').read_bytes())
        first.write(paste_start + paste_body)
        time.sleep(.2)
        first.disconnect()
        second.write(b'Q')
        until(received.exists)
        self.assertEqual(received.read_bytes(), expected)
        until(lambda: b'PASTE DISCONNECT COMPLETE' in prefix.with_suffix('.log').read_bytes())

    def test_stop_releases_inflight_paste_before_queued_attach(self):
        """Stopping a paste owner unblocks a queued attachment cleanly."""
        old_received = Path('/tmp/terminal-paste-stop-old')
        next_received = Path('/tmp/terminal-paste-stop-next')
        old_received.unlink(missing_ok=True)
        next_received.unlink(missing_ok=True)
        paste_start = b'\x1b[200~'
        old_prefix = self.start(f"""
import os,time,tty
from pathlib import Path
tty.setraw(0)
print('PASTE STOP OLD READY', flush=True)
payload = os.read(0, {len(paste_start)})
Path('/tmp/terminal-paste-stop-old').write_bytes(payload)
time.sleep(30)
""")
        first = self.client()
        until(lambda: b'PASTE STOP OLD READY' in old_prefix.with_suffix('.log').read_bytes())
        first.write(paste_start)
        until(old_received.exists)
        self.assertEqual(old_received.read_bytes(), paste_start)

        # The second attachment is deliberately queued behind the active
        # paste transaction before stop starts. Its initial frame proves that
        # the queued connection resumed after the owner was aborted.
        queued = Client(wait_ready=False)
        self.clients.append(queued)
        # The attach process has sent its handshake and is now waiting on the
        # paste lock. This makes the queued-attachment ordering observable
        # before stop is issued.
        queued.wait_ready()
        stopped = call('stop', check=False)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        first.disconnect()
        baseline = queued.read(.5)
        self.assertTrue(baseline, 'queued attachment did not resume after stop')

        next_prefix = self.start("""
import os,time,tty
from pathlib import Path
tty.setraw(0)
print('PASTE STOP NEXT READY', flush=True)
payload = os.read(0, 1)
Path('/tmp/terminal-paste-stop-next').write_bytes(payload)
print('PASTE STOP NEXT COMPLETE', flush=True)
time.sleep(1)
""")
        until(lambda: b'PASTE STOP NEXT READY' in next_prefix.with_suffix('.log').read_bytes())
        queued.write(b'Q')
        until(next_received.exists)
        self.assertEqual(next_received.read_bytes(), b'Q')
        until(lambda: b'PASTE STOP NEXT COMPLETE' in next_prefix.with_suffix('.log').read_bytes())

    def test_tui_wrappers_propagate_capture_and_retain_failures(self):
        root = Path('/tmp/terminal-wrapper-contract')
        shutil.rmtree(root, ignore_errors=True)
        fake_bin = root / 'bin'
        fake_bin.mkdir(parents=True, mode=0o700)
        fake_helper = fake_bin / 'archestra-terminal'

        def run_case(capture_status=0, retain_status=0, tty_mode=False):
            fake_helper.write_text(f"""#!/bin/sh
case "$1" in
  capture) printf 'captured-frame\\n'; exit {capture_status} ;;
  retain) exit {retain_status} ;;
  *) exit 0 ;;
esac
""")
            fake_helper.chmod(0o700)
            case = root / f"case-{capture_status}-{retain_status}-{'tty' if tty_mode else 'pipe'}"
            done = case.with_suffix('.done')
            answer = case.with_suffix('.answer')
            prefix = case.with_suffix('.turn')
            command = [sys.executable, '-c',
                       'from pathlib import Path; import time; '
                       f'Path({str(done)!r}).touch(); Path({str(answer)!r}).write_text(\'answer\'); time.sleep(3)']
            environment = os.environ.copy()
            environment.update({'PATH': str(fake_bin) + ':' + os.environ['PATH'],
                                'HERDR_ENV': '1',
                                'ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX': str(prefix)})
            return self.run_tui([str(done), str(answer), *command], environment, tty_mode)

        try:
            normal_tty = run_case(tty_mode=True)
            self.assertEqual(normal_tty.returncode, 0, normal_tty.stderr)
            self.assertIn(b'answer', normal_tty.stdout)

            capture_tty = run_case(capture_status=1, tty_mode=True)
            self.assertEqual(capture_tty.returncode, 1, capture_tty.stderr)

            retain_tty = run_case(retain_status=1, tty_mode=True)
            self.assertEqual(retain_tty.returncode, 1, retain_tty.stderr)

            normal_pipe = run_case()
            self.assertEqual(normal_pipe.returncode, 0, normal_pipe.stderr)
            self.assertIn(b'answer', normal_pipe.stdout)

            capture_pipe = run_case(capture_status=1)
            self.assertEqual(capture_pipe.returncode, 1, capture_pipe.stderr)
            self.assertIn(b'capture failed', capture_pipe.stderr.lower())

            early_marker = root / 'early-exit.done'
            early_answer = root / 'early-exit.answer'
            early_environment = os.environ.copy()
            early_environment.update({'PATH': str(fake_bin) + ':' + os.environ['PATH'],
                                      'HERDR_ENV': '1'})
            early = self.run_tui(
                [str(early_marker), str(early_answer), sys.executable, '-c',
                 'import sys; sys.exit(42)'],
                early_environment,
            )
            self.assertEqual(early.returncode, 42, early.stderr)
            self.assertFalse(early_marker.exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_cancel_removes_resistant_and_detached_descendants(self):
        marker = Path('/tmp/terminal-contract-descendants')
        marker.unlink(missing_ok=True)
        self.start("""
import os,signal,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child=os.fork()
if child==0:
    os.setsid()
    while True: time.sleep(1)
Path('/tmp/terminal-contract-descendants').write_text(str(os.getpid())+' '+str(child))
while True: time.sleep(1)
""")
        until(marker.exists)
        pids = marker.read_text().split()
        call('stop')
        def gone(pid):
            try:
                path = Path('/proc') / pid / 'stat'
                return not path.exists()
            except (FileNotFoundError, ProcessLookupError):
                return True
        until(lambda: all(gone(pid) for pid in pids))
        self.assertEqual(call('alive', check=False).returncode, 1)
        prefix = self.start("print('AFTER CANCEL')")
        until(lambda: prefix.with_suffix('.log').exists() and b'AFTER CANCEL' in prefix.with_suffix('.log').read_bytes())

    def test_paste_parser_handles_every_split_and_literal_detach_keys(self):
        parser_class = runpy.run_path(HELPER)['TerminalInput']
        message = b'before\x1b[200~literal\x02d\xe2\x98\x83\x1b[201~after'
        for offset in range(len(message) + 1):
            parser = parser_class()
            first, detached_first, _, _ = parser.feed(message[:offset])
            second, detached_second, _, _ = parser.feed(message[offset:])
            self.assertFalse(detached_first or detached_second)
            self.assertEqual(first + second, message)
        parser = parser_class()
        self.assertEqual(parser.feed(b'\x02'), (b'', False, False, False))
        self.assertEqual(parser.feed(b'd'), (b'', True, False, False))


if __name__ == '__main__':
    unittest.main()
