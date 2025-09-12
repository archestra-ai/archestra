# Changelog

## [0.0.5-alpha](https://github.com/archestra-ai/archestra/compare/desktop_app-v0.0.4-alpha...desktop_app-v0.0.5-alpha) (2025-09-12)


### Bug Fixes

* db migrations +  call `createWindow` BEFORE calling `startBackendServer` (heavily improves boot-up speed) ([#357](https://github.com/archestra-ai/archestra/issues/357)) ([47a47bc](https://github.com/archestra-ai/archestra/commit/47a47bcaf328e62f4e5f2e58a529bd02cb0a0564))
* make sentry user id consistent ([b1753c8](https://github.com/archestra-ai/archestra/commit/b1753c8114e03e6e9d01ac6ca546c52a5a4e2d23))

## [0.0.4-alpha](https://github.com/archestra-ai/archestra/compare/desktop_app-v0.0.3-alpha...desktop_app-v0.0.4-alpha) (2025-09-12)


### Features

* add posthog for session replays ([#349](https://github.com/archestra-ai/archestra/issues/349)) ([9bbf909](https://github.com/archestra-ai/archestra/commit/9bbf9097e272a50f48230358359eb00acb3d288b))
* New auth popup ([#348](https://github.com/archestra-ai/archestra/issues/348)) ([5dc9be9](https://github.com/archestra-ai/archestra/commit/5dc9be9e82fad4698f3ff6d918a3d64bab9c3d02))
* support  streamable-http mcp servers in mcp sandbox ([#353](https://github.com/archestra-ai/archestra/issues/353)) ([933285a](https://github.com/archestra-ai/archestra/commit/933285a55c5dfd3100158a09ceea8522a07d72d2))
* support filesystem MCP ([#338](https://github.com/archestra-ai/archestra/issues/338)) ([637ff0f](https://github.com/archestra-ai/archestra/commit/637ff0fcc5759a6ca32fcb47b6c49c9d4c98af76))


### Bug Fixes

* archestra memory ([#342](https://github.com/archestra-ai/archestra/issues/342)) ([1473ca2](https://github.com/archestra-ai/archestra/commit/1473ca264f3f24ef8168c4a38a62a9256eab95c3))
* hopefully final fix of memory mcp ([7e22640](https://github.com/archestra-ai/archestra/commit/7e226409594d9291c61ecab1449fc0ccf19097e8))
* polish oauth proxy flows ([#344](https://github.com/archestra-ai/archestra/issues/344)) ([3530f25](https://github.com/archestra-ai/archestra/commit/3530f259a273aff4d1d38e5a6e920975f644ec2d))
* several small bugs in packaged app ([#356](https://github.com/archestra-ai/archestra/issues/356)) ([4df27c2](https://github.com/archestra-ai/archestra/commit/4df27c26b4dfdb40b254d7426bbb78f5f5e386ab))
* working browser based auth ([#346](https://github.com/archestra-ai/archestra/issues/346)) ([ca5de46](https://github.com/archestra-ai/archestra/commit/ca5de46773283a2d13f0233413a9b4333e2ac15e))

## [0.0.3-alpha](https://github.com/archestra-ai/archestra/compare/desktop_app-v0.0.2-alpha...desktop_app-v0.0.3-alpha) (2025-09-10)


### Features

* status bar ([#335](https://github.com/archestra-ai/archestra/issues/335)) ([912b4ce](https://github.com/archestra-ai/archestra/commit/912b4ce04303f7382609cd0587575e4217134cbd))
* working oauth proxy ([#334](https://github.com/archestra-ai/archestra/issues/334)) ([f98c7b6](https://github.com/archestra-ai/archestra/commit/f98c7b6aeb74cf261405d92ed123bc5bda38f886))


### Dependencies

* **frontend:** bump vite from 7.1.3 to 7.1.5 in /desktop_app ([#330](https://github.com/archestra-ai/archestra/issues/330)) ([c6295b6](https://github.com/archestra-ai/archestra/commit/c6295b633d312199dfac7e341a7faa57bf55d8ea))

## [0.0.2-alpha](https://github.com/archestra-ai/archestra/compare/desktop_app-v0.0.1-alpha...desktop_app-v0.0.2-alpha) (2025-09-10)


### Features

* add ability to report catalog entry issue ([#298](https://github.com/archestra-ai/archestra/issues/298)) ([faeafce](https://github.com/archestra-ai/archestra/commit/faeafce1f24eeda7cbe72f2ae33c37983909d655))
* Add remote servers support and use MCP SDK to implement oauth accoring to spec ([#291](https://github.com/archestra-ai/archestra/issues/291)) ([ac16559](https://github.com/archestra-ai/archestra/commit/ac16559a4e1e2dd80ba22d6e11eef1d8157b2962))
* always show sandbox settings icon/dialog ([e1f4bd5](https://github.com/archestra-ai/archestra/commit/e1f4bd5a10ff733372bde5511b1eeb2bcd39c8db))


### Bug Fixes

* address current issues preventing packaged app from successfully booting up ([#329](https://github.com/archestra-ai/archestra/issues/329)) ([1364894](https://github.com/archestra-ai/archestra/commit/13648947f461d9ac13cd3d0ecbcc608c1a5ef3dd))
* error state/message management for podman runtime ([#292](https://github.com/archestra-ai/archestra/issues/292)) ([a2fe61a](https://github.com/archestra-ai/archestra/commit/a2fe61a30418072b861908f66bf6eeedd65b6363))
* issue 263 ([#294](https://github.com/archestra-ai/archestra/issues/294)) ([76e392d](https://github.com/archestra-ai/archestra/commit/76e392d754c38a124b56e0166d7d65eb6d2e3b49))
* issue 263 ([#305](https://github.com/archestra-ai/archestra/issues/305)) ([ef45abf](https://github.com/archestra-ai/archestra/commit/ef45abfa00a7b37d3636aeb4128e3b9d82305f75))
* preserve user tool selection when tools update ([#303](https://github.com/archestra-ai/archestra/issues/303)) ([e0f91ab](https://github.com/archestra-ai/archestra/commit/e0f91ab334a28b9bad423d6bf11ecf46130b4d3e))

## [0.0.1-alpha](https://github.com/archestra-ai/archestra/compare/desktop_app-v0.0.0-alpha...desktop_app-v0.0.1-alpha) (2025-09-05)


### Features

* World, meet Archestra 🤖❤️ ([ebff01a](https://github.com/archestra-ai/archestra/commit/ebff01a02e352ec49a12389900c47111d6a95ee6))
