"""Real terminal submission test; model requests terminate at a local HTTP stub."""
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

requests = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"End of terminal input test","type":"invalid_request_error"}}')
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ['HOME'] = '/tmp/steering-home'
os.environ['CODEX_HOME'] = '/tmp/steering-home/.codex'
os.environ['TERM'] = 'xterm-256color'
os.environ['OPENAI_API_KEY'] = 'local-test-key'
Path(os.environ['CODEX_HOME']).mkdir(parents=True)
Path(os.environ['CODEX_HOME'], 'config.toml').write_text('''
model = "test-model"
model_provider = "local"
[projects."/tmp/workspace"]
trust_level = "trusted"
[model_providers.local]
name = "local"
base_url = "http://127.0.0.1:8765/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
''')
Path('/tmp/workspace').mkdir()
subprocess.run(['git', 'init', '-q', '/tmp/workspace'], check=True)
subprocess.run(['tmux', 'new-session', '-d', '-s', 'agent', '-x', '160', '-y', '50', '-c', '/tmp/workspace', 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen'], check=True)
def pane():
    return subprocess.check_output(['tmux', 'capture-pane', '-p', '-t', 'agent'], text=True)
def until(check, description):
    for _ in range(200):
        if check(): return
        time.sleep(.1)
    raise AssertionError(description + '\n' + pane())
# The composer footer appears once the native TUI is ready for input.
until(lambda: 'context left' in pane() or 'test-model' in pane(), 'CLI did not become ready')
time.sleep(1)
for index in range(3):
    previous = len(requests)
    subprocess.run(['/bin/sh', '-c', os.environ['TEST_STEER_COMMAND']], check=True)
    until(lambda: len(requests) > previous, 'Text remained an unsubmitted draft')
    text = json.dumps(requests[-1], ensure_ascii=False)
    assert os.environ['TEST_MESSAGE'] in ''.join(
        part.get('text', '') for item in requests[-1]['input']
        if item.get('role') == 'user' for part in item.get('content', [])
    ), text
    assert not Path('/tmp/injected').exists(), 'Literal input executed as shell code'
    time.sleep(1)
print('PASS: 3 native Codex submissions, literal shell characters and Unicode preserved')
