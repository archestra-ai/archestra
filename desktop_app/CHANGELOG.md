# Changelog

## [0.0.12](https://github.com/archestra-ai/archestra/compare/v0.0.11...v0.0.12) (2025-10-01)


### Features

* WhatsApp MCP ([#516](https://github.com/archestra-ai/archestra/issues/516)) ([574cdac](https://github.com/archestra-ai/archestra/commit/574cdac5a94d254808e17e0291e0b28cdd810065))


### Bug Fixes

* update types.gen.ts ([#596](https://github.com/archestra-ai/archestra/issues/596)) ([a354149](https://github.com/archestra-ai/archestra/commit/a3541493c1f6eff6fbdcb27b5a56cfffcc055bba))

## [0.0.11](https://github.com/archestra-ai/archestra/compare/v0.0.10...v0.0.11) (2025-09-24)


### Bug Fixes

* Switch to gemini-2.5-pro ([#571](https://github.com/archestra-ai/archestra/issues/571)) ([516bdee](https://github.com/archestra-ai/archestra/commit/516bdee7445858db2ea8d63b75848e25a203c2b7))

## [0.0.10](https://github.com/archestra-ai/archestra/compare/v0.0.9...v0.0.10) (2025-09-24)


### Features

* add cloud auth token deep-linking support ([#544](https://github.com/archestra-ai/archestra/issues/544)) ([f43d8ca](https://github.com/archestra-ai/archestra/commit/f43d8ca87a73a85641ae856faeef386ba84cdab1))
* backend-code hot reloading ([#478](https://github.com/archestra-ai/archestra/issues/478)) ([34baf78](https://github.com/archestra-ai/archestra/commit/34baf7832a8d7795e6cd095f8fc0d44ab6735019))
* bump ollama to `v0.12.1` ([#555](https://github.com/archestra-ai/archestra/issues/555)) ([72d62d7](https://github.com/archestra-ai/archestra/commit/72d62d7d16f7a3e02d1ff4229a8543e3b86d5ab2))
* cloud archestra llm ([#540](https://github.com/archestra-ai/archestra/issues/540)) ([2eba7d1](https://github.com/archestra-ai/archestra/commit/2eba7d1345a6d0ec6f5fe271c22c0d46d7354158))
* improve error message display with user-friendly messages and collapsible details ([#527](https://github.com/archestra-ai/archestra/issues/527)) ([31de107](https://github.com/archestra-ai/archestra/commit/31de107f48c82804af5ebb2d5442a15a18bcd5d2))
* support mcp installation cancel ([#511](https://github.com/archestra-ai/archestra/issues/511)) ([e52f97f](https://github.com/archestra-ai/archestra/commit/e52f97f7d905e7f2666dc1c24cdc241edf2663e1))


### Bug Fixes

* add more visible border to scroll btn ([#563](https://github.com/archestra-ai/archestra/issues/563)) ([95cb901](https://github.com/archestra-ai/archestra/commit/95cb901f045c9ea22d299232e6a83e0078509ce6))
* backend logs not found in bug report modal ([#512](https://github.com/archestra-ai/archestra/issues/512)) ([59db5cc](https://github.com/archestra-ai/archestra/commit/59db5cc8d4abecbe82b82098960186bcbcf4f7a4))
* disable Archestra MCP after enable_tools ([#546](https://github.com/archestra-ai/archestra/issues/546)) ([a00fac2](https://github.com/archestra-ai/archestra/commit/a00fac2a7d8af149f1db949c3b665bc4068b845a))
* enhanced ui unused tools ([#565](https://github.com/archestra-ai/archestra/issues/565)) ([7db89f1](https://github.com/archestra-ai/archestra/commit/7db89f1f784e7680c33b930874376af35bbabed6))
* fix chat scrolling ([#562](https://github.com/archestra-ai/archestra/issues/562)) ([c2ba6be](https://github.com/archestra-ai/archestra/commit/c2ba6bee442ce47e3259128813281d67962f496f))
* fix jumping cursor in edited messages ([#560](https://github.com/archestra-ai/archestra/issues/560)) ([bac155b](https://github.com/archestra-ai/archestra/commit/bac155b06d9c5d68c1e76fe41aa98a4d02c01ad9))
* fix loading tools label ([#564](https://github.com/archestra-ai/archestra/issues/564)) ([fa1d5d0](https://github.com/archestra-ai/archestra/commit/fa1d5d0910781215f5defaa4d99e796b5a2eff05))
* fix message buttons ([#517](https://github.com/archestra-ai/archestra/issues/517)) ([3483179](https://github.com/archestra-ai/archestra/commit/3483179e3e181961b5fb9fe4f70982af45e5dfcd))
* for archestra cloud inference `baseUrl` ([#552](https://github.com/archestra-ai/archestra/issues/552)) ([9d10795](https://github.com/archestra-ai/archestra/commit/9d1079549ec8e53dc5c4da346015e638737f88fe))
* improve scrolling ([#568](https://github.com/archestra-ai/archestra/issues/568)) ([0972397](https://github.com/archestra-ai/archestra/commit/09723971f44443b127ebb1d0af2c316c345e7fed))
* improve scrolling2 ([#569](https://github.com/archestra-ai/archestra/issues/569)) ([7bd9e9c](https://github.com/archestra-ai/archestra/commit/7bd9e9c2b34bb09684f16648f5fd419282d89ce7))
* increase max tool calls from 10 to 30 ([#523](https://github.com/archestra-ai/archestra/issues/523)) ([34cb041](https://github.com/archestra-ai/archestra/commit/34cb041f8d89613977026ab3a80ba0c74ab00c14))
* preserve assigned HTTP port for streamable containers after app … ([#551](https://github.com/archestra-ai/archestra/issues/551)) ([f0b83f1](https://github.com/archestra-ai/archestra/commit/f0b83f17a34f2fe38dcfb0eaad5f6fd4393eff85))
* quick fix slack browser auth ([#557](https://github.com/archestra-ai/archestra/issues/557)) ([a32755d](https://github.com/archestra-ai/archestra/commit/a32755db6a484327a145fc3cbbd74da1b44cbd3a))
* refresh llm-proxy models immediately after auth success ([#556](https://github.com/archestra-ai/archestra/issues/556)) ([cded953](https://github.com/archestra-ai/archestra/commit/cded953a99cbd19218e6ae370498b5ac2bc3ab86)), closes [#549](https://github.com/archestra-ai/archestra/issues/549)
* reset token usage on agent restart ([#489](https://github.com/archestra-ai/archestra/issues/489)) ([271f4f4](https://github.com/archestra-ai/archestra/commit/271f4f4cbe2124bfc01dd199f3bea7775d897f2a))
* return stop button ([#518](https://github.com/archestra-ai/archestra/issues/518)) ([9d48aeb](https://github.com/archestra-ai/archestra/commit/9d48aebdd647fa603a0425d02eeda9e339971b02))
* send session token as Authorization: Bearer token to llm proxy ([#545](https://github.com/archestra-ai/archestra/issues/545)) ([e1c40a2](https://github.com/archestra-ai/archestra/commit/e1c40a2d8dee6da62df44e6b687582d29b3d6689))
* shorten tool id ([#521](https://github.com/archestra-ai/archestra/issues/521)) ([e2f29cf](https://github.com/archestra-ai/archestra/commit/e2f29cf2dd5d17de02dfeedd053409ba1c49e63c))
* update cumulative token stats logic ([#536](https://github.com/archestra-ai/archestra/issues/536)) ([c09e370](https://github.com/archestra-ai/archestra/commit/c09e370b3d1ba10322903ba852b4e650f8df3b50))
* use latest base image ([#519](https://github.com/archestra-ai/archestra/issues/519)) ([ffe8be6](https://github.com/archestra-ai/archestra/commit/ffe8be65786682a197adc2ad9dc75877021a667e))
* when uninstalling mcp server, properly remove container ([#542](https://github.com/archestra-ai/archestra/issues/542)) ([60a09b3](https://github.com/archestra-ai/archestra/commit/60a09b3688a3d222c301e5abd4ae28521f8e508f))

## [0.0.9](https://github.com/archestra-ai/archestra/compare/v0.0.8...v0.0.9) (2025-09-20)


### Features

* Add Ollama model uninstall functionality ([#331](https://github.com/archestra-ai/archestra/issues/331)) ([0d8a459](https://github.com/archestra-ai/archestra/commit/0d8a459a245ef9270cbe20b157b1cb8dcc9a0157))
* display pretty tool names in `AssistantMessage` ([#497](https://github.com/archestra-ai/archestra/issues/497)) ([26be529](https://github.com/archestra-ai/archestra/commit/26be5295e1b287b555fdf59a8a8cb0fd1ac67aae))
* preload selected ollama model on `zustand` store hydration ([#500](https://github.com/archestra-ai/archestra/issues/500)) ([a9cf6a4](https://github.com/archestra-ai/archestra/commit/a9cf6a422e6c5e1cafc9aa7c5d7d9510013f19be))
* user-approval UX for write tools ([#485](https://github.com/archestra-ai/archestra/issues/485)) ([995f9b4](https://github.com/archestra-ai/archestra/commit/995f9b472a558011f647cb91f788e07a129cd8a9))


### Bug Fixes

* Archestra MCP server's `set_memory` tool parameter handling ([#499](https://github.com/archestra-ai/archestra/issues/499)) ([8c799fe](https://github.com/archestra-ai/archestra/commit/8c799fe60db847175d9b08c0cfdd6fdc3975f0d6))
* Fix `MemoriesMessage` display when memory values contain newline characters ([#498](https://github.com/archestra-ai/archestra/issues/498)) ([4433eb5](https://github.com/archestra-ai/archestra/commit/4433eb58d8e7300a088bde6b840624f71b149564))
* fix cases when no model ([#486](https://github.com/archestra-ai/archestra/issues/486)) ([0b4bf9b](https://github.com/archestra-ai/archestra/commit/0b4bf9be76fa091e6848d564455712ebe66deb47))
* Move `selectedModel` from `ollama-store` to `chat-store` for proper persistence ([#493](https://github.com/archestra-ai/archestra/issues/493)) ([e7610b7](https://github.com/archestra-ai/archestra/commit/e7610b730fb844ace2851c6e03fdfd5960ffcbec))
* Podman - only pull base Docker image if required ([#396](https://github.com/archestra-ai/archestra/issues/396)) ([02247c1](https://github.com/archestra-ai/archestra/commit/02247c1a18402f27c4a96d593b695f1c20fd66eb))
* show thinking, simplify logic ([#480](https://github.com/archestra-ai/archestra/issues/480)) ([1217680](https://github.com/archestra-ai/archestra/commit/1217680c295943a4b124c5f5b19255b7bff571f6))

## [0.0.8](https://github.com/archestra-ai/archestra/compare/v0.0.7...v0.0.8) (2025-09-18)


### Features

* improve running chats in background ([#377](https://github.com/archestra-ai/archestra/issues/377)) ([1d8dc65](https://github.com/archestra-ai/archestra/commit/1d8dc65947d2df0d0c2a174352ff463731f9d20f))


### Bug Fixes

* hide setup tile when no model ([#472](https://github.com/archestra-ai/archestra/issues/472)) ([20dec1c](https://github.com/archestra-ai/archestra/commit/20dec1c9bc382e43ee449870fcfc6aa7812a2587))

## [0.0.7](https://github.com/archestra-ai/archestra/compare/v0.0.6...v0.0.7) (2025-09-18)


### Features

* Add archestra-llm provider and llm-proxy service ([#460](https://github.com/archestra-ai/archestra/issues/460)) ([243518c](https://github.com/archestra-ai/archestra/commit/243518ce1ee01b31f17e1e60433ec160b699faed))
* Add stop button and fix bugs in error display ([#461](https://github.com/archestra-ai/archestra/issues/461)) ([4e6a853](https://github.com/archestra-ai/archestra/commit/4e6a85309579916a4ca2a1df6063a8e37c760d8c))


### Bug Fixes

* errors when connecting Slack and GitHub connectors ([#433](https://github.com/archestra-ai/archestra/issues/433)) ([da05c1b](https://github.com/archestra-ai/archestra/commit/da05c1ba9010a37eb7e53278bf503fd577eb366f))

## [0.0.6](https://github.com/archestra-ai/archestra/compare/v0.0.5...v0.0.6) (2025-09-17)


### Bug Fixes

* auto-refresh Ollama models list after download completes ([#455](https://github.com/archestra-ai/archestra/issues/455)) ([02a964c](https://github.com/archestra-ai/archestra/commit/02a964c7f3d225d73309a1fe14b2e215232c19fc))
* hide system messages from chat UI ([#445](https://github.com/archestra-ai/archestra/issues/445)) ([b92205e](https://github.com/archestra-ai/archestra/commit/b92205e4869f851617b3b1bc3c504ef8ec3970c2))
* polishing for archestra mcp ([#447](https://github.com/archestra-ai/archestra/issues/447)) ([7ae602d](https://github.com/archestra-ai/archestra/commit/7ae602d4cdac97b31a3249cbd83601b2a0d33804))
* posthog is back ([#459](https://github.com/archestra-ai/archestra/issues/459)) ([10826bb](https://github.com/archestra-ai/archestra/commit/10826bbe76b7d386fc78965abcf188e15e7ae4f8))
* properly update messages with edited content before saving ([#453](https://github.com/archestra-ai/archestra/issues/453)) ([f2920b6](https://github.com/archestra-ai/archestra/commit/f2920b6b24dbe01a6fd04e7e0ebf4ec8e066ecbb))
* race condition with memory loading on chat reset ([#457](https://github.com/archestra-ai/archestra/issues/457)) ([fc68d6b](https://github.com/archestra-ai/archestra/commit/fc68d6b0f6a0ef804bd909eba987c3556fb65665))
* resolve HTML validation error for nested button elements in sidebar ([#458](https://github.com/archestra-ai/archestra/issues/458)) ([37b2d57](https://github.com/archestra-ai/archestra/commit/37b2d57ef8835362d3a77747fd9dbb6f38667777))
* tweak vercel sdk `providerOptions` ([#434](https://github.com/archestra-ai/archestra/issues/434)) ([64d0100](https://github.com/archestra-ai/archestra/commit/64d01009d708b9c143d86a4354542dca9d0b5620))

## [0.0.5](https://github.com/archestra-ai/archestra/compare/v0.0.4...v0.0.5) (2025-09-17)


### Features

* add context size, fix bugs ([#432](https://github.com/archestra-ai/archestra/issues/432)) ([aa4eb52](https://github.com/archestra-ai/archestra/commit/aa4eb5207ab6efc63bf4e30b079ce7f5c62ed67d))


### Bug Fixes

* infinite tool analysis loading in UI sidebar ([#419](https://github.com/archestra-ai/archestra/issues/419)) ([59a73df](https://github.com/archestra-ai/archestra/commit/59a73df2139c26ed8d2dcdef7251e23f082a8b12)), closes [#404](https://github.com/archestra-ai/archestra/issues/404)
* Logs and sys prompt ([#397](https://github.com/archestra-ai/archestra/issues/397)) ([c56cf5a](https://github.com/archestra-ai/archestra/commit/c56cf5a502307eeff3b3f0ba31abfa20d8a4c4f7))
* open links in external browser instead of internal browser ([#423](https://github.com/archestra-ai/archestra/issues/423)) ([30efde3](https://github.com/archestra-ai/archestra/commit/30efde3797c58d2d45305fc70eae121f697d318b))
* show auth confirmation dialog for Remote MCP servers ([#422](https://github.com/archestra-ai/archestra/issues/422)) ([d56b0ac](https://github.com/archestra-ai/archestra/commit/d56b0acf829e837855e9bc7b2364e9338611b579))
* system prompt and markup ([#416](https://github.com/archestra-ai/archestra/issues/416)) ([a215c3a](https://github.com/archestra-ai/archestra/commit/a215c3acbd43e97fb61b8f16d9cfe94d74a1a7d5))

## [0.0.4](https://github.com/archestra-ai/archestra/compare/v0.0.3...v0.0.4) (2025-09-16)


### Features

* basic packaged-app e2e test ([#341](https://github.com/archestra-ai/archestra/issues/341)) ([640ca39](https://github.com/archestra-ai/archestra/commit/640ca390fc9a31ab626f906f4aab766f3ff7e444))


### Bug Fixes

* address outstanding pnpm typecheck errors ([#395](https://github.com/archestra-ai/archestra/issues/395)) ([726803c](https://github.com/archestra-ai/archestra/commit/726803c8a3810204df8ef132b3af51b6cac23011))
* several chat related bugs ([#394](https://github.com/archestra-ai/archestra/issues/394)) ([90503d1](https://github.com/archestra-ai/archestra/commit/90503d1c32d8b79c6da89839d44ebbf8c06f6976))


### Dependencies

* **frontend:** bump the frontend-dependencies group across 1 directory with 35 updates ([#398](https://github.com/archestra-ai/archestra/issues/398)) ([cbbe509](https://github.com/archestra-ai/archestra/commit/cbbe50941d2a965c80b58751875b101ccb988df4))

## [0.0.3](https://github.com/archestra-ai/archestra/compare/v0.0.2...v0.0.3) (2025-09-16)


### Features

* onboarding, local models preloading and other fixes ([#388](https://github.com/archestra-ai/archestra/issues/388)) ([3f8906b](https://github.com/archestra-ai/archestra/commit/3f8906b550d80079ee769ebf0295a2ec21e826f3))


### Bug Fixes

* `vfkit exited unexpectedly with exit code 1` on Mac signed app ([#390](https://github.com/archestra-ai/archestra/issues/390)) ([d21151e](https://github.com/archestra-ai/archestra/commit/d21151e3460198a691f7101beabebfc8cdf1b5bc))

## [0.0.2](https://github.com/archestra-ai/archestra/compare/v0.0.1...v0.0.2) (2025-09-15)


### Bug Fixes

* test to trigger new version (testing auto-updater functionality) ([e065df8](https://github.com/archestra-ai/archestra/commit/e065df8b4106f39250e70017f39ee25caa015d56))

## 0.0.1 (2025-09-15)


### Features

* Hello World, Meet Archestra 🤖❤️ ([9586698](https://github.com/archestra-ai/archestra/commit/95866981b0fc62bd84fba9b87336573b4cdbfa35))
