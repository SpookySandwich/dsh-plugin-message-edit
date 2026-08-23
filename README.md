# dsh-plugin-message-edit

[English](README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/dsh-plugin-message-edit?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-plugin-message-edit)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.7-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/SpookySandwich/dsh-plugin-message-edit?style=flat&label=stars)](https://github.com/SpookySandwich/dsh-plugin-message-edit/stargazers)

编辑一条已经发出的消息，对话会从那一刻 **真正回溯并分叉**——和 ChatGPT、Claude、DeepSeek 的做法一致。旧版本不会被覆盖：气泡下方出现 `‹ 2/4 ›` 计数，「版本」标签页则画出整棵树。

![演示](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-message-edit/master/assets/demo-zh.gif)

## 版本树分支展示

无论对话如何深层分叉、编辑多少次，「版本」标签页均会呈现清晰的轮次级分支图，当前会话所在路径实时高亮，点击任意节点即可平滑跳转：

![版本树](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-message-edit/master/assets/tree-demo.png)

## 功能

- **编辑并分叉**：修改过去的提问并发送，新分支会带着该轮 *之前* 的完整上下文重新生成。这是真正的回溯，而不是从末尾继续的 fork。
- **版本计数**：一条消息存在多个版本时，下方出现 `‹ n/m ›`，左右箭头在各版本间即时切换。
- **版本树**：新增「版本」标签页，以图的方式展示所有分支，可平移、缩放、拖动。当前所在分支高亮，点击任意节点即可跳转。
- **零延迟与即时切换**：客户端家族级 SWR 缓存与乐观预加载，点击箭头或树节点切换版本 0ms 响应，无指示器闪烁或加载白屏。
- **高性能内存缓存**：宿主端内存解析缓存，消除重复磁盘 I/O 与日志重析，即便是深度分叉的庞大家族树也能毫秒级响应。
- **自动中止旧分支**：分叉时自动停止同家族中仍在流式生成的回复，避免浪费 Token 与计算资源。
- **重试**：不修改内容，直接重跑该轮（Claude 布局）。
- **复制**：把消息文本复制到剪贴板。
- **持久可靠**：每个分支都是真实会话，版本关系写入持久事件，重启后依旧完整。新分支自动归入父会话的工作区。

## 界面风格

这三家界面的差别在于 **操作按钮放在哪里、有哪些**，因此预设只改变这一点，颜色始终沿用 DSH 原生配色。在 **设置 → 消息树** 中选择，面板内有实时预览。

| 预设 | 气泡下方的按钮 | 显示方式 | 编辑框按钮 |
| --- | --- | --- | --- |
| **ChatGPT** | 编辑、复制 | 悬停时显示 | `取消` / `发送` 在框 **内部** |
| **DeepSeek** | 编辑、复制 | 始终显示——与 DSH 一致 | `取消` / `发送` 在框 **内部** |
| **Claude** | **重试**、编辑、复制 | 悬停时显示 | `取消` / `保存` 在框 **下方** |

只有 Claude 在用户消息上提供重试，与真实界面一致。没有分享按钮——DSH 本身没有，就不自行发明。

## 安装

```bash
dsh plugin --profile web add dsh-plugin-message-edit
```

安装后请重启 DSH：宿主端随服务器加载。界面跟随 DSH 显示语言（中文 / English）。

## 工作原理

DSH 的会话是仅追加的事件日志，本身不支持会话内分支，因此回溯需要另行实现：

- 宿主端提供 `/message-tree` 接口。编辑消息时，会 **以目标轮次之前的全部事件为种子创建一个新会话**，写入持久的 `message-tree/version` 标记说明改动内容，并把编辑后的提问送入。
- 之后读取这些标记，还原出整棵版本树、`‹ n/m ›` 计数，以及当前处于哪个分支。
- 标记事件带有信封上的 `ignorable` 标志。插件自定义的事件类型不在宿主的事件词表内，缺少该标志时读取端会拒绝解释整份日志，会话将直接打不开。
- 只遮蔽普通的 `user` 消息节点（优先级 `-1`）；思考、工具调用与引导消息仍由宿主渲染。

宿主端的分支逻辑源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack），在其基础上重做为 ChatGPT 式回溯语义、同级分支展开，以及上述界面预设。

两者名字相近，这里说明一下：这是另一个独立插件。它的路由、cordis id 与持久事件类型都保留了 `message-tree` 这一套命名，正是为了两个插件可以同时安装而互不冲突。

## 文档

更多技术细节与开发指南，请参阅：
- [架构概览 (Architecture)](docs/ARCHITECTURE.md)：宿主/客户端架构、Cordis 服务注入、持久事件模型与 HTTP 接口。
- [树数据模型与算法 (Tree Data Model)](docs/TREE_DATA_MODEL.md)：轮次级消息树构建、同级展开、删除会话（Ghost）桥接与高亮路径计算。
- [开发与测试指南 (Development)](docs/DEVELOPMENT.md)：构建流程、单元测试与本地安装说明。

## 兼容性

可与 [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream)、[dsh-plugin-rollout-scout](https://github.com/SpookySandwich/dsh-plugin-rollout-scout) 共存。

## 许可

MIT © SpookySandwich。宿主端部分逻辑源自 dsh-message-edit（MIT © Moeblack）。

