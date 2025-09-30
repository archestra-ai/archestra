## Development

Before you begin, ensure you have the following installed:

- Node.js (v18 or higher)
- pnpm (v8 or higher) - Install with npm install -g pnpm
- [Tilt](https://docs.tilt.dev/install.html)
- [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl-macos/)
- Local k8s cluster (Docker Desktop with k8s enabled, Kind or Orbstack)
- [Biome VSCode extension](https://open-vsx.org/extension/biomejs/biome)
- Git


Run dev environment

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
tilt up
```
