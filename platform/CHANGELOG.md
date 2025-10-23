# Changelog

## [0.0.12](https://github.com/archestra-ai/archestra/compare/platform-v0.0.11...platform-v0.0.12) (2025-10-20)


### Features

* add dual llm per tool ([#745](https://github.com/archestra-ai/archestra/issues/745)) ([ed25e1a](https://github.com/archestra-ai/archestra/commit/ed25e1ac34e801baf85ce68cb6b90265255d846e))
* add dual llm support for anthropic provider ([#748](https://github.com/archestra-ai/archestra/issues/748)) ([0507ec8](https://github.com/archestra-ai/archestra/commit/0507ec8c5e3cde001e0eaca428c481f7cefac970))
* add ui for anthropic ([#750](https://github.com/archestra-ai/archestra/issues/750)) ([7531d2b](https://github.com/archestra-ai/archestra/commit/7531d2bd35aab30d83e8eeae2cddccec76ff1c96))
* anthropic support ([#731](https://github.com/archestra-ai/archestra/issues/731)) ([fb8d007](https://github.com/archestra-ai/archestra/commit/fb8d007b26b55dee5dea4504aa129a73fbf35c82))
* assign members to agent ([#747](https://github.com/archestra-ai/archestra/issues/747)) ([aa6d1e9](https://github.com/archestra-ai/archestra/commit/aa6d1e9bb288080528a01151eca71619fa11df7a))
* better auth integration ([#729](https://github.com/archestra-ai/archestra/issues/729)) ([fb6a1bd](https://github.com/archestra-ai/archestra/commit/fb6a1bdafe2cc299327903456cf87953f8a19ba1))
* implement rbac on backend ([#737](https://github.com/archestra-ai/archestra/issues/737)) ([f4d5f1b](https://github.com/archestra-ai/archestra/commit/f4d5f1b454d1f343ccc7c28a4a82a97c3bb40b8c))
* New tools UI ([#734](https://github.com/archestra-ai/archestra/issues/734)) ([7b1f355](https://github.com/archestra-ai/archestra/commit/7b1f355a77e093b9cc426d3d6ddebd7e3a3ef331))
* update agents + settings pages ([#739](https://github.com/archestra-ai/archestra/issues/739)) ([5f8fad1](https://github.com/archestra-ai/archestra/commit/5f8fad1ca81a4519cd8e759b8f940ea9b2dd94b1))
* warning about password ([#740](https://github.com/archestra-ai/archestra/issues/740)) ([40d2e9b](https://github.com/archestra-ai/archestra/commit/40d2e9b05e8339e328f0089d8cc5df1cb6c3af50))


### Bug Fixes

* Add ALLOWED_FRONTEND_ORIGINS variable to fix cors issue ([#732](https://github.com/archestra-ai/archestra/issues/732)) ([83efcba](https://github.com/archestra-ai/archestra/commit/83efcba5a593c3cdc7d8c36127f55add9bc989f3))
* add ARCHESTRA_ to ALLOWED_FRONTEND_ORIGINS ([#733](https://github.com/archestra-ai/archestra/issues/733)) ([b5d7277](https://github.com/archestra-ai/archestra/commit/b5d72770f357e315c7765446c4ea3db4a412aada))
* change default login/password to admin@example.com/password ([#744](https://github.com/archestra-ai/archestra/issues/744)) ([93f9ff1](https://github.com/archestra-ai/archestra/commit/93f9ff118ab433abcfb327497bd012563a3c98df))
* fix benchmarks ([#725](https://github.com/archestra-ai/archestra/issues/725)) ([04d73a7](https://github.com/archestra-ai/archestra/commit/04d73a7b9ff1e0070e1f2b5ce6bdc1c3ee6318cb))
* mark trusted when processed by Dual LLM ([#746](https://github.com/archestra-ai/archestra/issues/746)) ([fcb31c9](https://github.com/archestra-ai/archestra/commit/fcb31c94f783908f06ae38f03674e1774a2bf637))
* minor bug in accept invite link flow ([#735](https://github.com/archestra-ai/archestra/issues/735)) ([e416193](https://github.com/archestra-ai/archestra/commit/e41619323916ee06ba0d0b319ab72fdbfcd9206a))
* remove * cors ([#738](https://github.com/archestra-ai/archestra/issues/738)) ([6e4269d](https://github.com/archestra-ai/archestra/commit/6e4269dfe0055fd7f262e302c1ac5334861d32cd))
* use buttongroups in tools bulk update ([52c7b73](https://github.com/archestra-ai/archestra/commit/52c7b739582ceaa7431c1bed4baa6482207a40f2))
* warning about password on the login page ([#742](https://github.com/archestra-ai/archestra/issues/742)) ([c5d86ef](https://github.com/archestra-ai/archestra/commit/c5d86ef0ed46740c17a56fd85cae58c860856d44))

## [0.0.11](https://github.com/archestra-ai/archestra/compare/platform-v0.0.10...platform-v0.0.11) (2025-10-15)


### Features

* add gemini provider support ([#716](https://github.com/archestra-ai/archestra/issues/716)) ([456bde5](https://github.com/archestra-ai/archestra/commit/456bde51d4f2cd8091e35d29fc921ea26b5b61bc))
* archestra + mastra example and docker compose ([#714](https://github.com/archestra-ai/archestra/issues/714)) ([8548320](https://github.com/archestra-ai/archestra/commit/8548320c34fb4b005c9d6f6e34ca8b14439eaf45))
* logs pagination and sorting ([#718](https://github.com/archestra-ai/archestra/issues/718)) ([59b698c](https://github.com/archestra-ai/archestra/commit/59b698c6991e14c96bf14248547c754517c9d7f7))
* performance benchmarks ([#724](https://github.com/archestra-ai/archestra/issues/724)) ([2590217](https://github.com/archestra-ai/archestra/commit/259021783265dd25f8270745ec9814b4db7df438))


### Bug Fixes

* fix seed data to reflect demo scenario ([#707](https://github.com/archestra-ai/archestra/issues/707)) ([4f98efb](https://github.com/archestra-ai/archestra/commit/4f98efb7ab9e8d04d985d91be910780a9dca40d3))
* fix texts for dual llm ([#717](https://github.com/archestra-ai/archestra/issues/717)) ([fc60d36](https://github.com/archestra-ai/archestra/commit/fc60d367f24b7078616e255b6f9acdcf067366a9))
* show tooltip on hovering text ([#710](https://github.com/archestra-ai/archestra/issues/710)) ([264a281](https://github.com/archestra-ai/archestra/commit/264a28165621516e4aa9b0288996d6c71dfc5c35))
* unify table paddings ([#721](https://github.com/archestra-ai/archestra/issues/721)) ([1e26f1b](https://github.com/archestra-ai/archestra/commit/1e26f1b1e96c18d18e49bccb260fb906da59aed3))

## [0.0.10](https://github.com/archestra-ai/archestra/compare/platform-v0.0.9...platform-v0.0.10) (2025-10-13)


### Features

* DualLLM pattern ([#692](https://github.com/archestra-ai/archestra/issues/692)) ([1d9ef9e](https://github.com/archestra-ai/archestra/commit/1d9ef9eaf0a9e536de596f27341e4babcd960d1c))


### Bug Fixes

* a pack of ui fixes, posthog and bugreport button ([#694](https://github.com/archestra-ai/archestra/issues/694)) ([a2f8443](https://github.com/archestra-ai/archestra/commit/a2f844345db64f9d61ca7fd7abea221d683a84ae))
* captal case and night theme ([#702](https://github.com/archestra-ai/archestra/issues/702)) ([825007f](https://github.com/archestra-ai/archestra/commit/825007fb3141e5db47d06588165dcba57a25b4e5))
* fix layout issues on logs pages ([#701](https://github.com/archestra-ai/archestra/issues/701)) ([5c9ae21](https://github.com/archestra-ai/archestra/commit/5c9ae21a15ec3f4962f173a762fde15cc412a42e))
* remove helm leftovers ([#697](https://github.com/archestra-ai/archestra/issues/697)) ([27d032c](https://github.com/archestra-ai/archestra/commit/27d032c3eee43ac64970bc561199db62b9721ce9))
* remove helm leftovers, change logs to table, add dual llm to tools config, change settings layout, change log details view ([#698](https://github.com/archestra-ai/archestra/issues/698)) ([e1a65b2](https://github.com/archestra-ai/archestra/commit/e1a65b21dd6b9fc532f6bec773163688b6984570))

## [0.0.9](https://github.com/archestra-ai/archestra/compare/platform-v0.0.8...platform-v0.0.9) (2025-10-11)


### Features

* add gemini support to pydantic ai example ([6af8061](https://github.com/archestra-ai/archestra/commit/6af8061920f8707740e78b9e4aca37cc8aa93f28))
* allow customizing proxy URL displayed in UI ([#690](https://github.com/archestra-ai/archestra/issues/690)) ([169b993](https://github.com/archestra-ai/archestra/commit/169b993897f83844141c78b6d6a72e2e3ee35d19))


### Bug Fixes

* "hydration" next.js warning on Agents page ([7080c8f](https://github.com/archestra-ai/archestra/commit/7080c8f78cc5bdbc208faa7c46cf18766c78ea16))
* fix ai sdk example ([#683](https://github.com/archestra-ai/archestra/issues/683)) ([2678ba3](https://github.com/archestra-ai/archestra/commit/2678ba3686dd5f3bb9becbf7c0bc0fc9cd4e2e78))
* tool name unique constraint should be composite (with agent id) ([#685](https://github.com/archestra-ai/archestra/issues/685)) ([0da4659](https://github.com/archestra-ai/archestra/commit/0da465930e742d22a21faf5b2e875ebd63bea890))
* ui polishing and dynamic backend API endpoint ([#687](https://github.com/archestra-ai/archestra/issues/687)) ([afc51ca](https://github.com/archestra-ai/archestra/commit/afc51cae9be09e318b65344f603c89edee3ccf0c))
* use tsup to bundle backend, fix dockerized app ([#691](https://github.com/archestra-ai/archestra/issues/691)) ([9507a9d](https://github.com/archestra-ai/archestra/commit/9507a9d16a9468fe857d0c0408f31721dc33d5a3))

## [0.0.8](https://github.com/archestra-ai/archestra/compare/platform-v0.0.7...platform-v0.0.8) (2025-10-09)


### Features

* add platform example for pydantic AI ([#655](https://github.com/archestra-ai/archestra/issues/655)) ([c82862b](https://github.com/archestra-ai/archestra/commit/c82862ba8629d1eb92a75ff2f243cb627f37fc12))
* multi-agent support ([#680](https://github.com/archestra-ai/archestra/issues/680)) ([c3f0cbd](https://github.com/archestra-ai/archestra/commit/c3f0cbd623a7fb32330007aaa9fa3613777578bb))


### Bug Fixes

* tell agents to use shadcn over radix ([#674](https://github.com/archestra-ai/archestra/issues/674)) ([924b0a6](https://github.com/archestra-ai/archestra/commit/924b0a6363d927101651e7c026181e9d89fdca75))

## [0.0.7](https://github.com/archestra-ai/archestra/compare/platform-v0.0.6...platform-v0.0.7) (2025-10-08)


### Features

* add docker-compose for openwebui example ([#642](https://github.com/archestra-ai/archestra/issues/642)) ([4c3806d](https://github.com/archestra-ai/archestra/commit/4c3806dda5b5d2b27ec8165d4f0c62085cb7c3ec))


### Bug Fixes

* update interactions data-model ([#660](https://github.com/archestra-ai/archestra/issues/660)) ([b226b84](https://github.com/archestra-ai/archestra/commit/b226b84a882a8d9482e945edb0df34083400a579))

## [0.0.6](https://github.com/archestra-ai/archestra/compare/platform-v0.0.5...platform-v0.0.6) (2025-10-07)


### Bug Fixes

* solve chat ID grouping ([#653](https://github.com/archestra-ai/archestra/issues/653)) ([deb400d](https://github.com/archestra-ai/archestra/commit/deb400dbc73c2f4ca0c7e0c1fc2a32f54df2c5d0))

## [0.0.5](https://github.com/archestra-ai/archestra/compare/platform-v0.0.4...platform-v0.0.5) (2025-10-07)


### Bug Fixes

* displaying blocked tool call content ([#650](https://github.com/archestra-ai/archestra/issues/650)) ([8d4f9ec](https://github.com/archestra-ai/archestra/commit/8d4f9ec9c648ace650fe4987881302bf5ab1bf3e))

## [0.0.4](https://github.com/archestra-ai/archestra/compare/platform-v0.0.3...platform-v0.0.4) (2025-10-07)


### Features

* setup basic archestra-platform helm chart ([#644](https://github.com/archestra-ai/archestra/issues/644)) ([3455ff2](https://github.com/archestra-ai/archestra/commit/3455ff21d91444ff211d646568a1a0f2af6c1e45))

## [0.0.3](https://github.com/archestra-ai/archestra/compare/platform-v0.0.2...platform-v0.0.3) (2025-10-06)


### Features

* allow running platform as single container ([b354fbf](https://github.com/archestra-ai/archestra/commit/b354fbf4e0f1a435864e1a9e1f2623450818bc46))

## [0.0.2](https://github.com/archestra-ai/archestra/compare/platform-v0.0.1...platform-v0.0.2) (2025-10-06)


### Bug Fixes

* tweak platform dockerhub image tags ([#636](https://github.com/archestra-ai/archestra/issues/636)) ([9fd9959](https://github.com/archestra-ai/archestra/commit/9fd9959fe0c0e586c05bea34737d76b04b07abde))

## 0.0.1 (2025-10-06)


### Features

* [platform] CRUD for agents, tool invocation + trusted data autonomy policies ([#603](https://github.com/archestra-ai/archestra/issues/603)) ([b590da3](https://github.com/archestra-ai/archestra/commit/b590da3c5d31ebec1b8caceeda7c6cda41eb20c0))
* add "blocked" action for trusted data policies ([#621](https://github.com/archestra-ai/archestra/issues/621)) ([0bf27ff](https://github.com/archestra-ai/archestra/commit/0bf27ff380a33af1b0d8fb12bd32d517f0f28787))
* allow not specifying agent/chat id ([#606](https://github.com/archestra-ai/archestra/issues/606)) ([3fba3e7](https://github.com/archestra-ai/archestra/commit/3fba3e78376d2a20933b0ad90d57779e620dcd82))
* allow whitelisting specific tool invocations even when data is untrusted ([#614](https://github.com/archestra-ai/archestra/issues/614)) ([52a8cc9](https://github.com/archestra-ai/archestra/commit/52a8cc9dc89a12ea72e2f9e1eb7502670c8141d5))
* chat completions streaming ([#609](https://github.com/archestra-ai/archestra/issues/609)) ([72cc7d3](https://github.com/archestra-ai/archestra/commit/72cc7d338c1c5d7aa27701d0f5e35efba920042f))
* codegen'd platform api client ([#589](https://github.com/archestra-ai/archestra/issues/589)) ([d0e969e](https://github.com/archestra-ai/archestra/commit/d0e969ecc0345f0f04ef337cc7354bcc8a28773c))
* finalize "blocked" trusted data policy "action" ([#626](https://github.com/archestra-ai/archestra/issues/626)) ([7597d6d](https://github.com/archestra-ai/archestra/commit/7597d6d1b465edba31305d5573f863af804cac48))
* persist/display platform tools ([#602](https://github.com/archestra-ai/archestra/issues/602)) ([bf54bcd](https://github.com/archestra-ai/archestra/commit/bf54bcddbf85cef9853bcbac7154edae8a06f353))
* platform backend proxy ([#583](https://github.com/archestra-ai/archestra/issues/583)) ([470060f](https://github.com/archestra-ai/archestra/commit/470060f3ac78f658d5528a1f3686ac0b53ccc6b7))
* platform release-please dockerhub + helm-chart release workflow ([#631](https://github.com/archestra-ai/archestra/issues/631)) ([22d068a](https://github.com/archestra-ai/archestra/commit/22d068ab65b48890db08264ffd77a9014c6c4395))
* proxy all openai routes upstream except for POST /chat/completions ([05cc5be](https://github.com/archestra-ai/archestra/commit/05cc5bee9f073a07b046e1e67d859c10eb6b8400))
* World, meet Archestra 🤖❤️ ([f0df735](https://github.com/archestra-ai/archestra/commit/f0df735202d076601232dd1fa6e0e874e1080d3c))


### Bug Fixes

* allow null system_fingerprint in OpenAI response schema (for openwebUI) ([#625](https://github.com/archestra-ai/archestra/issues/625)) ([1046798](https://github.com/archestra-ai/archestra/commit/1046798a5ea18ac69e41afb94d1ee85eecb139ec))
* fix imports ([#622](https://github.com/archestra-ai/archestra/issues/622)) ([7512ff2](https://github.com/archestra-ai/archestra/commit/7512ff2b7541b5cbaaa5d4dfda3f6891ac012cdf))
* JSON parsing error in trusted data policy evaluation on Jan.ai ([#624](https://github.com/archestra-ai/archestra/issues/624)) ([b5f70f5](https://github.com/archestra-ai/archestra/commit/b5f70f519ee163d6e6ddc1017638a300a6a98912))
