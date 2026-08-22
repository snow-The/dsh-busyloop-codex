# dsh-busyloop-codex — Codex CLI bridge for DSH(busyloop 家族 · 范式①)

> **改名历史**:本仓库原名 `dsh-codex`,2026-08-22 改名加入 busyloop 家族;
> npm 包名 `@snow-the/dsh-busyloop-codex`(旧名 `@snow-the/dsh-codex@0.1.0` 保留不更新)。

**家族架构**:`dsh-busyloop`(引擎)→ 范式① `dsh-busyloop-codex`(CLI 桥,本仓库)/ 范式② `dsh-busyloop-codexstyle`(自研,规划中)。

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
src/index.ts    TS 源(tsc → dist)
dist/index.js   编译产物(main)
test/           测试(node --test,17 个:环境检测 / fake-codex 全链路 / Hono)
```

## 测试

`npm test`(node --test,串行)覆盖:

1. **工具注册**:codex_status / codex_exec 注册、Hono /health /status 端点
2. **环境检测**:无 binary 给安装指引、无 key 给认证指引
3. **exec 全链路**(fake codex 二进制,不碰真 CLI、不耗额度):spawn 参数、
   stdin prompt 通道、--output-last-message 文件读回、model/reasoningEffort
   透传、PROTECTED_ARGS 拒绝(--json/--sandbox/--model 等)、退出码回显、
   stderr 回显、超时进程树 kill(taskkill /t)

## 平台说明(Windows)

npm 全局安装的 codex 是 `codex.cmd` shim:无 shell 的 spawn/execFileSync 对
`.cmd` 直接 ENOENT/EINVAL,插件统一走 `shell: true`(仅 `--version` 探测与
exec 调用,参数不经 shell 拼接);超时用 `taskkill /pid <pid> /t /f` 杀整棵
进程树,避免孤儿 node 子进程持有管道导致 close 永不触发。

## Roadmap

- [x] 环境检测 + 单次任务执行骨架
- [ ] app-server JSON-RPC 客户端(codex_task 后台任务 / codex_review / codex_result / codex_cancel)
- [ ] 代码审查工具(codex_review,基于 plugin-cc 的 review 命令)
- [ ] 安全审计工具(codex_security,基于 codex-security 方法论)
- [ ] Hono 内嵌 API 层(状态查询端点)
