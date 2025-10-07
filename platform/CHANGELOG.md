# Changelog

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
