# dsh-codex — Codex for DSH

把 OpenAI 开源的 Codex 系列接入 DSH(DeepSeek Harness)生态的插件。
让 DSH agent 能调用本机 Codex CLI 执行任务(实现/修复/审查/安全审计)。

## 工具

| 工具 | 说明 |
|---|---|
| `codex_status` | 环境检测:codex 二进制 / CODEX_HOME / OPENAI_API_KEY / 版本,缺失时给安装指引 |
| `codex_exec` | 在指定目录跑一次 Codex 任务(prompt 经 stdin,结果经 `--output-last-message` 文件通道读回) |

## 前置条件

- 安装 Codex CLI:`npm install -g @openai/codex`(或从 GitHub Releases 下载)
- 配置 `OPENAI_API_KEY`(或 ~/.codex/config.toml 指向兼容 provider)

## 设计来源(codex-zone 研究)

| 模式 | 来源 | 吸收点 |
|---|---|---|
| spawn `codex exec` + stdin prompt + 文件通道 | codex-action | runCodexExec 流程、--output-last-message 读回 |
| 认证/执行分离 | codex-action | 密钥只走环境变量,不上 argv |
| spawn 前受保护参数校验 | codex-action | PROTECTED_ARGS 拒绝清单 |
| app-server JSON-RPC 客户端(计划中) | codex-plugin-cc | 后台任务、流式事件、broker 共享 |
| 安全审计方法论(计划中) | codex-security | 威胁模型 + 调查员扇出提示词 |

## 目录

```
lib/index.js   插件入口(工具注册 + 环境检测 + exec runner)
src/index.ts   TS 源(tsc → dist)
test/          测试(占位)
```

## Roadmap

- [x] 环境检测 + 单次任务执行骨架
- [ ] app-server JSON-RPC 客户端(codex_task 后台任务 / codex_review / codex_result / codex_cancel)
- [ ] 代码审查工具(codex_review,基于 plugin-cc 的 review 命令)
- [ ] 安全审计工具(codex_security,基于 codex-security 方法论)
- [ ] Hono 内嵌 API 层(状态查询端点)
