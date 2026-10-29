/** Bounded, data-only refresh. Never executes instruction text or rewrites user rules. */
export const MANAGED_INSTRUCTIONS_REFRESH = `import json
import os
import signal
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

source_path = Path(sys.argv[1])
prompt_path = Path(sys.argv[2])
copilot_path = Path(sys.argv[3]) if len(sys.argv) > 3 else None

def replace_text(path, text):
    if text is None or not text.strip():
        path.unlink(missing_ok=True)
        return
    if path.exists() and path.read_text(encoding='utf-8') == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.managed-instructions-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def timeout(signum, frame):
    raise TimeoutError('Instruction refresh timed out')

signal.signal(signal.SIGALRM, timeout)
signal.alarm(3)
try:
    source = json.loads(source_path.read_text(encoding='utf-8'))
    request = urllib.request.Request(source['url'], headers={
        'Authorization': 'Bearer ' + source['token'],
        'Accept': 'application/json',
    })
    # A timeout keeps launch available when the platform cannot be reached.
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 200:
            sys.exit(0)
        raw = response.read(131073)
        if len(raw) > 131072:
            sys.exit(0)
        data = json.loads(raw)
        if not isinstance(data, dict) or 'instructions' not in data:
            sys.exit(0)
        text = data['instructions']
        if text is not None and (not isinstance(text, str) or len(text) > 20000):
            sys.exit(0)
    replace_text(prompt_path, text)
    if copilot_path is not None:
        replace_text(copilot_path, text)
except urllib.error.HTTPError as error:
    # Removed membership/connection must not keep injecting cached instructions.
    if error.code in (401, 403):
        prompt_path.unlink(missing_ok=True)
        if copilot_path is not None:
            copilot_path.unlink(missing_ok=True)
except Exception:
    # Keep the last valid copy on network errors or malformed responses.
    pass
finally:
    signal.alarm(0)
`;
