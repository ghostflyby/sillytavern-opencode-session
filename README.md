# sillytavern-opencode-session

一个 SillyTavern 前端扩展原型：为**每个聊天**自动附加独立的 `x-opencode-session`
请求头， 经 SillyTavern 服务端转发给上游 API，从而满足"不同会话使用不同 session
标识"的上游要求。

不修改 SillyTavern 核心代码，不改全局连接配置；利用
Custom（OpenAI-compatible）连接 自带的 `custom_include_headers`
通道注入上游请求头。

## 结论（TL;DR）

**可行。** 前提是上游连接使用 Custom（OpenAI-compatible）类型。链路为：

```
扩展监听 CHAT_COMPLETION_SETTINGS_READY
  → 把 x-opencode-session 合并进本次请求体的 custom_include_headers（YAML 字符串）
  → SillyTavern 服务端解析该字段（mergeObjectWithYaml）
  → 服务端向上游发送真实 HTTP header x-opencode-session
```

已通过本地模拟上游对真实 SillyTavern 服务端完成端到端验证（见下文"验证记录"）。

## 安装

1. 将本目录整个复制到 SillyTavern 的第三方扩展目录：

   ```
   <SillyTavern>/public/scripts/extensions/third-party/sillytavern-opencode-session/
   ```

   或在 SillyTavern「下载扩展和资产」中填入本仓库的 git 地址（若有）。
2. 重载页面，在「扩展」面板中找到 **OpenCode Session Header**。
3. 连接设置：API 选择 **Chat Completion（自定义/OpenAI 兼容）**，Custom Endpoint
   填上游地址（SillyTavern 会在其后自动拼接 `/chat/completions`）。

## 配置

| 设置                   | 说明                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 启用                   | 默认关闭；开启后仅影响 Custom 来源的生成请求。                                                                      |
| 目标 Custom API 地址   | 留空对所有 Custom 连接生效；填写后仅当请求的 Custom Endpoint 与之匹配（去尾斜杠精确比较）时注入，避免误伤其他连接。 |
| 手动会话 ID            | 上游要求"预先存在的会话"时填写；设置后所有匹配请求使用该 ID，优先于自动分配。                                       |
| 当前聊天 / 当前会话 ID | 展示当前聊天的身份与会话 ID。                                                                                       |
| 重新分配当前聊天 ID    | 删除当前聊天 metadata 中的会话记录，下次生成时重新生成。                                                            |

## 行为规则

- **每聊天一个 ID**：会话 ID 保存在该聊天自己的 `chat_metadata` （键
  `opencode_session_header`）中，不同聊天互不共享。
- **复制/分支检测**：聊天复制或分支会连同 metadata 一起复制；扩展记录分配时的
  身份（角色 avatar 或群组 ID + 聊天名），身份不匹配即视为新聊天并重新分配 ID。
  聊天改名同样会触发重新分配（已知限制，见下）。
- **并发安全**：同一聊天并发的首次生成共享同一次 ID 分配，避免产生孤儿会话。
- **保留已有自定义头**：合并时保留连接设置中"自定义包含标头"的其余内容； 同名的
  `x-opencode-session`（大小写不敏感）会被替换而不是重复。
- **失败可见**：全局自定义标头若不是受支持的 YAML mapping（嵌套、流式集合、
  锚点、多文档等），扩展不注入并弹窗提示，保持原样——此时服务端本来也会丢弃
  全部自定义标头。
- **手动 ID 不落盘**：手动会话 ID 只保存在扩展设置里，不写入聊天 metadata。

## 已知限制

- 仅覆盖 **Custom（OpenAI-compatible）** 来源的聊天补全生成请求；OpenAI、Claude
  等内置 provider 不解析 `custom_include_headers`，状态检查、嵌入、图像等请求也
  不经过该事件。
- 聊天改名后（metadata 随之迁移时）身份记录不再匹配，会重新分配新 ID。
- 分支/复制的聊天会获得全新会话 ID；若上游会话需要在创建后携带历史，扩展不负责
  上游会话的创建与历史同步，仅负责标识。
- SillyTavern 每次生成都会提交完整消息历史；上游是否据此重建上下文取决于上游对
  该 header 的语义。不同 header 提供不同的会话标识，但不必然等于"上下文隔离"。
- 本扩展只生成随机 UUID 形式的 ID；若上游要求先调用其会话创建接口，请使用
  "手动会话 ID"填入上游返回的 ID。

## 验证记录

- `deno test`：20 项单元测试（YAML 子集解析/合并、身份判定、复制重分配、并发
  memo、聊天隔离、手动 ID 优先级等）。
- `deno task verify:source`：对 pinned commit
  `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`（v1.18.0）的关键链路断言（事件名、
  `custom_include_headers`、服务端合并、上游 fetch 头展开、扩展上下文 API）。
- `deno task verify:transport`：下载 pinned 源码，用 Deno 安装依赖并启动真实
  SillyTavern 服务端（回环地址、独立数据目录），以 HTTP 方式调用
  `/api/backends/chat-completions/generate`，验证模拟上游在**非流式与流式**两
  种请求下都收到了请求体中指定的 `x-opencode-session`。结果写入
  `.research/transport/transport-results.json`。

## 固定版本源码依据（v1.18.0，commit 8172dcd）

| 环节                           | 位置                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生成请求构造完成前等待扩展修改 | `public/scripts/openai.js` ~3051：`await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data)`，随后直接序列化同一对象 POST 到 `/api/backends/chat-completions/generate` |
| Custom 来源复制全局自定义标头  | `public/scripts/openai.js` ~2857：`generate_data.custom_include_headers = settings.custom_include_headers`                                                                                      |
| 服务端解析自定义标头           | `src/endpoints/backends/chat-completions.js` ~2320：`mergeObjectWithYaml(headers, request.body.custom_include_headers)`                                                                         |
| 上游请求头展开                 | 同文件 ~2577：`headers: { 'Content-Type': ..., 'Authorization': 'Bearer ' + apiKey, ...headers }` 后 `fetch(endpointUrl, config)`                                                               |
| 扩展可用上下文                 | `public/scripts/st-context.js`：`getCurrentChatId`、`chatId`、`chatMetadata`、`saveMetadata`、`eventSource`、`eventTypes`、`extensionSettings`                                                  |

## 开发

需要 Deno 2+（本仓库在 Deno 2.9.6 下验证）。扩展浏览器代码（`index.js`）不依赖
Deno API；纯逻辑在 `src/`，供浏览器与 Deno 测试共用。

```
deno test                    # 单元测试
deno task mock               # 启动本地模拟上游（127.0.0.1:18101）
deno task verify:source      # pinned 源码断言
deno task verify:transport   # 真实服务端端到端验证
deno fmt --check && deno lint && deno check src/ mock/ scripts/ test/
```

`index.js` 为浏览器专用（依赖 `SillyTavern`、`toastr`、DOM），不参与 Deno
类型检查。
