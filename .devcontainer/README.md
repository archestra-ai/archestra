# Dev Container

Sandboxed development environment for working with Claude Code.

For full documentation, see: https://code.claude.com/docs/en/devcontainer

## Getting Started

### VS Code

1. Install the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension.
2. Open this repository in VS Code.
3. When prompted, click **Reopen in Container** — or run the command **Dev Containers: Reopen in Container** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

### CLI

Make sure the [Dev Container CLI](https://github.com/devcontainers/cli) is installed:

```sh
npm install -g @devcontainers/cli
```

Or from VS Code: `Ctrl+Shift+P` / `Cmd+Shift+P` → **Dev Containers: Install devcontainer CLI**.

Build and start the container:

```sh
devcontainer up --workspace-folder .
```

Run a command inside the container:

```sh
devcontainer exec --workspace-folder . bash
```
