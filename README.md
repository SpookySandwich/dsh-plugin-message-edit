# dsh-plugin-message-tree

[English](./README.en.md) | 中文

给 DeepSeek Harness 带来 ChatGPT 式的消息编辑体验：悬停任意一条你发过的消息，点击铅笔即可修改并重新发送——对话会从那一刻真正回溯并分叉，而不是简单续写。

- **就地编辑**：悬停你的消息 → 铅笔 → 修改 → 发送。新分支携带编辑后的提问，从该回合之前的完整上下文重新生成。
- **版本切换**：同一条消息存在多个版本时，气泡下方出现 `‹ 2/3 ›`，一键在各版本之间来回切换。
- **版本树视图**：会话顶部新增「版本」标签页，以树状缩进展示全部分支——当前所在分支高亮，点击任意节点即可跳转。
- **持久可靠**：每个分支都是一个真实的会话，版本关系写入持久事件，重启后依旧完整。

## 安装

在 DeepSeek Harness 的插件市场中搜索 `dsh-plugin-message-tree`，或手动安装：

```
dsh plugin add dsh-plugin-message-tree
```

安装后重启 DSH（宿主端需要随服务器加载）。

## 工作原理

DSH 的会话是仅追加的事件日志，本身不支持会话内分支。本插件的宿主端提供 `/message-tree` 接口：编辑消息时，它以目标回合之前的事件为种子创建一个新会话，写入持久的版本标记事件，并把编辑后的消息作为新提问送入。客户端读取这些标记还原出完整的版本树。

宿主端分支逻辑部分源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT，© Moeblack），在其之上重新设计了面向 ChatGPT 式交互的界面与版本环切换算法。

## 兼容性

- 仅以 `-1` 优先级遮蔽 `user` 消息气泡，其余渲染（思考、工具调用、引导消息等）不受影响；可与 [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream) 等插件共存。
- 界面跟随 DSH 显示语言（中文/英文）。

## 许可

MIT © SpookySandwich。宿主端部分逻辑源自 dsh-message-edit（MIT © Moeblack）。
