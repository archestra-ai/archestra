#!/usr/bin/env python3
"""Test MCP server over stdio: creates and reads files under one root folder.

Usage: files_mcp_server.py <root> [--pid-file <path>] [--log-to-stderr]

Line-delimited JSON-RPC on stdin and stdout. Python standard library only.
Tools: write_file, read_file, list_files. A path outside the root is refused
with a tool result that has `isError: true`.

The options are for the tests of the tunnel client:
- `--pid-file`: the server writes its process id there, so that a test can
  kill it and can see a new process.
- `--log-to-stderr`: the server writes a line to stderr when it starts and
  for each request.
"""

import json
import os
import sys

PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "write_file",
        "description": "Write a text file under the root. Parent folders are created.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file under the root.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": "List the files under the root, as sorted relative paths.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class ToolError(Exception):
    pass


def resolve(root, path):
    """The real path of `path` under `root`. Refuses a path outside the root."""
    if not isinstance(path, str) or not path:
        raise ToolError("path must be a string that is not empty")
    real_root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(real_root, path))
    if target != real_root and not target.startswith(real_root + os.sep):
        raise ToolError(f"path is outside the root: {path}")
    return target


def call_tool(root, name, arguments):
    if name == "write_file":
        target = resolve(root, arguments.get("path"))
        content = arguments.get("content")
        if not isinstance(content, str):
            raise ToolError("content must be a string")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as file:
            file.write(content)
        return f"wrote {len(content)} characters to {arguments['path']}"
    if name == "read_file":
        target = resolve(root, arguments.get("path"))
        try:
            with open(target, encoding="utf-8") as file:
                return file.read()
        except OSError as error:
            raise ToolError(f"cannot read {arguments['path']}: {error.strerror}") from error
    if name == "list_files":
        real_root = os.path.realpath(root)
        paths = []
        for folder, _, files in os.walk(real_root):
            for file in files:
                # `/` on each system, so that the tests compare one form.
                relative = os.path.relpath(os.path.join(folder, file), real_root)
                paths.append(relative.replace(os.sep, "/"))
        return "\n".join(sorted(paths))
    raise ToolError(f"unknown tool: {name}")


class Server:
    """The MCP logic, with no transport. One instance is one MCP session."""

    def __init__(self, root, name):
        self.root = root
        self.name = name
        self.initialized = False

    def handle(self, message):
        """Returns the response to a message, or None for a notification."""
        method = message.get("method")
        if "id" not in message or method is None:
            return None
        request_id = message["id"]
        params = message.get("params") or {}

        if method == "initialize":
            if self.initialized:
                # One session takes one `initialize`. The tunnel client must
                # answer the later ones itself.
                return error(request_id, -32600, "already initialized")
            self.initialized = True
            return result(
                request_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": self.name, "version": "1.0.0"},
                },
            )
        if method == "ping":
            return result(request_id, {})
        if method == "tools/list":
            return result(request_id, {"tools": TOOLS})
        if method == "tools/call":
            try:
                text = call_tool(self.root, params.get("name"), params.get("arguments") or {})
                is_error = False
            except ToolError as tool_error:
                text = str(tool_error)
                is_error = True
            return result(
                request_id,
                {"content": [{"type": "text", "text": text}], "isError": is_error},
            )
        return error(request_id, -32601, f"Method not found: {method}")


def result(request_id, value):
    return {"jsonrpc": "2.0", "id": request_id, "result": value}


def error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


USAGE = "usage: files_mcp_server.py <root> [--pid-file <path>] [--log-to-stderr]"


def main(argv):
    if len(argv) < 2:
        sys.exit(USAGE)
    root = argv[1]
    pid_file = None
    log_to_stderr = False
    options = argv[2:]
    while options:
        option = options.pop(0)
        if option == "--pid-file" and options:
            pid_file = options.pop(0)
        elif option == "--log-to-stderr":
            log_to_stderr = True
        else:
            sys.exit(USAGE)

    def log(text):
        if log_to_stderr:
            print(text, file=sys.stderr, flush=True)

    server = Server(root, "files-stdio")
    if pid_file is not None:
        with open(pid_file, "w", encoding="utf-8") as file:
            file.write(str(os.getpid()))
    log("files server started")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        if "id" in message:
            log(f"request {message.get('method')}")
        response = server.handle(message)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv)
