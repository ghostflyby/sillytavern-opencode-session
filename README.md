# sillytavern-opencode-session

SillyTavern 前端扩展：为每个聊天自动附加独立的 `x-opencode-session` 请求头，经
SillyTavern 服务端转发给上游 API。不修改 SillyTavern 核心，适用于 Custom
（OpenAI 兼容）连接。

仓库：https://github.com/ghostflyby/sillytavern-opencode-session

## 功能

- **每聊天一个会话 ID**：保存在各聊天的 metadata 中，同一聊天复用、跨聊天隔离；
  聊天被复制/分支/改名后会重新分配新 ID。
- **手动会话 ID**：上游要求预先存在的会话时手动指定，优先于自动分配。
- **目标地址过滤**：仅对匹配的 Custom 连接注入；留空则对所有 Custom 连接生效。
- **保留已有自定义头**：与连接设置的自定义标头合并，同名（大小写不敏感）替换而
  不重复。
- 默认关闭；启用后仅影响 Custom 来源的聊天补全生成请求。

说明：自动生成的是随机 UUID，上游要求先创建会话时请用"手动会话 ID"填入上游
返回的 ID；SillyTavern 每次生成都会提交完整消息历史，上下文是否隔离取决于上游
对该 header 的语义。

## 安装

方式一（推荐）：SillyTavern → 扩展 → 下载扩展和资产 → 填入仓库地址
`https://github.com/ghostflyby/sillytavern-opencode-session`（可选分支）。

方式二：手动复制本目录到 `data/<用户>/extensions/sillytavern-opencode-session/`
（单用户）或全局扩展目录，然后刷新页面。

使用：

1. 连接设置：Chat Completion → 自定义（OpenAI 兼容），Custom Endpoint 填上游
   地址（SillyTavern 自动拼接 `/chat/completions`）。
2. 扩展面板 → OpenCode Session Header → 勾选启用，建议同时填写目标 Custom API
   地址。
3. 需要时在"手动会话 ID"填入上游会话 ID；"重新分配当前聊天 ID"可强制换新。

## 开发

需要 Deno 2+（浏览器入口 `index.js` 依赖 SillyTavern 全局，不参与 Deno 检查）。

```
deno test                    # 单元测试
deno task mock               # 本地模拟上游（127.0.0.1:18101）
deno task verify:source      # pinned 源码链路断言
deno task verify:transport   # 真实服务端端到端验证（临时目录安装 npm 包）
deno fmt --check && deno lint && deno check src/ mock/ scripts/ test/
```

结构：`src/` 纯逻辑（YAML 子集解析合并、会话分配），浏览器与测试共用；`mock/`
模拟上游；`scripts/` 验证脚本。

## 许可

[AGPL-3.0](LICENSE)
