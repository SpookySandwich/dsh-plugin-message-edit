# Unreleased

Support official DSH `0.2.2-rc.4` and `0.2.2-rc.5` while retaining all previously supported hosts. Add `|| 0.2.2-rc.4 || 0.2.2-rc.5` to both `peerDependencies["@deepseek-ai/dsh"]` and `engines.dsh`, with matching lockfile metadata, so ordinary npm peer resolution admits these prereleases. Official DSH `0.2.2-rc.4` and `0.2.2-rc.5` require Node `>=24.9.0`.

Neither host needs a plugin runtime change. Prompts whose turns ended in `CONTENT_REFUSED` remain editable and retryable with the correct branch boundary; retained `assistant/attempt` output stays outside successful answer history. rc.5 only changes web-search provider selection; edits and retries copy its new `web/deepseek-search-llm-request` events unchanged.

Fix [#13](https://github.com/SpookySandwich/dsh-plugin-message-edit/issues/13), reported by [@Arkos123](https://github.com/Arkos123): editing or retrying a message keeps the conversation's agent teamwork mode. DSH starts every new session, forks included, with the mode off and ignores a mode copied into its history, so every branch lost it. A branch now takes the edited conversation's current mode through DSH's `agentTeams` service before its first turn. The original conversation is never written to, its task board and teammates stay with it, and hosts without agent teamwork are unaffected. Each version is still its own session in the sidebar by default; **Settings → Message Edit → Group versions into one sidebar entry** shows one row per conversation.

Extend the Linux and Windows official-host CI matrix to rc.4 and rc.5, and run the existing browser session-ID search and import-dialog checks on both. Update the browser fixture's subagent request to work with both rc.1's nested request and the flat request used since rc.3. API acceptance now turns agent teamwork on for the live fixture session and requires every branch to keep its source's mode, including a branch resumed after restart.

支持官方 DSH `0.2.2-rc.4` 与 `0.2.2-rc.5`，继续兼容此前所有已支持的宿主版本。在 `peerDependencies["@deepseek-ai/dsh"]` 与 `engines.dsh` 中显式加入 `|| 0.2.2-rc.4 || 0.2.2-rc.5`，并同步锁文件元数据，使 npm 常规 peer 依赖解析接受这些预发布版本。官方 DSH `0.2.2-rc.4` 与 `0.2.2-rc.5` 要求 Node `>=24.9.0`。

两个宿主版本均无需改动插件运行时代码。以 `CONTENT_REFUSED` 结束的轮次仍可编辑或重试，分支边界保持正确；保留的 `assistant/attempt` 输出不会进入成功回复历史。rc.5 仅调整网页搜索服务的选择方式；编辑与重试会原样复制其新增的 `web/deepseek-search-llm-request` 事件。

修复 [#13](https://github.com/SpookySandwich/dsh-plugin-message-edit/issues/13)（由 [@Arkos123](https://github.com/Arkos123) 报告）：编辑或重试消息时，分支沿用该对话的智能体团队协作模式。DSH 会让每个新会话（包括分叉）默认关闭该模式，并忽略历史中复制过来的模式记录，因此此前每个分支都会丢失它。现在分支会在第一轮开始前，通过 DSH 的 `agentTeams` 服务沿用所编辑对话的当前模式。原对话不会被写入，其任务板与队友仍归原对话所有；未启用智能体团队协作的宿主不受影响。默认情况下每个版本仍在侧栏中单独显示；在 **设置 → 消息编辑** 中开启「侧栏同一对话只显示一个入口」即可每个对话只显示一行。

Linux 和 Windows 官方宿主 CI 矩阵加入 rc.4 与 rc.5；浏览器会话 ID 搜索与导入对话框检查覆盖这两个版本；子智能体测试请求同时兼容 rc.1 的嵌套格式与 rc.3 起的平铺格式。API 验收现在会为实时测试会话开启智能体团队协作，并要求每个分支（包括重启后恢复的分支）沿用来源会话的模式。

Validation before shipping:

- 123 automated tests pass on Node 22.19 and Node 24.19; release-tool tests, publishing-helper tests, package verification, and whitespace checks pass.
- rc.4: ordinary npm peer installation and fresh/restart API acceptance pass; offline refusal checks cover branch boundaries and failed-attempt history. Isolated Web browser acceptance passes main 22/22, restart 20/20, and full-text search disabled 10/10; the restart phase also passes 20/20 on rc.1 with the updated fixture.
- rc.5: between the published rc.4 and rc.5 packages, only web search (`dsh-web`, `dsh-tool-web`, `dsh-web-search-deepseek`, its settings card and the base bundle's search setting) and build-hash strings changed. Ordinary npm peer installation passes under `--strict-peer-deps`; published 1.6.1 fails with `ERESOLVE`. Fresh/restart API acceptance passes, including the new agent teamwork check, which fails without the fix. Isolated Web browser acceptance passes main 22/22, restart 20/20, and full-text search disabled 10/10, without page errors or failed requests. Edits and retries across a recorded `web/deepseek-search-llm-request` event work fresh and after restart.
- Issue #13 was reproduced in the real Web UI on rc.3: the branch's teamwork switch was off although its copied history recorded it on. With the fix, on rc.3 and rc.5, the branch's switch is on and its first model request offers the same team task tools as the original; fresh/restart API acceptance with the teamwork check also passes on rc.3.

Runtime validation used Windows and local model fixtures. Linux runtime behavior, the desktop app and LiveShare, real DeepSeek searches, and a refusal from DeepSeek's live service were not exercised.

Restart DSH after updating the plugin.
