# Unreleased

Support official DSH `0.2.2-rc.4` while retaining all previously supported hosts. Add `|| 0.2.2-rc.4` to both `peerDependencies["@deepseek-ai/dsh"]` and `engines.dsh`, with matching lockfile metadata, so ordinary npm peer resolution admits this prerelease. Official DSH `0.2.2-rc.4` requires Node `>=24.9.0`.

No plugin runtime changes are required. Prompts whose turns ended in `CONTENT_REFUSED` remain editable and retryable with the correct branch boundary; retained `assistant/attempt` output stays outside successful answer history. Version switching, the version tree, and persisted branches continue to work.

Extend the Linux and Windows official-host CI matrix to rc.4, and run the existing browser session-ID search and import-dialog checks on rc.4. Update the browser fixture's subagent request to work with both rc.1's nested request and the flat request used by rc.3 and rc.4.

支持官方 DSH `0.2.2-rc.4`，继续兼容此前所有已支持的宿主版本。在 `peerDependencies["@deepseek-ai/dsh"]` 与 `engines.dsh` 中显式加入 `|| 0.2.2-rc.4`，并同步锁文件元数据，使 npm 常规 peer 依赖解析接受该预发布版本。官方 DSH `0.2.2-rc.4` 要求 Node `>=24.9.0`。

无需改动插件运行时代码。以 `CONTENT_REFUSED` 结束的轮次仍可编辑或重试，分支边界保持正确；保留的 `assistant/attempt` 输出不会进入成功回复历史。版本切换、版本树与持久分支继续正常工作。Linux 和 Windows 官方宿主 CI 矩阵加入 rc.4；浏览器会话 ID 搜索与导入对话框检查覆盖 rc.4；子智能体测试请求同时兼容 rc.1 的嵌套格式与 rc.3、rc.4 的平铺格式。

Validation before shipping:

- 120 automated tests pass on Node 22.19 and Node 24.19; release-tool tests, publishing-helper tests, package verification, and whitespace checks pass.
- Ordinary npm peer installation beside rc.4 and fresh/restart API acceptance pass. Offline refusal checks cover branch boundaries and failed-attempt history.
- Isolated rc.4 Web browser acceptance passes all three phases: main 22/22, restart 20/20, and full-text search disabled 10/10, without page errors or failed requests. Coverage includes imported chats, version switching and trees, reload, and grouped-row subagent activity.
- The restart browser phase also passes 20/20 on rc.1 with the updated fixture.

Runtime validation used Windows and local model fixtures. Linux runtime behavior, the desktop app and LiveShare, and a refusal from DeepSeek's live service were not exercised.

Restart DSH after updating the plugin.
