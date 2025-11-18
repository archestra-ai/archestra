# Changelog

## [0.6.4](https://github.com/archestra-ai/archestra/compare/platform-v0.6.3...platform-v0.6.4) (2025-11-18)


### Features

* add ability to select all models in the cost limiter ([#1146](https://github.com/archestra-ai/archestra/issues/1146)) ([3618108](https://github.com/archestra-ai/archestra/commit/3618108c6cef0212f059a5bcb6e7b848927cdb76))
* update `CLAUDE.md` ([#1168](https://github.com/archestra-ai/archestra/issues/1168)) ([0e5f764](https://github.com/archestra-ai/archestra/commit/0e5f764af7bff4e7b340acff5527b1a05a229a60))


### Bug Fixes

* address several (more) N+1 queries ([#1181](https://github.com/archestra-ai/archestra/issues/1181)) ([ffdc56d](https://github.com/archestra-ai/archestra/commit/ffdc56d6a4741300a29a91c8c5ebaa542a1dee34))
* MCP install dropdown in logs dialog ([#1176](https://github.com/archestra-ai/archestra/issues/1176)) ([6607040](https://github.com/archestra-ai/archestra/commit/66070400673b115fdf753b5004815e0f00041afa))
* otel exporter (when using Sentry) + parallelize consecutive DB queries in 2 spots ([#1184](https://github.com/archestra-ai/archestra/issues/1184)) ([c93807b](https://github.com/archestra-ai/archestra/commit/c93807b69f3121e644181e64ef982c8be6a155a2))
* several N+1 query performance issues ([#1170](https://github.com/archestra-ai/archestra/issues/1170)) ([47ccf91](https://github.com/archestra-ai/archestra/commit/47ccf918bb654866217c7d35e11a98caa0a6e696))
* show full error in chat ([#1157](https://github.com/archestra-ai/archestra/issues/1157)) ([e10928b](https://github.com/archestra-ai/archestra/commit/e10928b5857b2d5529928c157bb1c36ad66d577b))
* show mcp server errors ([#1175](https://github.com/archestra-ai/archestra/issues/1175)) ([20e555b](https://github.com/archestra-ai/archestra/commit/20e555b8ac3c1d8639a76478bf2affbdf599904e))
* show tool output errors ([#1174](https://github.com/archestra-ai/archestra/issues/1174)) ([92cbbb2](https://github.com/archestra-ai/archestra/commit/92cbbb23558cd2f566dbba9f1cef9fdb3beb06f2))
* use first 15 characters of first message as chat fallback title ([#1177](https://github.com/archestra-ai/archestra/issues/1177)) ([bbaa1f9](https://github.com/archestra-ai/archestra/commit/bbaa1f9de86e794c00daf5bd44dcf1ee56d042db))


### Miscellaneous Chores

* **deps:** bump glob from 10.4.5 to 10.5.0 in /platform/examples/mastra-ai ([#1180](https://github.com/archestra-ai/archestra/issues/1180)) ([ee6ed8c](https://github.com/archestra-ai/archestra/commit/ee6ed8ce95cd6eccb6434087fe47d1c77d0348de))
* generated docs ([#1171](https://github.com/archestra-ai/archestra/issues/1171)) ([20ff591](https://github.com/archestra-ai/archestra/commit/20ff591b60b57afa9215a5f85e4a13e16ccbeded))
* implement filtering by credential ([#1147](https://github.com/archestra-ai/archestra/issues/1147)) ([52e0e64](https://github.com/archestra-ai/archestra/commit/52e0e64dca6d8c4d9520fc8606fa7f29bf099d13))
* several performance improvements + make `/tools` filters searchable ([#1183](https://github.com/archestra-ai/archestra/issues/1183)) ([1c770dc](https://github.com/archestra-ai/archestra/commit/1c770dcabaf1e4a87f91617beb9dd65109efe686))

## [0.6.3](https://github.com/archestra-ai/archestra/compare/platform-v0.6.2...platform-v0.6.3) (2025-11-18)


### Bug Fixes

* chat system prompt update deselection bug ([#1163](https://github.com/archestra-ai/archestra/issues/1163)) ([f2cd147](https://github.com/archestra-ai/archestra/commit/f2cd14764a856bfa8b5f30188d907e7f4dd9d9ac))


### Dependencies

* bump 27 platform dependencies ([#1162](https://github.com/archestra-ai/archestra/issues/1162)) ([c1399c4](https://github.com/archestra-ai/archestra/commit/c1399c4fbd3dae644ecd8d06ee63a0b1e7c38474))
* bump the platform-dependencies group across 1 directory with 3 updates ([#1166](https://github.com/archestra-ai/archestra/issues/1166)) ([f107469](https://github.com/archestra-ai/archestra/commit/f107469d48a7262dbe1a85d5c6034d6915f3703f))

## [0.6.2](https://github.com/archestra-ai/archestra/compare/platform-v0.6.1...platform-v0.6.2) (2025-11-17)


### Bug Fixes

* hide graph data from table in Costs &gt; Statistics ([#1156](https://github.com/archestra-ai/archestra/issues/1156)) ([81dc952](https://github.com/archestra-ai/archestra/commit/81dc9521c807fcf221deb8ed261d3cea27fcfc6c))
* increase timeout to fix network error during chat ([#1154](https://github.com/archestra-ai/archestra/issues/1154)) ([b177c7f](https://github.com/archestra-ai/archestra/commit/b177c7f5fa73b0c71fe071445031393f25265317))
* MCP server tools calls don't work with error: Not connected ([#1153](https://github.com/archestra-ai/archestra/issues/1153)) ([3e2c25b](https://github.com/archestra-ai/archestra/commit/3e2c25b97bfe089c7cd09978f993050ff656f72f))
* sidebar menu item tooltip on top ([#1151](https://github.com/archestra-ai/archestra/issues/1151)) ([90b617f](https://github.com/archestra-ai/archestra/commit/90b617f21aed2f6659ebb4f93d8064046a2b5362))
* timeframes ([#1158](https://github.com/archestra-ai/archestra/issues/1158)) ([cf63de4](https://github.com/archestra-ai/archestra/commit/cf63de4c8f7b13a3eec777452c475e24b1753763))
* tool policy toggle in dialog ([#1148](https://github.com/archestra-ai/archestra/issues/1148)) ([fb021a0](https://github.com/archestra-ai/archestra/commit/fb021a0d4a3f85bfb7421c624665045d036f887a))

## [0.6.1](https://github.com/archestra-ai/archestra/compare/platform-v0.6.0...platform-v0.6.1) (2025-11-17)


### Bug Fixes

* show mcp installation failures ([#1144](https://github.com/archestra-ai/archestra/issues/1144)) ([62fcfb7](https://github.com/archestra-ai/archestra/commit/62fcfb78542e6b4d69af589f23229cbd6fb0cf3f))

## [0.6.0](https://github.com/archestra-ai/archestra/compare/platform-v0.5.0...platform-v0.6.0) (2025-11-17)


### Features

* add `use_in_chat` checkbox to agent profile create/edit forms ([#1129](https://github.com/archestra-ai/archestra/issues/1129)) ([0fa6817](https://github.com/archestra-ai/archestra/commit/0fa68177cdf63804d9e81e526a848c55280047b1))
* add refresh functionality to McpLogsDialog ([#1043](https://github.com/archestra-ai/archestra/issues/1043)) ([ef3c140](https://github.com/archestra-ai/archestra/commit/ef3c1405825e51e83afe020632a47eb8eeb5ea14))


### Bug Fixes

* fix form validation that blocks adding remote server ([#1140](https://github.com/archestra-ai/archestra/issues/1140)) ([a90c965](https://github.com/archestra-ai/archestra/commit/a90c96585c4dc437857923083eda8a66b151ff4a))
* RBAC issues ([#1138](https://github.com/archestra-ai/archestra/issues/1138)) ([b2d990a](https://github.com/archestra-ai/archestra/commit/b2d990a8bc1949924594ad2d4eef24a29403c881)), closes [#1103](https://github.com/archestra-ai/archestra/issues/1103)
* remove unnecessary limit check from frontend ([#1133](https://github.com/archestra-ai/archestra/issues/1133)) ([ac25c34](https://github.com/archestra-ai/archestra/commit/ac25c34744bf6b0be8ccf3c9f544de7bd415f12d))
* token pricing rule update ordering behavior ([#1127](https://github.com/archestra-ai/archestra/issues/1127)) ([db25141](https://github.com/archestra-ai/archestra/commit/db251411147ffd200d568318bc0067f18283fcf6))

## [0.5.0](https://github.com/archestra-ai/archestra/compare/platform-v0.4.1...platform-v0.5.0) (2025-11-14)


### Features

* add more filtering to tools table (+ polish `/tools` UX) ([#1079](https://github.com/archestra-ai/archestra/issues/1079)) ([8349630](https://github.com/archestra-ai/archestra/commit/834963087d8ea6ecc1e38fa05c8edfcab031278b))
* trust archestra mcp server tools by default + don't show in tools table ([#1114](https://github.com/archestra-ai/archestra/issues/1114)) ([06cc33b](https://github.com/archestra-ai/archestra/commit/06cc33b828c1dad1872c8a8c6e3486d3ce1fe6df))


### Bug Fixes

* "Failed to create K8s Secret" on backend initialization ([#1091](https://github.com/archestra-ai/archestra/issues/1091)) ([954d337](https://github.com/archestra-ai/archestra/commit/954d337ef66d9fff08c4fa81bdae2c537bb330e6))
* 400 error due to agent tool filtering by archestra tools ([#1118](https://github.com/archestra-ai/archestra/issues/1118)) ([62fde5e](https://github.com/archestra-ai/archestra/commit/62fde5e7c60d5ad448ffa74e877f429884cb627a))
* fix mcp ([#1121](https://github.com/archestra-ai/archestra/issues/1121)) ([334f444](https://github.com/archestra-ai/archestra/commit/334f444e1e058a5d488c035f6c8f01c73ab6b78b))
* fix refetching local mcp server logs ([#1115](https://github.com/archestra-ai/archestra/issues/1115)) ([6b0a068](https://github.com/archestra-ai/archestra/commit/6b0a06861e5a4f710cb2b7767c793c3db8a49a4d))
* fix sorting of catalog items ([#1098](https://github.com/archestra-ai/archestra/issues/1098)) ([c2a7c8c](https://github.com/archestra-ai/archestra/commit/c2a7c8c16ecd56188904c3f3cd29beca7528bfa6))
* fix tools filtering on the frontend ([#1096](https://github.com/archestra-ai/archestra/issues/1096)) ([3cbe42b](https://github.com/archestra-ai/archestra/commit/3cbe42b586979715cbaea319554ce2d366b2eb0c))
* mcp client sessions ([#1122](https://github.com/archestra-ai/archestra/issues/1122)) ([417bdb5](https://github.com/archestra-ai/archestra/commit/417bdb5f6081a22eb34017e2c0d770d996f7ffbf))
* mcp server tools don't exist in the chat ([#1120](https://github.com/archestra-ai/archestra/issues/1120)) ([4be837c](https://github.com/archestra-ai/archestra/commit/4be837c74ed3a059e62ef66887fd8e0c28927074))
* polish MCP Gateway logs table ([#1100](https://github.com/archestra-ai/archestra/issues/1100)) ([da8f2a5](https://github.com/archestra-ai/archestra/commit/da8f2a5abf09bb89506482e3d735f2a365c00551))
* show reinstall only if current user has connected to mcp server ([#1099](https://github.com/archestra-ai/archestra/issues/1099)) ([f5df4c1](https://github.com/archestra-ai/archestra/commit/f5df4c125877701e93050255eacd337a1c786b02))
* vertical scrolling bug affecting many pages ([#1089](https://github.com/archestra-ai/archestra/issues/1089)) ([fcd2b07](https://github.com/archestra-ai/archestra/commit/fcd2b07a50bcc83c97212dbf5fe9eaea21333e75))

## [0.4.1](https://github.com/archestra-ai/archestra/compare/platform-v0.4.0...platform-v0.4.1) (2025-11-13)


### Bug Fixes

* fix mcp installation counters ([#1081](https://github.com/archestra-ai/archestra/issues/1081)) ([c920bd1](https://github.com/archestra-ai/archestra/commit/c920bd1469826855afd052f419c14ec4c1f7a4df))
* fix policy evaluation ([#1086](https://github.com/archestra-ai/archestra/issues/1086)) ([5c32dbe](https://github.com/archestra-ai/archestra/commit/5c32dbee6d9701d849f0f717a482577fb6918cdb))
* fix showing authenticated users ([#1078](https://github.com/archestra-ai/archestra/issues/1078)) ([46463ed](https://github.com/archestra-ai/archestra/commit/46463edc6d2531cc02c742abc1e2bd9ffceb0e31))
* newly assigned tools not in chat ([#1083](https://github.com/archestra-ai/archestra/issues/1083)) ([dc1d364](https://github.com/archestra-ai/archestra/commit/dc1d364e352244869805a2c6c34b0c8603da49d8))
* no optimization rules in seed ([#1068](https://github.com/archestra-ai/archestra/issues/1068)) ([162458e](https://github.com/archestra-ai/archestra/commit/162458ea686e3c8079ff36f0ca103c1df4f0bfad))
* protect route by default ([#1063](https://github.com/archestra-ai/archestra/issues/1063)) ([3385ff0](https://github.com/archestra-ai/archestra/commit/3385ff07c2221cb4c1c1f0d1ac9fabe92ccb6440))
* require agent selection to pick the credential ([#1080](https://github.com/archestra-ai/archestra/issues/1080)) ([744c176](https://github.com/archestra-ai/archestra/commit/744c17619db18947c0cee7a309f8331856e53e8f))
* seed Archestra MCP tools and assign ([#1073](https://github.com/archestra-ai/archestra/issues/1073)) ([8bec6df](https://github.com/archestra-ai/archestra/commit/8bec6dfd5a1f006e45af88d9ab5bba7ab0c34de2))
* show all action buttons in agent table ([#1074](https://github.com/archestra-ai/archestra/issues/1074)) ([6aa7265](https://github.com/archestra-ai/archestra/commit/6aa7265db313c7fc303d5f262d3fc4a19007d10d))
* show loading indicator when streaming ([#1065](https://github.com/archestra-ai/archestra/issues/1065)) ([79ac80d](https://github.com/archestra-ai/archestra/commit/79ac80d1916a098aa142f46bbc230d9caaaaf0a0))

## [0.4.0](https://github.com/archestra-ai/archestra/compare/platform-v0.3.2...platform-v0.4.0) (2025-11-12)


### Features

* agent setting to treat user prompts as untrusted ([#1067](https://github.com/archestra-ai/archestra/issues/1067)) ([6557c61](https://github.com/archestra-ai/archestra/commit/6557c61a354629cbe2aeeceba3cc300ae29d4910))
* LLM cost optimization, OpenAI & Anthropic ([#1017](https://github.com/archestra-ai/archestra/issues/1017)) ([16930c1](https://github.com/archestra-ai/archestra/commit/16930c1bcf0002858e85e1a952ff57e768669873))


### Bug Fixes

* chat prompts assignment UI state management bug ([#1055](https://github.com/archestra-ai/archestra/issues/1055)) ([4e5f393](https://github.com/archestra-ai/archestra/commit/4e5f39351781418b72c65de46a0192877c19cd5a))
* don't throw from api client ([#1033](https://github.com/archestra-ai/archestra/issues/1033)) ([28b818f](https://github.com/archestra-ai/archestra/commit/28b818f8c8fe73f3017b568e0ccc69a2c47dbaa0))
* if just 1 token select by default ([#1066](https://github.com/archestra-ai/archestra/issues/1066)) ([41c57cb](https://github.com/archestra-ai/archestra/commit/41c57cb1f1d7a58803cb6bdf8fe9607e7b8bb105))
* show vercel ai errors ([#1064](https://github.com/archestra-ai/archestra/issues/1064)) ([3b767a2](https://github.com/archestra-ai/archestra/commit/3b767a2731331b32e19469195c0f68733e02145b))

## [0.3.2](https://github.com/archestra-ai/archestra/compare/platform-v0.3.1...platform-v0.3.2) (2025-11-11)


### Bug Fixes

* tool calling doesn't work when server name is uppercase ([#1052](https://github.com/archestra-ai/archestra/issues/1052)) ([e19b938](https://github.com/archestra-ai/archestra/commit/e19b9386e96a897a00c5b6a61abc4ae3bf14ecc2))

## [0.3.1](https://github.com/archestra-ai/archestra/compare/platform-v0.3.0...platform-v0.3.1) (2025-11-11)


### Bug Fixes

* add secret to role in helm ([#1050](https://github.com/archestra-ai/archestra/issues/1050)) ([034ba9e](https://github.com/archestra-ai/archestra/commit/034ba9ec4a3b403caf3c7c01534a420a9dcaa333))
* bulk assign tools 2 agent endpoint ([#1045](https://github.com/archestra-ai/archestra/issues/1045)) ([825f513](https://github.com/archestra-ai/archestra/commit/825f51302e7d1fb8b48e29fdf1e4c73d723fb3b6))

## [0.3.0](https://github.com/archestra-ai/archestra/compare/platform-v0.2.1...platform-v0.3.0) (2025-11-11)


### Features

* `archestra__create_agent` MCP gateway tool ([#1041](https://github.com/archestra-ai/archestra/issues/1041)) ([440013e](https://github.com/archestra-ai/archestra/commit/440013e139ce00e91714bac08a1c83a7b9299974))
* add cost limit token-usage Archestra MCP server tools ([#1044](https://github.com/archestra-ai/archestra/issues/1044)) ([ce55edb](https://github.com/archestra-ai/archestra/commit/ce55edbab426d04775c9ead98ef12a043dcf643d))
* add orchestrator-k8s-runtime feature flag ([#1031](https://github.com/archestra-ai/archestra/issues/1031)) ([0164614](https://github.com/archestra-ai/archestra/commit/01646149d01f175fcfde25de8c322995bc372bdd))


### Bug Fixes

* cleanup ([#1038](https://github.com/archestra-ai/archestra/issues/1038)) ([b7cb8bf](https://github.com/archestra-ai/archestra/commit/b7cb8bf62c92c83c5d155ba5042292c3a372dc84))
* update Helm health checks to use backend `/health` endpoint ([#1042](https://github.com/archestra-ai/archestra/issues/1042)) ([3f49b68](https://github.com/archestra-ai/archestra/commit/3f49b68c823f4bf3a2a4f1342b5c310776dd818e))


### Dependencies

* **platform:** bump the platform-dependencies group in /platform with 25 updates ([#1032](https://github.com/archestra-ai/archestra/issues/1032)) ([22397c5](https://github.com/archestra-ai/archestra/commit/22397c5dc89f95b241bd9b0d8fbcf30804dfea63))

## [0.2.1](https://github.com/archestra-ai/archestra/compare/platform-v0.2.0...platform-v0.2.1) (2025-11-10)


### Bug Fixes

* agents table pagination issue  ([#1030](https://github.com/archestra-ai/archestra/issues/1030)) ([252d76f](https://github.com/archestra-ai/archestra/commit/252d76f06000269e2e2b13bd06fe59a480e8284a))
* comment out onboarding for now ([#1028](https://github.com/archestra-ai/archestra/issues/1028)) ([2448c03](https://github.com/archestra-ai/archestra/commit/2448c032223ec367bc5bb3fecd7c71f25b5ef5e6))
* improve prompts ([#1034](https://github.com/archestra-ai/archestra/issues/1034)) ([fc4fb0a](https://github.com/archestra-ai/archestra/commit/fc4fb0a620547df5cf0cebef2dc5c0247d50f62c))
* initial state of chat promt suggestions ([#1027](https://github.com/archestra-ai/archestra/issues/1027)) ([151d53a](https://github.com/archestra-ai/archestra/commit/151d53a811b25ce883f8c391b11e41d1f6115181))
* mcp server type migration ([#1024](https://github.com/archestra-ai/archestra/issues/1024)) ([23e209b](https://github.com/archestra-ai/archestra/commit/23e209b43127a41f1f639d0294e1fb8341ca5f05))
* mcp tools discovery fix ([#1035](https://github.com/archestra-ai/archestra/issues/1035)) ([c5d5a6f](https://github.com/archestra-ai/archestra/commit/c5d5a6f074ab0a1ba26419226785b7ae16744b34))
* show more actionable error message for expired invitation links ([#1026](https://github.com/archestra-ai/archestra/issues/1026)) ([aa3d2c5](https://github.com/archestra-ai/archestra/commit/aa3d2c5e1c63366e71cfcbf4640b611f4b84fdf5))

## [0.2.0](https://github.com/archestra-ai/archestra/compare/platform-v0.1.0...platform-v0.2.0) (2025-11-10)


### Features

* add onboarding and log all mcp gateway calls ([#965](https://github.com/archestra-ai/archestra/issues/965)) ([826d592](https://github.com/archestra-ai/archestra/commit/826d59245038649a7ee7cb4c094f5edd4d127cfb))
* add per agent chat ([#1008](https://github.com/archestra-ai/archestra/issues/1008)) ([fbadc6f](https://github.com/archestra-ai/archestra/commit/fbadc6ff075bf7f56e6bcae940e063d7e29e8291))
* custom RBAC roles ([#988](https://github.com/archestra-ai/archestra/issues/988)) ([8bd43b6](https://github.com/archestra-ai/archestra/commit/8bd43b6fc982df4fed6cf42dc10303cc42961bd8))
* prompt library and chat settings ([#1011](https://github.com/archestra-ai/archestra/issues/1011)) ([94a860c](https://github.com/archestra-ai/archestra/commit/94a860c125947f0472a26e3eeded27cb0abb7690))
* remove LLM proxy auto-execution, fix bugs around mcp tool calling ([#1000](https://github.com/archestra-ai/archestra/issues/1000)) ([f8d8742](https://github.com/archestra-ai/archestra/commit/f8d8742b1310847bfe8256b379546a376495e5ed))


### Bug Fixes

* add feature flag to disable teams auth ([#1022](https://github.com/archestra-ai/archestra/issues/1022)) ([0fafd4a](https://github.com/archestra-ai/archestra/commit/0fafd4af27838035b10d609db7c76c8b8de8203b))
* add new permissions to chat routes ([#1009](https://github.com/archestra-ai/archestra/issues/1009)) ([83bc70c](https://github.com/archestra-ai/archestra/commit/83bc70c7e87a6f7aa6ea71225fc56d8fc4561c6e))
* clean up internal JWT removal ([#1015](https://github.com/archestra-ai/archestra/issues/1015)) ([5afb093](https://github.com/archestra-ai/archestra/commit/5afb093103c2acfcd9907503121f4b1e348002dc))
* fix agents table pagination bug ([#1020](https://github.com/archestra-ai/archestra/issues/1020)) ([23e4d42](https://github.com/archestra-ai/archestra/commit/23e4d42d382409730b2ede16c69513bc810c7031))
* n8n server tool discovery and other minor improvements ([#1018](https://github.com/archestra-ai/archestra/issues/1018)) ([a74db71](https://github.com/archestra-ai/archestra/commit/a74db715ec7cb6777bbddaa4d8eee640a8161314))
* small chat bugs ([#1014](https://github.com/archestra-ai/archestra/issues/1014)) ([3d9e1e8](https://github.com/archestra-ai/archestra/commit/3d9e1e80cd8ddde92557a94f72d9684d56db9de7))


### Code Refactoring

* change executeToolCalls to executeToolCall ([#1001](https://github.com/archestra-ai/archestra/issues/1001)) ([32d426b](https://github.com/archestra-ai/archestra/commit/32d426b8ddca5ec13ad8df8ad9575d2740520441))
* cleanup unused code after mcp client refactoring ([#1007](https://github.com/archestra-ai/archestra/issues/1007)) ([d6d978b](https://github.com/archestra-ai/archestra/commit/d6d978bc1192fa14b80e734abe8c65b9564fe3aa))
* mcp client ([#1005](https://github.com/archestra-ai/archestra/issues/1005)) ([6a290ab](https://github.com/archestra-ai/archestra/commit/6a290abb006f58e623f2db361022f0a3b1d2999c))

## [0.1.0](https://github.com/archestra-ai/archestra/compare/platform-v0.0.30...platform-v0.1.0) (2025-11-07)


### Features

* add `archestra.envFromSecrets` + `archestra.envFrom` to Helm values ([#979](https://github.com/archestra-ai/archestra/issues/979)) ([6050461](https://github.com/archestra-ai/archestra/commit/6050461c763569756a58f57ab871269414353d31))
* add Archestra MCP server ([#990](https://github.com/archestra-ai/archestra/issues/990)) ([563a9ee](https://github.com/archestra-ai/archestra/commit/563a9eef75bbf2601aae735eb6562fa14c53da89))
* add TOTP 2FA support using better-auth ([#987](https://github.com/archestra-ai/archestra/issues/987)) ([ceb602b](https://github.com/archestra-ai/archestra/commit/ceb602bc57332a995e24dce3c81e8b6d5d1f5492))
* agent labels in tracing and metrics ([#961](https://github.com/archestra-ai/archestra/issues/961)) ([2ef9137](https://github.com/archestra-ai/archestra/commit/2ef913761e8c4c7e83f4f1844c34bf465fe69840))
* autogenerate auth secret in Helm chart & Dockerfile ([#995](https://github.com/archestra-ai/archestra/issues/995)) ([1e3c38d](https://github.com/archestra-ai/archestra/commit/1e3c38d6f9abf2daf5324754f9a574ee3b5b6e5a))
* chat via proxy ([#968](https://github.com/archestra-ai/archestra/issues/968)) ([1f8d71f](https://github.com/archestra-ai/archestra/commit/1f8d71f06546a614396bec47405c0a87979ba291))
* expose otlp auth environment variable ([#975](https://github.com/archestra-ai/archestra/issues/975)) ([f1e70fd](https://github.com/archestra-ai/archestra/commit/f1e70fdfc65101acd1749a831639a4d16a7cae53))
* HTTP request and DB observability ([#974](https://github.com/archestra-ai/archestra/issues/974)) ([524feb3](https://github.com/archestra-ai/archestra/commit/524feb348a0b4e98ea32555eeb16bc3bcbb281de))
* local servers - support catalog, credentials management, unify ui/ux ([#963](https://github.com/archestra-ai/archestra/issues/963)) ([0df7e81](https://github.com/archestra-ai/archestra/commit/0df7e815a3bc0dcb223e74adcd5dc92b594fd1ed))
* skip "internal" postgres startup when using external database ([#960](https://github.com/archestra-ai/archestra/issues/960)) ([08be5a3](https://github.com/archestra-ai/archestra/commit/08be5a31a62a7733cf9c91bc5f9c4ee16c413a9c))


### Bug Fixes

* add consistent spacing between sections on settings/account page ([#952](https://github.com/archestra-ai/archestra/issues/952)) ([05b08f0](https://github.com/archestra-ai/archestra/commit/05b08f0ee0327e33638f3aa51ec1bd94b888d512))
* always pass `args` to mcp pod, even if using custom docker image ([#964](https://github.com/archestra-ai/archestra/issues/964)) ([711906b](https://github.com/archestra-ai/archestra/commit/711906b71ce23e71caed8efc9a2e8797e96a48c8))
* create/edit agents dialog label key handling ([#962](https://github.com/archestra-ai/archestra/issues/962)) ([6734114](https://github.com/archestra-ai/archestra/commit/6734114c4b6355e131d97a6734ad1489fc4282ae))
* expose all HTTP routes for metrics exposed by `/metrics` ([#986](https://github.com/archestra-ai/archestra/issues/986)) ([24fa0a2](https://github.com/archestra-ai/archestra/commit/24fa0a2327f34180d45e9ea38a691da5952bc898))
* fix auth on webkit ([#972](https://github.com/archestra-ai/archestra/issues/972)) ([abac193](https://github.com/archestra-ai/archestra/commit/abac19332207d628fdd8ca4859df611131719035))
* issue when assigning non RFC1123 compliant `metadata.labels` to K8s pod ([#954](https://github.com/archestra-ai/archestra/issues/954)) ([0f7969b](https://github.com/archestra-ai/archestra/commit/0f7969be5e69faec49dcc7202aeb04a0f357043e))
* remove auth bypass for /mcp_proxy ([#992](https://github.com/archestra-ai/archestra/issues/992)) ([a5a4efa](https://github.com/archestra-ai/archestra/commit/a5a4efa990efcd744a58b1029cf26c94c7a59a09))
* setting `ARCHESTRA_API_BASE_URL` in Docker image's `supervisord` config for the `backend` process ([#956](https://github.com/archestra-ai/archestra/issues/956)) ([6b8eaf4](https://github.com/archestra-ai/archestra/commit/6b8eaf47f151443c73391fbb8cf3cd8a2b80a871))
* typo in `supervisord` config ([#957](https://github.com/archestra-ai/archestra/issues/957)) ([305e17d](https://github.com/archestra-ai/archestra/commit/305e17d8a2334d26ecba6f6cacb67c0e374cb939))
* typo in `supervisord` environment variable config in Dockerfile ([#958](https://github.com/archestra-ai/archestra/issues/958)) ([c34e626](https://github.com/archestra-ai/archestra/commit/c34e626cb60543f44a23708e572adc049a5e199a))
* update grafana dashboard -- add variables to select metrics/traces datasources ([#984](https://github.com/archestra-ai/archestra/issues/984)) ([9760478](https://github.com/archestra-ai/archestra/commit/976047817c63453066ad47d4f58ac220ef0b6cfc))

## [0.0.30](https://github.com/archestra-ai/archestra/compare/platform-v0.0.29...platform-v0.0.30) (2025-11-04)


### Features

* agents search, sorting, pagination ([#937](https://github.com/archestra-ai/archestra/issues/937)) ([b099eb7](https://github.com/archestra-ai/archestra/commit/b099eb7e510d67f6c686ce0121b702697462cb1f))


### Bug Fixes

* easter egg + simplify `DATABASE_URL` logic in `platform/Dockerfile` ([#947](https://github.com/archestra-ai/archestra/issues/947)) ([ec77224](https://github.com/archestra-ai/archestra/commit/ec77224e66ab3204d1b1cfecacad4b166a303e1c))
* ensure `K8sPod.slugifyMcpServerName` generates valid Kubernetes DNS subdomain names ([#950](https://github.com/archestra-ai/archestra/issues/950)) ([60a20f9](https://github.com/archestra-ai/archestra/commit/60a20f9018c49f9e12a54a253815cb091bcde0a5))
* environment variable bug in MCP server dialog creation ([#946](https://github.com/archestra-ai/archestra/issues/946)) ([ba50fba](https://github.com/archestra-ai/archestra/commit/ba50fba90743a556ff06f0c5232e2f56ee28dd37))
* show "No teams available" instead of "All teams are already assigned" when no teams exist ([#945](https://github.com/archestra-ai/archestra/issues/945)) ([97fb7bf](https://github.com/archestra-ai/archestra/commit/97fb7bfa8439acc0d0430ac6c21a578551292973))
* ui vertical scroll cut-off in add mcp server dialog ([#938](https://github.com/archestra-ai/archestra/issues/938)) ([a91b576](https://github.com/archestra-ai/archestra/commit/a91b5768bdbeadc40e77bcf89f448ee02b3ac9e4))


### Dependencies

* **platform:** bump react-syntax-highlighter from 15.6.6 to 16.1.0 in /platform ([#941](https://github.com/archestra-ai/archestra/issues/941)) ([f39ba42](https://github.com/archestra-ai/archestra/commit/f39ba4265f9e559520af1fcf3ae626ff2d74f6ab))
* **platform:** bump the platform-dependencies group in /platform with 24 updates ([#940](https://github.com/archestra-ai/archestra/issues/940)) ([1f651b5](https://github.com/archestra-ai/archestra/commit/1f651b5619aaa35e13c53faada2bcfd84d37fc57))

## [0.0.29](https://github.com/archestra-ai/archestra/compare/platform-v0.0.28...platform-v0.0.29) (2025-11-03)


### Bug Fixes

* add missing `Service` RBAC permissions to k8s `ServiceAccount` ([#934](https://github.com/archestra-ai/archestra/issues/934)) ([8a2cb52](https://github.com/archestra-ai/archestra/commit/8a2cb5217638240fb50cbf57cf6bed86635adef2))

## [0.0.28](https://github.com/archestra-ai/archestra/compare/platform-v0.0.27...platform-v0.0.28) (2025-11-03)


### Features

* fixed size dialog and better isntructions ([#931](https://github.com/archestra-ai/archestra/issues/931)) ([bd279e9](https://github.com/archestra-ai/archestra/commit/bd279e9b563da08c3f32efa68d595918d63f38eb))
* traces panels ([#930](https://github.com/archestra-ai/archestra/issues/930)) ([2fb5d32](https://github.com/archestra-ai/archestra/commit/2fb5d3212c934b5ceb0de16f53badcc943db56ec))


### Bug Fixes

* minor, make tilt restart pnpm-dev after db clean or migrate ([#932](https://github.com/archestra-ai/archestra/issues/932)) ([b2d3d6f](https://github.com/archestra-ai/archestra/commit/b2d3d6f7e86f7ed19d10d0abcfbbac397ba54fb3))

## [0.0.27](https://github.com/archestra-ai/archestra/compare/platform-v0.0.26...platform-v0.0.27) (2025-11-03)


### Bug Fixes

* fix theme settings ([#926](https://github.com/archestra-ai/archestra/issues/926)) ([fec48dd](https://github.com/archestra-ai/archestra/commit/fec48dd8498bd7e86811d573cbdc4168c75ad782))

## [0.0.26](https://github.com/archestra-ai/archestra/compare/platform-v0.0.25...platform-v0.0.26) (2025-11-03)


### Features

* move chat from desktop_app to platform ([#888](https://github.com/archestra-ai/archestra/issues/888)) ([abc15d7](https://github.com/archestra-ai/archestra/commit/abc15d7061987ba4cbcd61823bd505b0bf654bee))

## [0.0.25](https://github.com/archestra-ai/archestra/compare/platform-v0.0.24...platform-v0.0.25) (2025-11-03)


### Features

* add grafana dashboard ([#924](https://github.com/archestra-ai/archestra/issues/924)) ([51da831](https://github.com/archestra-ai/archestra/commit/51da831efeccfc8a93ff9dd7d4e5aac3c8c8c675))
* cost and limits ([#919](https://github.com/archestra-ai/archestra/issues/919)) ([9888847](https://github.com/archestra-ai/archestra/commit/9888847dafdf1ba629772eb6a97edefc2aa96d0c))

## [0.0.24](https://github.com/archestra-ai/archestra/compare/platform-v0.0.23...platform-v0.0.24) (2025-11-03)


### Bug Fixes

* size/alignment of custom logo ([#917](https://github.com/archestra-ai/archestra/issues/917)) ([540121b](https://github.com/archestra-ai/archestra/commit/540121b65215aeb90faf33fa9e7fae410f8b2209))

## [0.0.23](https://github.com/archestra-ai/archestra/compare/platform-v0.0.22...platform-v0.0.23) (2025-11-03)


### Bug Fixes

* next.js hydration error ([#911](https://github.com/archestra-ai/archestra/issues/911)) ([5d7fe04](https://github.com/archestra-ai/archestra/commit/5d7fe04522d7e5775fe7e3c970e43a7a18b796a9))

## [0.0.22](https://github.com/archestra-ai/archestra/compare/platform-v0.0.21...platform-v0.0.22) (2025-11-03)


### Features

* 🐰 🥚 ([#910](https://github.com/archestra-ai/archestra/issues/910)) ([23d278d](https://github.com/archestra-ai/archestra/commit/23d278d8b10aadc7a445d459299b2567bc67cfeb))
* add labels support to agents ([#875](https://github.com/archestra-ai/archestra/issues/875)) ([4d106a7](https://github.com/archestra-ai/archestra/commit/4d106a7a6104f0c34ee50c16a1841aed2cc5a416))
* add Logs to MCP server actions dropdown ([#904](https://github.com/archestra-ai/archestra/issues/904)) ([590cd70](https://github.com/archestra-ai/archestra/commit/590cd70aa26a0f95f5c48f5b726dbb1c40468761))
* add optional `Ingress` to helm chart + ability to specify `Service` annotations ([#900](https://github.com/archestra-ai/archestra/issues/900)) ([c57c8e0](https://github.com/archestra-ai/archestra/commit/c57c8e0af3402439fb4ef888fc24e5ab621c05bc))
* add server error handling for auth pages ([#890](https://github.com/archestra-ai/archestra/issues/890)) ([127d9ea](https://github.com/archestra-ai/archestra/commit/127d9eaaac4434209b6d256c5552ad2b34fae3a6))
* enable log streaming in Kubernetes pod logs ([#907](https://github.com/archestra-ai/archestra/issues/907)) ([c9808cc](https://github.com/archestra-ai/archestra/commit/c9808cc8cc8e7376960d113f452d680d9e0c6222))
* make command optional when docker image is specified for local mcp ([#882](https://github.com/archestra-ai/archestra/issues/882)) ([ced8a00](https://github.com/archestra-ai/archestra/commit/ced8a00a6dea2a34f1d748b1a5fac7d03fa70993))
* MCP credentials management ([#843](https://github.com/archestra-ai/archestra/issues/843)) ([e55c86b](https://github.com/archestra-ai/archestra/commit/e55c86bcb6f5e5243802cfc650edda5c35f66ecf))
* store model and tokens separately ([#902](https://github.com/archestra-ai/archestra/issues/902)) ([d2ecdf1](https://github.com/archestra-ai/archestra/commit/d2ecdf15d3f2805827f94c5e185613917890cc18))
* update otel traces + prometheus metrics to include agent data ([#887](https://github.com/archestra-ai/archestra/issues/887)) ([95b7e56](https://github.com/archestra-ai/archestra/commit/95b7e5647a673c203fd42c1d94d5579030b9d2cb))
* white-labeling and theme customization ([#909](https://github.com/archestra-ai/archestra/issues/909)) ([14d97b9](https://github.com/archestra-ai/archestra/commit/14d97b93841c1a97581271bca038dc02c03b48be))


### Bug Fixes

* double-quoting of env vars in MCP server form ([#892](https://github.com/archestra-ai/archestra/issues/892)) ([4f56e23](https://github.com/archestra-ai/archestra/commit/4f56e23cdd70c8aea04cfc8992a0dc836a04a333))
* in mcp server card, show transport type pill ([#885](https://github.com/archestra-ai/archestra/issues/885)) ([8a577eb](https://github.com/archestra-ai/archestra/commit/8a577eb212b0c380f1e8d32e61fd40300c1f39a1))
* MCP server install button disable behavior ([#891](https://github.com/archestra-ai/archestra/issues/891)) ([10ed854](https://github.com/archestra-ai/archestra/commit/10ed8540f5ac532bd3eeae166b50f4eb765c8272))
* return agent labels in sorted (consistent) order ([#894](https://github.com/archestra-ai/archestra/issues/894)) ([8d680df](https://github.com/archestra-ai/archestra/commit/8d680dfe6da3017aa0b896cb8371d5ef3de61bd5))

## [0.0.21](https://github.com/archestra-ai/archestra/compare/platform-v0.0.20...platform-v0.0.21) (2025-10-31)


### Features

* support streamable http for local mcp servers ([#871](https://github.com/archestra-ai/archestra/issues/871)) ([ebbc311](https://github.com/archestra-ai/archestra/commit/ebbc311c304619fbbe067d1ac8878822adfe9160))
* unified logging + env var to set logging ([#874](https://github.com/archestra-ai/archestra/issues/874)) ([5a6fd72](https://github.com/archestra-ai/archestra/commit/5a6fd7299f0504177d789ebcad74d0f6128ff3bf))

## [0.0.20](https://github.com/archestra-ai/archestra/compare/platform-v0.0.19...platform-v0.0.20) (2025-10-31)


### Bug Fixes

* UI Polish ([#868](https://github.com/archestra-ai/archestra/issues/868)) ([1c34668](https://github.com/archestra-ai/archestra/commit/1c34668b4567b6534ddca025765f5d96a887ab06))

## [0.0.19](https://github.com/archestra-ai/archestra/compare/platform-v0.0.18...platform-v0.0.19) (2025-10-31)


### Features

* helm `ServiceAccount` + `Role` + `RoleBinding` ([#864](https://github.com/archestra-ai/archestra/issues/864)) ([7436477](https://github.com/archestra-ai/archestra/commit/7436477619cfc8058c26232c9ba8db4297554cb2))
* LLM tool call requests and responses ([#853](https://github.com/archestra-ai/archestra/issues/853)) ([efa0e42](https://github.com/archestra-ai/archestra/commit/efa0e425334ec4e32ead97e2bc38248f98b64668))


### Bug Fixes

* orlando ([#865](https://github.com/archestra-ai/archestra/issues/865)) ([c926ba2](https://github.com/archestra-ai/archestra/commit/c926ba2ed3141ff7ce1a070d2c1fd5eefa392241))
* prevent tool id duplication when streaming via proxy ([#866](https://github.com/archestra-ai/archestra/issues/866)) ([89dca1a](https://github.com/archestra-ai/archestra/commit/89dca1a942b6abbe1ee44fa964d135ba9d870058))

## [0.0.18](https://github.com/archestra-ai/archestra/compare/platform-v0.0.17...platform-v0.0.18) (2025-10-30)


### Bug Fixes

* do not add /v1/ prefix when proxying and rely on OPENAI_BASE_URL ([#860](https://github.com/archestra-ai/archestra/issues/860)) ([dc9faab](https://github.com/archestra-ai/archestra/commit/dc9faabbe1cb531c4a3deb35e8853b722d448c46))

## [0.0.17](https://github.com/archestra-ai/archestra/compare/platform-v0.0.16...platform-v0.0.17) (2025-10-30)


### Features

* use custom docker image for local mcp servers ([#858](https://github.com/archestra-ai/archestra/issues/858)) ([341e3fc](https://github.com/archestra-ai/archestra/commit/341e3fc33f741671a60c2ed9d2a8af23c05890f2))

## [0.0.16](https://github.com/archestra-ai/archestra/compare/platform-v0.0.15...platform-v0.0.16) (2025-10-30)


### Features

* add more logging and fix proxying to custom provider url ([#857](https://github.com/archestra-ai/archestra/issues/857)) ([c297c0c](https://github.com/archestra-ai/archestra/commit/c297c0c980348be6cc812e6a1608d0ae56e17205))
* mcp server runtime in k8s ([#854](https://github.com/archestra-ai/archestra/issues/854)) ([f140291](https://github.com/archestra-ai/archestra/commit/f14029159f17d6b52c089ca06b731441db1e2488))


### Bug Fixes

* handlebars highlighting in monaco editor ([#855](https://github.com/archestra-ai/archestra/issues/855)) ([e19a163](https://github.com/archestra-ai/archestra/commit/e19a163860b9969205a876869523d6abbe00e21e))
* small bug in `McpClient` tool execution (when no auth provided) + UI bug on tools table ([#850](https://github.com/archestra-ai/archestra/issues/850)) ([13f3447](https://github.com/archestra-ai/archestra/commit/13f34474bdfc813dd00adc76969a8aefb50c3af0))
* use correct prefix v1 in proxy llm  ([#851](https://github.com/archestra-ai/archestra/issues/851)) ([374f964](https://github.com/archestra-ai/archestra/commit/374f964102833c1cb40e0d0b63395d748b1f653b))

## [0.0.15](https://github.com/archestra-ai/archestra/compare/platform-v0.0.14...platform-v0.0.15) (2025-10-29)


### Bug Fixes

* volume for pg ([#848](https://github.com/archestra-ai/archestra/issues/848)) ([b2d3b3d](https://github.com/archestra-ai/archestra/commit/b2d3b3d65d0927881cc3778b91d705b967b2a6ea))

## [0.0.14](https://github.com/archestra-ai/archestra/compare/platform-v0.0.13...platform-v0.0.14) (2025-10-29)


### Bug Fixes

* n8n llm proxy anthropic routing when using specific agent id ([#846](https://github.com/archestra-ai/archestra/issues/846)) ([5fe42dc](https://github.com/archestra-ai/archestra/commit/5fe42dc21107eae763f97e262cdf8f13045695e6))

## [0.0.13](https://github.com/archestra-ai/archestra/compare/platform-v0.0.12...platform-v0.0.13) (2025-10-29)


### Features

* add Archestra MCP server ([fb33e9d](https://github.com/archestra-ai/archestra/commit/fb33e9dcd3058ab13c76313b1581c3400c889879))
* add OpenTelemetry distributed tracing with Jaeger ([#830](https://github.com/archestra-ai/archestra/issues/830)) ([c0f2adc](https://github.com/archestra-ai/archestra/commit/c0f2adc292e9338cc891f3f455e9d8ad50db0def))
* add team support ([#819](https://github.com/archestra-ai/archestra/issues/819)) ([f83159f](https://github.com/archestra-ai/archestra/commit/f83159f2d19cdd7051922b546a1f4d2208eea2b3))
* add tooltip w/ description for unassigned mcp server tools + expand client searching functionality ([1de5ebc](https://github.com/archestra-ai/archestra/commit/1de5ebc9b4dae50f1bb46d893fd6c460d9eff39d))
* assign tools from mcp server cards ([#829](https://github.com/archestra-ai/archestra/issues/829)) ([e834e6a](https://github.com/archestra-ai/archestra/commit/e834e6ac557f6dfa704d12495d5e6fcaa26e0f73))
* basic backend observability with fastify-metrics ([#811](https://github.com/archestra-ai/archestra/issues/811)) ([b81670f](https://github.com/archestra-ai/archestra/commit/b81670fa45e9aa8837d5f56be4468df48760e582))
* basic mcp gateway ([#787](https://github.com/archestra-ai/archestra/issues/787)) ([e231c70](https://github.com/archestra-ai/archestra/commit/e231c70dacc63b3a8f110563c531552b4d66368f))
* edit and reinstall mcp server ([#837](https://github.com/archestra-ai/archestra/issues/837)) ([532bef3](https://github.com/archestra-ai/archestra/commit/532bef3cdbc6b2a45e0253897f2aef9018f8fabc))
* enhance default credentials handling and UI updates ([7fc1482](https://github.com/archestra-ai/archestra/commit/7fc148248d3091655cc5d3493994271554f0cb95))
* enhance default credentials handling and UI updates ([#775](https://github.com/archestra-ai/archestra/issues/775)) ([7fc1482](https://github.com/archestra-ai/archestra/commit/7fc148248d3091655cc5d3493994271554f0cb95))
* implement adding custom servers ([#828](https://github.com/archestra-ai/archestra/issues/828)) ([5072e98](https://github.com/archestra-ai/archestra/commit/5072e98294816ab543e9d9262942a2958dca23fa))
* inject MCP tools @ LLM-proxy level ([#774](https://github.com/archestra-ai/archestra/issues/774)) ([0338069](https://github.com/archestra-ai/archestra/commit/0338069de0237af98242307a25893d4523d758f4))
* install remote MCP servers ([#801](https://github.com/archestra-ai/archestra/issues/801)) ([b2ebb94](https://github.com/archestra-ai/archestra/commit/b2ebb940558cd1f765d79f555aee278f24bfcc55))
* LLM observability ([#824](https://github.com/archestra-ai/archestra/issues/824)) ([8bd1b8d](https://github.com/archestra-ai/archestra/commit/8bd1b8dd92b4541e3ba9d1f35caa9c775695adcf))
* mcp catalog/gateway basic CRUD (behind feature flag) ([#755](https://github.com/archestra-ai/archestra/issues/755)) ([6117eef](https://github.com/archestra-ai/archestra/commit/6117eef34c16ef063d22b36fdc609fc326e63bc9))
* MCP gateway ([#768](https://github.com/archestra-ai/archestra/issues/768)) ([992b9d2](https://github.com/archestra-ai/archestra/commit/992b9d230958d22794e83cbb93531c323adbff51))
* MCP Gateway authentication ([#818](https://github.com/archestra-ai/archestra/issues/818)) ([5e0a410](https://github.com/archestra-ai/archestra/commit/5e0a410f27e81acc660b5361cb769943048bd502))
* mcp gateway MVP ([#758](https://github.com/archestra-ai/archestra/issues/758)) ([9bedfa8](https://github.com/archestra-ai/archestra/commit/9bedfa86326c412e5f84ea185dc968af42566330))
* MCP Response Modifier template (handlebars) ([#813](https://github.com/archestra-ai/archestra/issues/813)) ([057bb9a](https://github.com/archestra-ai/archestra/commit/057bb9a61af72a97212edb755a667e6c79dca355))
* mcp server installation requests workflow ([#834](https://github.com/archestra-ai/archestra/issues/834)) ([f5d3440](https://github.com/archestra-ai/archestra/commit/f5d34401dbe051ed3a85a3546f81c94d0ce4f69c))
* prepare openapi-spec for go codegen (for Terraform provider) ([#822](https://github.com/archestra-ai/archestra/issues/822)) ([5d4ad7e](https://github.com/archestra-ai/archestra/commit/5d4ad7ee91a5269bf21c3530123df3dfef3bc3d3))
* remote tool execution (non-streaming only atm) ([#785](https://github.com/archestra-ai/archestra/issues/785)) ([2b92743](https://github.com/archestra-ai/archestra/commit/2b92743d3b7d2f22b1b868cfd39a9f96a4c49e55))
* show current version in UI ([#821](https://github.com/archestra-ai/archestra/issues/821)) ([aed6399](https://github.com/archestra-ai/archestra/commit/aed63996c08398ac404900c49f580c31ac8e0660))
* support remote mcp tool execution for openai streaming mode ([bb9df64](https://github.com/archestra-ai/archestra/commit/bb9df6494746bc00641454a2228020a4149cd6f4))
* support streaming for anthropic ([#772](https://github.com/archestra-ai/archestra/issues/772)) ([27aaaf1](https://github.com/archestra-ai/archestra/commit/27aaaf19885330612b10a5b1c59f99831845f2ac))


### Bug Fixes

* add v1 prefix to mcp and proxy all llm requests via agent ([#806](https://github.com/archestra-ai/archestra/issues/806)) ([3f0efc4](https://github.com/archestra-ai/archestra/commit/3f0efc42a8357f5824d77aa0bf3a4cc8a1229753))
* anthropic streaming linting ([3a5eb6b](https://github.com/archestra-ai/archestra/commit/3a5eb6b133a931461e5686431d6136d0dfa9ce42))
* don't autodiscover tools from mcp gateway ([#841](https://github.com/archestra-ai/archestra/issues/841)) ([b60dc79](https://github.com/archestra-ai/archestra/commit/b60dc7941b1fc8e66dee7226ea709e0b75fecdbf))
* few bug fixes ([#759](https://github.com/archestra-ai/archestra/issues/759)) ([b672765](https://github.com/archestra-ai/archestra/commit/b672765701f9aa732f183eb7e25d3d98899ab5a1))
* fix mcp dialog layout ([#840](https://github.com/archestra-ai/archestra/issues/840)) ([680271b](https://github.com/archestra-ai/archestra/commit/680271b42a72c05c1cdb700f8c903937a8006596))
* fix url color, tools bulk actions ux, How it works layout ([#764](https://github.com/archestra-ai/archestra/issues/764)) ([a05a1c6](https://github.com/archestra-ai/archestra/commit/a05a1c6a0da6d458298be3b47cca36948e8dcbea))
* flickering menu ([#784](https://github.com/archestra-ai/archestra/issues/784)) ([e5edfa1](https://github.com/archestra-ai/archestra/commit/e5edfa1f7f3ab7b637c37ceffe3367ed58e3ecc7))
* improve streaming ([#765](https://github.com/archestra-ai/archestra/issues/765)) ([8227a0e](https://github.com/archestra-ai/archestra/commit/8227a0e466f914931d73f8cea6c969d5c0c20983))
* interactive mode when running command db:generate from root dir ([#792](https://github.com/archestra-ai/archestra/issues/792)) ([0d8111e](https://github.com/archestra-ai/archestra/commit/0d8111eba906deff842abe8bb99b559c67b1dadc))
* issues w/ api key authentication ([#826](https://github.com/archestra-ai/archestra/issues/826)) ([e70d1b3](https://github.com/archestra-ai/archestra/commit/e70d1b353dee102612e4d26f429d2322780f73c6))
* oauth with github via client id/secret ([#842](https://github.com/archestra-ai/archestra/issues/842)) ([1fba136](https://github.com/archestra-ai/archestra/commit/1fba13636eb6eeccf1cfee67ec703c8d6b47e2df))
* OpenWebUI streaming mode support ([#790](https://github.com/archestra-ai/archestra/issues/790)) ([f8e8913](https://github.com/archestra-ai/archestra/commit/f8e8913bbf982447f6f9766900983f8425bd217e))
* Polish MCP catalog texts ([#802](https://github.com/archestra-ai/archestra/issues/802)) ([8baa483](https://github.com/archestra-ai/archestra/commit/8baa483ca69d22ed07979dd27f69cfb263fc9128))
* return default OpenAI url ([#807](https://github.com/archestra-ai/archestra/issues/807)) ([db2102f](https://github.com/archestra-ai/archestra/commit/db2102f2cf27e06a43b78f79b946819415679d49))
* tiny text update ([#797](https://github.com/archestra-ai/archestra/issues/797)) ([84ab5ad](https://github.com/archestra-ai/archestra/commit/84ab5ad3c0e044b259da6aa185a697aa9c872e22))
* tool execution ([#845](https://github.com/archestra-ai/archestra/issues/845)) ([de0a5ce](https://github.com/archestra-ai/archestra/commit/de0a5cef0e641bdd414db5794c22ec8f94dc08eb))
* use mcp server sdk for gateway ([#808](https://github.com/archestra-ai/archestra/issues/808)) ([454c505](https://github.com/archestra-ai/archestra/commit/454c5058c92927d149eaea58144393ecd129ce17))
* when installing mcp server, "refetch" available tools ([#798](https://github.com/archestra-ai/archestra/issues/798)) ([e87242c](https://github.com/archestra-ai/archestra/commit/e87242cdee0a9c1983bb59d7315994c6eca9c3cf))


### Dependencies

* **platform:** bump @types/node from 20.19.19 to 24.9.1 in /platform ([#780](https://github.com/archestra-ai/archestra/issues/780)) ([42b4962](https://github.com/archestra-ai/archestra/commit/42b4962512c814d1742db90106b33980052652cf))
* **platform:** bump next from 15.5.4 to 16.0.0 in /platform ([#832](https://github.com/archestra-ai/archestra/issues/832)) ([98e98ea](https://github.com/archestra-ai/archestra/commit/98e98ea78ee3a3a96166c30033381708a671b16d))
* **platform:** bump react-markdown from 9.1.0 to 10.1.0 in /platform ([#779](https://github.com/archestra-ai/archestra/issues/779)) ([02268fc](https://github.com/archestra-ai/archestra/commit/02268fc12b1fecc57ee1ba2c7f1f85b7af86bfae))
* **platform:** bump the platform-dependencies group across 1 directory with 5 updates ([#833](https://github.com/archestra-ai/archestra/issues/833)) ([7edae24](https://github.com/archestra-ai/archestra/commit/7edae24c02a3abe992f1038873aa476fe2fa2c5d))
* **platform:** bump the platform-dependencies group in /platform with 25 updates ([#778](https://github.com/archestra-ai/archestra/issues/778)) ([46eb5e4](https://github.com/archestra-ai/archestra/commit/46eb5e46454e0306fb74e638293363e03c3126ed))
* **platform:** bump vitest from 3.2.4 to 4.0.1 in /platform ([#782](https://github.com/archestra-ai/archestra/issues/782)) ([91773ec](https://github.com/archestra-ai/archestra/commit/91773ecaea3c3eaadbf8248f5f547d1ee464c226))

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
