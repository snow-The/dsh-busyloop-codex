# dsh-busyloop-codex — Codex CLI bridge for DSH(busyloop 家族 · 范式①)

> **改名历史**:本仓库原名 `dsh-codex`,2026-08-22 改名加入 busyloop 家族;
> npm 包名 `@snow-the/dsh-busyloop-codex`(旧名 `@snow-the/dsh-codex@0.1.0` 保留不更新)。

**家族架构**:`dsh-busyloop`(引擎)→ 范式① `dsh-busyloop-codex`(CLI 桥,本仓库)/ 范式② `dsh-busyloop-codexstyle`(自研,规划中)。

把 OpenAI 开源的 Codex 系列接入 DSH(DeepSeek Harness)生态的插件。
让 DSH agent 能调用本机 Codex CLI 执行任务(实现/修复/审查/安全审计)。

## 工具

| 工具 | 说明 |
|---|---|
| `codex_status` | 环境检测:codex 二进制 / CODEX_HOME / config / **当前 provider** / **凭证走哪条路**,缺失时给指引 |
| `codex_exec` | 在指定目录跑一次 Codex 任务(prompt 经 stdin,结果经 `--output-last-message` 文件通道读回) |
| HTTP | `GET /api/codex/health` · `GET /api/codex/status`(经宿主 `ctx.webServer`,**带 Host/Origin 围栏**) |

## 前置条件

- 安装 Codex CLI:`npm install -g @openai/codex`(或从 GitHub Releases 下载)
- **三条认证路径,任一条成立即可**(旧的 `OPENAI_API_KEY` 单一门槛已废弃,见下):
  1. `codex login` —— 写 `~/.codex/auth.json`(ChatGPT 套餐路线)
  2. `~/.codex/config.toml` 里**当前 provider** 的 `env_key` 指向的环境变量
  3. `OPENAI_API_KEY`(直连 API 路线,**优先级最低**)

### ⚠️ `wire_api = "chat"` 已被 Codex 移除

Codex 已放弃 `chat/completions`,**2026 年 2 月起改为硬错误**(官方公告:
<https://github.com/openai/codex/discussions/7782>)。自定义 provider 必须写:

```toml
[model_providers.<名字>]
wire_api = "responses"
```

## 用非 OpenAI 的模型跑 Codex(例如 DeepSeek)

Codex 通过 **Responses API** 与模型通信,所以 provider 必须实现它 ——
"OpenAI 兼容"已经不够了,因为被砍掉的恰好就是那个兼容面。

**DeepSeek 原生支持 Responses API**,官方有 Codex 接入页(含 Windows 一键脚本、`models.json`
模型目录、`[model_providers.deepseek]` 段,并且**会先备份** `~/.codex/config.toml` 到
`~/.codex/backup-deepseek/`):

<https://api-docs.deepseek.com/quick_start/agent_integrations/codex>

手改的最小形态:设 `model_provider`,再给该 provider 段配 `base_url` / `env_key` /
`wire_api = "responses"`。配好后 `codex_status` 应报 `credentials: ok -- via env var <名字>
(named by provider "<名字>" in config.toml)`。

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
test/           测试(node --test,27 个:凭证三路径 / 围栏 / fake-codex 全链路)
```

## 测试

`npm test`(node --test,串行)覆盖:

1. **工具注册**:codex_status / codex_exec
2. **凭证检测(三路径 + 优先级)**:provider 的 `env_key`(旧门槛漏掉的那条)、
   `auth.json`、`OPENAI_API_KEY`(最低优先级)、三者皆无时列出三条路线;
   以及"provider 配了但它的 env var 没设"必须**点名那个变量**
3. **`CODEX_HOME` 语义**:它是 codex 目录本身,不是 `.codex` 的父目录
4. **HTTP 围栏**:围栏不可达必须 **fail-closed(503)**、拒绝时按其状态码作答且不泄露路由数据、
   放行才到路由;方法守卫(405)、404、query string 不破坏匹配
5. **exec 全链路**(fake codex 二进制,不碰真 CLI、不耗额度):spawn 参数、
   stdin prompt 通道、--output-last-message 文件读回、model/reasoningEffort
   透传、PROTECTED_ARGS 拒绝(--json/--sandbox/--model 等)、退出码回显、
   stderr 回显、超时进程树 kill(taskkill /t)

> 测试通过 `CODEX_HOME` 指向临时目录来隔离,**不会读你真实的 `~/.codex`**。

## 平台说明(Windows)

npm 全局安装的 codex 是 `codex.cmd` shim:无 shell 的 spawn/execFileSync 对
`.cmd` 直接 ENOENT/EINVAL,插件统一走 `shell: true`(仅 `--version` 探测与
exec 调用,参数不经 shell 拼接);超时用 `taskkill /pid <pid> /t /f` 杀整棵
进程树,避免孤儿 node 子进程持有管道导致 close 永不触发。

## Roadmap

- [x] 环境检测 + 单次任务执行骨架
- [x] 凭证三路径检测(provider `env_key` / `auth.json` / `OPENAI_API_KEY`)
- [x] HTTP 状态端点(原生 node handler + Host/Origin 围栏;已去 Hono 依赖)
- [ ] app-server JSON-RPC 客户端(codex_task 后台任务 / codex_review / codex_result / codex_cancel)
- [ ] 代码审查工具(codex_review,基于 plugin-cc 的 review 命令)
- [ ] 安全审计工具(codex_security,基于 codex-security 方法论)

## 构建说明(本机现实)

`npm run build` 需要 `typescript` + `esbuild` + `@types/node`。本仓库所在机器的
`node_modules` 曾被部分删除(`.pnpm` 里 `@typescript+typescript-win32-x64@7.0.2` 与
`@esbuild+win32-x64@0.28.2` 的 `lib/` 缺失),所以:

- `tsc` 会报 `Cannot find type definition file for 'node'`(坏 junction),**类型检查当前不可用**
- `esbuild` 单独可用;`dist/index.js` 是用**借用** `dsh-eigenflux/node_modules` 里健康副本的
  工具链构建的(见 `_recover/build-frozen-codex.mjs`,构建前会自动备份 dist)

要恢复完整构建链:在该插件目录重跑一次 `pnpm install`(会重新落成那些平台包)。
