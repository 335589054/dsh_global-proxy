# always-in-proxy 开发文档

> 状态：设计稿 v0.1 + 首个实现（2026-10-17）
> 日期：2026-10-17
> 插件包名：`@local/always-in-proxy`
> 目标平台：Windows 优先，兼容 macOS / Linux；DSH Web 与 DSH TUI 均可使用
>
> 已确认决策：npm 默认使用 `npmmirror`；范围仅用户级；Agent 网页访问使用 `mirror_fetch`，不透明替换内置 `web_fetch`。
>
> 首个实现已包含：`mirror` / `mirror_fetch` 工具、`/mirror` 命令、Git/npm/pip 应用器、备份/回滚、测速、自定义源。当前未包含独立可视化面板；Ping 通过命令/Tool 输出展示。

---

## 1. 一句话目标

为 DSH 提供一个“国内镜像源管理器”：把 GitHub、npm、pip 等常用生态的访问切换到国内镜像，支持自动测速选最快源、显示延迟、手动指定源、自定义源，并让 **Agent 的 Shell 调用、Agent 的网页访问辅助、以及用户自己的终端命令** 尽量共享同一套配置。

---

## 2. 结论先行

### 2.1 能做到的“全局”

| 能力 | 实现方式 | 透明程度 |
|---|---|---|
| Agent 执行 `git clone https://github.com/...` | 写用户级 Git `url.<prefix>.insteadOf` | 新启动的 git 进程透明生效 |
| Agent / 用户执行 npm、pnpm | 写用户级 `~/.npmrc` 的 `registry` | 新启动的 npm/pnpm 透明生效 |
| Agent / 用户执行 pip | 写用户级 pip 配置的 `index-url` | 新启动的 pip 透明生效 |
| Agent 执行任意命令读取上述配置 | 子进程读取同一用户配置 | 下一跳 Shell 调用生效 |
| 测速、显示延迟、手动切换、自定义源 | 插件命令 + Agent Tool | 显式操作 |
| Agent 抓取 GitHub 网页/文件 | `mirror_fetch` 工具调用 `ctx.web.fetch` 改写后的 URL | 需要 Agent 主动调用 |

### 2.2 不能直接做到的“全局”

这部分必须在设计上明确，否则会给出错误预期：

1. **不能拦截任意系统调用。** DSH 插件不是操作系统代理、DNS 服务器或 VPN，无法透明改写任意进程的 socket、TLS 或 `curl` 参数。能透明生效的前提是目标工具自己读取标准配置文件（git/npm/pip 正好满足）。
2. **不能修改当前正在运行的进程环境。** 配置写入后，对“新启动”的命令生效；已运行的 shell、已打开的终端、已启动的构建进程需要重启。
3. **不能用 `ctx.shellEnv` 注入 `NPM_CONFIG_REGISTRY` / `PIP_INDEX_URL`。** DSH 的 `shellEnv` 只允许插件注册 `DSH_*` 变量，不能注入任意环境变量。因此本插件以配置文件为主，不依赖环境变量。
4. **不能透明替换内置 `web_fetch`。** `ctx.web` 在每次调用时选择一个 fetch provider；要透明改写所有网页抓取，必须替换 provider 并复制其安全传输逻辑，风险和成本都高。v1 采用 `mirror_fetch` 辅助工具 + 提示词，不改内置 `web_fetch`。
5. **不能代理模型 API 流量。** LLM 请求走 DSH 的 provider 配置，不属于本插件范围。
6. **不修改系统级配置，不要求管理员权限。** v1 只做用户级配置；系统级属于后续可选能力。

### 2.3 必须修正的一个事实

用户提出“npm、pip 替换为清华源”。经核对：

- 清华 TUNA 提供 PyPI 镜像：`https://pypi.tuna.tsinghua.edu.cn/simple`，可用。
- 清华 TUNA **没有提供 npm registry 镜像**。TUNA 镜像列表中不存在 npm 条目，访问 `/help/npm/` 返回 404。因此不能把 npm 默认源写成“清华源”。

建议默认值：

| 生态 | 默认国内源 | 说明 |
|---|---|---|
| GitHub | `https://gh-proxy.org/` | 按需求指定；支持任意前缀式 GitHub 代理 |
| npm / pnpm | `https://registry.npmmirror.com` | 淘宝 npmmirror，国内 npm 最常用；清华无 npm 源 |
| pip | `https://pypi.tuna.tsinghua.edu.cn/simple` | 清华 TUNA PyPI |

如果团队有自建/企业 npm 镜像，可通过 `/mirror source add npm <id> <baseUrl>` 加入并 `use`。文档后续不再把“清华 npm”作为可行默认值。

---

## 3. 需求拆解

### 3.1 功能需求

**P0（首个可交付版本）**

- 内置源目录：GitHub `gh-proxy.org`、npm `npmmirror`、pip `tuna`。
- 自动测速：对每个候选源做应用层延迟探测，取最快且健康的源。
- 显示延迟：命令与 Tool 返回表格，包含 TCP/TLS/TTFB/状态/失败原因。
- 应用到用户级配置：Git、npm、pip。
- 备份、回滚、幂等应用。
- 手动指定源（内置或自定义）。
- 自定义源：可添加任意前缀式 GitHub 代理、npm registry、PyPI simple index。
- Agent Tool：`mirror`（状态/测速/应用/回滚）、`mirror_fetch`（GitHub URL 改写后交给 `ctx.web.fetch`）。
- 人类斜杠命令：`/mirror ...`。
- 中文/英文界面文案，插件图标与元数据。
- 安全保护：HTTPS、URL 校验、禁止私网探测（可显式放开）、不读写凭据。

**P1（增强）**

- 专用 Web 设置/状态面板：延迟条形图、源 CRUD、一键测速/应用/回滚。
- 更多生态：uv、pnpm 独立配置、Yarn、Cargo、Go、Docker、Hugging Face。
- 定时/启动自动测速与切换。
- 项目级（workspace）配置，不影响用户全局。
- 可选的“透明 web fetch provider”模式（需覆盖 `web.fetchProvider`，默认关闭）。

**P2（不做或需单独立项）**

- 系统级 hosts / DNS / 全局 HTTP(S) 代理。
- TLS 中间人、透明代理。
- 私有仓库代理与凭据托管。
- 模型 API 线路改写。

### 3.2 非目标

- 不做“永久 VPN”或“全局科学上网”。
- 不修改系统证书、hosts、防火墙、WinHTTP。
- 不修改 npm/pip 的认证 token、私钥、`.npmrc` 中的 `_authToken`。
- 不保证第三方镜像的内容完整性、时效性或合规性。

---

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                        DSH Host Process                      │
│                                                             │
│  Settings/Config ─┐                                         │
│  /mirror command ─┼──> MirrorManager                        │
│  mirror tool ─────┤      ├─ SourceCatalog (内置 + 自定义)    │
│  mirror_fetch ────┘      ├─ ProbeEngine (TCP/TLS/TTFB)      │
│                          ├─ Selector (fastest / manual)     │
│                          ├─ Appliers (git/npm/pip)          │
│                          ├─ StateStore (备份/清单/恢复)      │
│                          └─ Safety (URL/SSRF/审批)          │
│                                                             │
│  user-level files: ~/.gitconfig, ~/.npmrc, pip.ini          │
└─────────────────────────────────────────────────────────────┘
              │                              │
              │ 新启动的 git/npm/pip 读取     │ ctx.web.fetch
              ▼                              ▼
       Agent Shell / 用户终端          mirror_fetch 工具
```

### 4.1 模块职责

| 模块 | 职责 |
|---|---|
| `SourceCatalog` | 内置预设 + 用户自定义源；归一化、校验、按生态查询 |
| `ProbeEngine` | DNS、TCP、TLS、HTTP TTFB 探测；采样、超时、并发限制 |
| `Selector` | 按策略选出最快/指定源；失败惩罚、回退（实现在 `probe.js` + `manager.js`） |
| `Appliers` | 将源写入 Git/npm/pip 用户配置；生成变更计划与回滚信息 |
| `StateStore` | 保存备份、上次应用清单、源 ID、探测结果；原子写 |
| `MirrorManager` | 统一编排 status/test/apply/reset；串行化写操作 |
| `Safety` | URL 校验、私网拦截、审批、危险操作确认（`catalog.js`/`probe.js`/`surface.js`） |
| `AgentSurface` | `mirror`、`mirror_fetch` Tool；系统提示词 |
| `CommandSurface` | `/mirror` 人类命令解析与表格渲染 |
| `UI` | P0 使用 `/mirror` 命令 + Tool 输出；P1 独立面板 |

### 4.2 关键设计原则

1. **配置写文件，不写环境变量。** 兼容 git/npm/pip 的原生优先级，避免污染当前进程。
2. **先测速，再写入。** 没有健康源时不应用，避免把环境切到不可用源。
3. **先备份，再修改。** 所有用户配置文件写入前备份；失败自动回滚。
4. **只管理自己的键。** 不重写整个文件，不删除用户的 token、证书、私有源配置。
5. **幂等。** 重复 apply 相同源不产生新变更；状态可重复读取。
6. **人类确认优先。** Agent 主动 apply 需要审批；reset 也需要明确的目标。
7. **不替用户“偷偷”改全局。** 默认 `enabled: false`，安装后先展示状态，首次 apply 由用户触发。

---

## 5. DSH 集成点（已核对）

以下 API 来自当前安装版本的 Inspect 结果，设计时以实际版本为准；实现前再用 `cordis_inspect_query` 复核。

| 需求 | DSH API | 说明 |
|---|---|---|
| 插件入口 | `export function apply(ctx, config)` | 普通 Host 插件 |
| Agent 工具 | `ctx.tools.register(definition)` | 注册 `mirror` / `mirror_fetch` |
| 人类命令 | `ctx.commands.register(definition)` | `/mirror` |
| Agent 提示 | `ctx.systemPrompt.section({name, order, text})` | 固定 order（建议 1200），简短说明 |
| 设置页 | `ctx.settings.configure({ auto: true })` + `Config` | 首个实现未启用；需要 Schemastery 依赖与 Config schema，后续再做 |
| 持久化 | `ctx.storageDomain.open(spec)`（可选） | 没有 storage 时回退到 DSH_HOME 下 JSON 文件 |
| 审批 | `ctx.approval.request(req)` | 仅在打开的 turn 内可用；`allowed-once` 才算通过 |
| Shell 环境 | `ctx.shellEnv.register(...)` | **只用于 `DSH_MIRROR_*` 可见性，不用于 npm/pip 环境变量** |
| 定时器 | `ctx.effect` + `AbortSignal` / `ctx.timer` | 插件卸载时清理 |
| 日志 | `ctx.logger` | 记录应用/回滚/探测失败 |

### 5.1 为什么不在 `ctx.shell` / `ctx.subprocess` 上做拦截

- `ctx.shell` 是单实现服务，加载第二个实现会抛错；替换执行器会破坏沙箱、超时、输出、后台任务等语义。
- `ctx.subprocess` 是进程服务，插件不应包装整个进程树，否则会影响 DSH 自身和其他插件。
- `ctx.tools.pre-execute` 只能 allow/deny/ask/cancel，不能改写工具参数。
- `ctx.shellEnv` 只接受 `DSH_*`，不能注入 `NPM_CONFIG_REGISTRY`。
- 因此，**通过目标工具自己的标准配置文件实现“全局”是唯一低风险且可持续的方案**。

### 5.2 插件包形态

```text
always_in_proxy/
├─ package.json
├─ cordis.patch.yml
├─ index.js
├─ src/
│  ├─ manager.js       # status/test/apply/reset, URL rewrite
│  ├─ catalog.js       # builtin + custom sources, config defaults
│  ├─ probe.js         # DNS/TCP/TLS/TTFB measurement and selector
│  ├─ state.js         # JSON state, applied records, probe cache
│  ├─ appliers.js      # git/npm/pip apply/reset and backups
│  ├─ surface.js       # tools, commands, prompt, shell env
│  └─ util.js
├─ locale/
│  ├─ en.json
│  └─ zh.json
├─ icon.svg
├─ README.md
└─ tests/
   └─ smoke.mjs
```

`cordis.patch.yml` 插入一条：

```yaml
- insert:
    - id: always-in-proxy
      name: '@local/always-in-proxy'
      config:
        enabled: false
        strategy: fastest
```

`package.json` 至少包含：

```json
{
  "name": "@local/always-in-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["index.js", "src/**/*.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

> Config 的 schema 实现可使用 `@deepseek-ai/schemastery`；首个实现为了保持本地 bundle 零依赖，没有导出 Config schema，因此设置页不会生成自动表单，运行配置由 `cordis.patch.yml`、状态文件和 `/mirror` 命令管理。

---

## 6. 数据模型

### 6.1 生态与源

```ts
type Ecosystem = 'github' | 'npm' | 'pip'

type SourceKind =
  | 'github-prefix'   // https://proxy/https://github.com/...
  | 'npm-registry'    // https://registry.example.com
  | 'pypi-index'      // https://pypi.example.com/simple

interface MirrorSource {
  id: string                 // 稳定、唯一，例如 github-ghproxy
  label: string              // 展示名
  ecosystem: Ecosystem
  kind: SourceKind
  baseUrl: string            // 归一化后无尾部斜杠（GitHub 前缀除外）
  probeUrl?: string          // 不填则由内置规则生成
  priority?: number          // 同延迟时的优先顺序，默认 100
  builtin?: boolean
  enabled?: boolean          // 自定义源可临时禁用
}
```

### 6.2 运行时状态

```ts
interface SourceMeasurement {
  sourceId: string
  status: 'ok' | 'fail' | 'timeout'
  samples: number
  dnsMs?: number
  tcpMs?: number
  tlsMs?: number
  ttfbMs?: number          // 主要排序指标
  totalMs?: number
  httpStatus?: number
  error?: string
  measuredAt: number
}

interface AppliedState {
  target: Ecosystem
  sourceId: string
  appliedAt: number
  files: Array<{
    path: string
    backupPath: string
    beforeHash: string
    afterHash: string
  }>
  gitEntriesAdded?: Array<{ key: string; value: string }>
}
```

### 6.3 Config（用户可编辑）

```yaml
enabled: false                 # 总开关；关闭时不允许 apply
strategy: fastest              # fastest | manual
autoApply: false               # 插件启动时自动测速并应用
targets:
  github: true
  npm: true
  pip: true
manual:
  github: github-ghproxy
  npm: npm-npmmirror
  pip: pip-tuna
probe:
  samples: 3
  timeoutMs: 3000
  ttlMs: 300000
  concurrency: 4
safety:
  requireApproval: true
  backupKeep: 10
  allowPrivateHosts: false
customSources: []
```

自定义源示例：

```yaml
customSources:
  - id: npm-company
    label: 公司 npm 镜像
    ecosystem: npm
    kind: npm-registry
    baseUrl: https://npm.example.com
    priority: 10
  - id: github-fast
    label: 我的 GitHub 代理
    ecosystem: github
    kind: github-prefix
    baseUrl: https://gh.example.com/
    probeUrl: https://gh.example.com/https://raw.githubusercontent.com/octocat/Hello-World/master/README
```

### 6.4 内置源

| id | 生态 | baseUrl | 说明 |
|---|---|---|---|
| `github-ghproxy` | github | `https://gh-proxy.org/` | 前缀式；官方文档示例即此格式 |
| `npm-npmmirror` | npm | `https://registry.npmmirror.com` | 国内 npm 默认推荐 |
| `pip-tuna` | pip | `https://pypi.tuna.tsinghua.edu.cn/simple` | 清华 TUNA |

可选内置候选（用于测速对比，不默认选中）：

- `github-ghproxy-com`：`https://gh-proxy.com/`（同服务不同域名，按可用性决定是否保留）。
- `pip-aliyun`：`https://mirrors.aliyun.com/pypi/simple/`。
- 任何自定义源。

> 内置源只作为“起始候选”，用户可以通过设置删除/禁用；不把第三方域名硬编码到不可配置的逻辑里。

---

## 7. 测速与选源

### 7.1 “Ping”的定义

不使用 ICMP。原因：Node 原生没有无特权 ICMP；Windows 下依赖 `ping.exe` 会有编码/防火墙/权限差异；很多镜像禁 ICMP 但 HTTP 可用。

本插件显示的是**应用层延迟**：

- DNS 解析耗时（如可测）
- TCP 建连耗时
- TLS 握手耗时
- HTTP 首字节耗时（TTFB）
- 总耗时

界面列名可以写 `Ping/TTFB`，并在帮助文案中说明“应用层探测，不是 ICMP”。

### 7.2 探测流程

```text
probe(source):
  url = source.probeUrl ?? defaultProbeUrl(source)
  for i in 1..samples:
    连接目标（新连接，不复用 keep-alive）
    记录 dns/tcp/tls/ttfb
    发送 HEAD；若 405/501，改用 GET + Range: bytes=0-0
    读取响应头后立即取消 body（不下载大文件）
  丢弃第一次（冷启动），剩余取中位数
  status = 2xx/3xx ? ok : fail
```

约束：

- 总超时默认 3s/次，整体测速有上限（例如 15s）。
- 并发默认 4，避免同时打多个镜像造成误判。
- 只发 HEAD/Range，不下载完整包。
- 对 401/403 视为不可用（可能被镜像拒绝）。
- 对 5xx 视为失败；对 404 视为“探测路径错误”，在状态中标红并提示用户检查 probeUrl。
- 结果缓存 `ttlMs`（默认 5 分钟）；`/mirror test` 强制刷新。

### 7.3 默认探测 URL

| 生态 | probeUrl |
|---|---|
| GitHub | `https://gh-proxy.org/https://raw.githubusercontent.com/octocat/Hello-World/master/README` |
| npm | `https://registry.npmmirror.com/-/ping`（失败则回退仓库根路径） |
| pip | `https://pypi.tuna.tsinghua.edu.cn/simple/pip/` |

自定义源的 `probeUrl` 必须与源同源或属于同一代理域；否则测速结果没有意义。实现时校验 host 归属。

### 7.4 选源算法

```text
choose(target):
  sources = enabled sources for target
  if config.strategy == 'manual':
     return manual[target] if healthy else fallback

  measurements = measure(sources)
  healthy = measurements where status == 'ok'
  if healthy.empty: return NO_HEALTHY_SOURCE

  score(source) = p50_ttfb + failurePenalty(source)
  failurePenalty = (1 - successRate) * 1000
  sort by (score, priority, sourceId)
  return first
```

- 失败惩罚避免“偶尔成功但经常超时”的源因为一次低延迟被选中。
- 如果最快源与默认源差距小于 20ms，优先默认源，减少抖动。
- 如果 `autoApply` 开启，仅在启动时或手动触发时测速，不持续轮询。
- 应用后如果发现目标源不可用（例如 `npm ping` 失败），提示用户重新 test；v1 不做后台自动切换。

### 7.5 输出示例

```text
/mirror test all

target   source                 ping    tcp    tls    ttfb   status
github   gh-proxy.org           38ms    21ms   33ms   38ms   ok
npm      npmmirror              29ms    18ms   25ms   29ms   ok
pip      tuna                   36ms    24ms   31ms   36ms   ok

* 应用层延迟，3 次采样取中位数；不是 ICMP ping。
```

---

## 8. 应用器设计

### 8.1 Git（GitHub）

目标：让 `git clone https://github.com/owner/repo.git` 自动走代理。

写入用户级 Git 配置：

```text
git config --global --add url."https://gh-proxy.org/https://github.com/".insteadOf "https://github.com/"
```

实现要求：

- 用 `execFile('git', [...])`，不经过 shell，避免注入。
- 先读取现有 `url.*.insteadOf`：
  - 已存在完全相同的 pair：不重复添加，记录 `added: false`。
  - 存在其他 GitHub 代理：不删除用户配置；提示冲突，按策略决定是否覆盖。
- 只处理 `https://github.com/`；不处理 SSH（`git@github.com:`），因为 gh-proxy 不支持 SSH。
- 不代理私有仓库：如果用户当前仓库/URL 是私有的，gh-proxy 可能无法访问，且可能泄露访问模式。v1 不做自动私有仓库检测，文档明确提示；可加 `bypassPrivate: true` 配置。
- 回滚：只删除“本次插件添加的 exact pair”，不删除用户原有的 entries。
- 如果 `git` 不存在：状态显示 `git not found`，只保留文件级状态，不报致命错误。

### 8.2 npm / pnpm

目标：让新启动的 npm/pnpm 使用国内 registry。

写入用户级 `~/.npmrc`：

```ini
registry=https://registry.npmmirror.com
```

实现要求：

- **不重写整个文件**。使用托管块：

```ini
# >>> always-in-proxy >>>
registry=https://registry.npmmirror.com
# <<< always-in-proxy <<<
```

- npm 的 ini 解析器按“后出现的值覆盖前面的值”工作；托管块放在文件末尾，保证生效。
- 保留所有原有行，包括 `_authToken`、`always-auth`、scope registry、代理配置。
- 回滚只删除托管块；如果用户在块内手工改过内容，不自动覆盖，提示冲突。
- 可选写入 `replace-registry-host=always`，让 lockfile 中的旧 registry 地址也被替换；默认关闭，因为它可能影响私有源/企业源。
- pnpm 共享 `.npmrc`；Yarn 1 不保证读取该 registry，v1 不承诺 Yarn。

### 8.3 pip

Windows 用户配置：`%APPDATA%\pip\pip.ini`
macOS/Linux：`~/.config/pip/pip.conf`（并兼容旧 `~/.pip/pip.conf`）

写入：

```ini
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
```

实现要求：

- 用 INI 解析/写回，不整文件覆盖；只改 `[global] index-url`。
- 保留 `extra-index-url`、`trusted-host`、`proxy`、`cert` 等其他键。
- 托管标记可以用注释行；如果目标文件不支持注释，则用结构化字段 + 备份。
- 检测 `PIP_INDEX_URL` 环境变量：如果存在且与目标不同，状态中警告“环境变量优先级更高，配置可能不生效”。
- 不修改 `trusted-host`；默认只接受 HTTPS。
- 回滚恢复原始 `index-url`；如果原本没有该键，删除新增键。

### 8.4 配置文件位置与优先级

| 工具 | 用户级路径（Windows） | 优先级/覆盖 |
|---|---|---|
| git | `%USERPROFILE%\.gitconfig` | 仓库 local config 可能覆盖；`url.*` 多值匹配最长前缀 |
| npm | `%USERPROFILE%\.npmrc` | 项目 `.npmrc`、环境变量、命令行参数可覆盖 |
| pip | `%APPDATA%\pip\pip.ini` | `PIP_INDEX_URL`、命令行 `-i` 可覆盖 |

状态命令应同时展示：

- 插件写入的源
- 文件是否存在/可写
- 探测到的更高优先级覆盖（能检测到的）
- 实际生效值（如可安全调用 `npm config get registry` / `pip config list`）

### 8.5 写入事务

```text
apply(plan):
  assert no concurrent apply (mutex)
  backup each file -> backups/<timestamp>/...
  write temp file in same dir
  fsync + atomic rename
  record AppliedState
  if any step fails:
     restore all backups
     revert git entries added in this transaction
     return error with step and cause
```

细节：

- 备份保留最近 N 份（默认 10），状态文件记录路径和哈希。
- Windows 上目标文件被占用时，重试 2 次后失败；不要强删。
- 符号链接：先 `lstat`，如果是符号链接，解析真实路径后再写，或拒绝并提示（防止写到意外位置）。
- 文件权限：保留原权限；新建文件用 0600（Unix）。
- 幂等：计算 wish state 的哈希；与实际值相同则 `changed: false`。

### 8.6 回滚

`/mirror reset`：

1. 对每个已应用目标，从 `AppliedState` 找到备份和“新增的 git entries”。
2. 恢复文件（或只删除托管块），删除本次新增的 git entries。
3. 清除状态；保留备份供审计。
4. 如果用户手工改过文件（beforeHash 不匹配当前文件），**不盲目覆盖**：返回冲突，让用户选择 `--force`（人类命令）或先手动处理。

---

## 9. Agent 面

### 9.1 `mirror` Tool

建议只注册一个工具，减少 schema 成本：

```json
{
  "name": "mirror",
  "description": "查看或切换国内镜像源。仅在用户要求配置镜像、或网络安装失败时使用。apply/reset 会修改用户级配置文件。",
  "parameters": {
    "action": { "type": "string", "enum": ["status", "test", "apply", "reset", "sources"] },
    "targets": { "type": "array", "items": { "type": "string", "enum": ["github", "npm", "pip"] } },
    "source": { "type": "string", "description": "手动指定 source id；不填则按策略选最快" },
    "dryRun": { "type": "boolean" }
  }
}
```

返回结构：

```json
{
  "ok": true,
  "action": "test",
  "strategy": "fastest",
  "results": [
    {
      "target": "pip",
      "sourceId": "pip-tuna",
      "label": "清华 TUNA",
      "status": "ok",
      "pingMs": 36,
      "tcpMs": 24,
      "tlsMs": 31,
      "ttfbMs": 36
    }
  ],
  "applied": [
    { "target": "pip", "sourceId": "pip-tuna", "changed": true, "file": "C:\\...\\pip.ini" }
  ],
  "warnings": []
}
```

安全约束：

- `apply` / `reset` 前检查 `enabled`；`apply` 默认需要审批（`requireApproval`）。
- Agent 只能使用已配置的源；**不能通过 Tool 任意新增自定义源**。
- `source` 不存在时返回明确错误，不做模糊匹配。
- `reset` 必须显式指定 `targets` 或 `"all"`；不提供隐式全量回滚。
- 工具操作串行化；并发调用返回 `BUSY`，不并行写文件。

### 9.2 `mirror_fetch` Tool（Agent 网页访问辅助）

用途：当 Agent 需要读取 GitHub 网页/raw/release 文件时，用已选 GitHub 代理改写 URL，再复用 DSH 的 `ctx.web.fetch`（保留其 URL 安全、大小、超时限制）。

```json
{
  "name": "mirror_fetch",
  "description": "通过已配置的 GitHub 镜像抓取公开的 GitHub/raw/gist URL。仅支持公开资源；私有仓库请直接用 web_fetch。",
  "parameters": {
    "url": { "type": "string", "description": "原始 GitHub URL" },
    "maxChars": { "type": "integer", "minimum": 1000, "maximum": 100000 }
  }
}
```

实现：

```js
const rewritten = rewriteGithubUrl(args.url, selectedGithubSource)
const result = await ctx.web.fetch({ url: rewritten }, exec.signal)
return { url: result.url, statusCode: result.statusCode, content: truncate(result.body.content) }
```

- 只接受 `https://github.com/`、`https://raw.githubusercontent.com/`、`https://gist.githubusercontent.com/`、`https://api.github.com/` 等白名单 host。
- 拒绝带用户名/密码的 URL、`file:`、`http:`、非 GitHub host。
- 不转发任何 Authorization header（`ctx.web` 本身也是匿名抓取）。
- 私有仓库不代理；文档提示用户直接使用 `web_fetch` 或 git 凭据。
- 如果 `ctx.web` 不存在，工具注册时使用可选注入，调用时返回明确的 `web unavailable`。

> 这仍然不是“透明替换 web_fetch”。它让 Agent 有一个安全、可发现的 GitHub 访问入口；系统提示词会要求 Agent 在抓 GitHub 时优先使用它。

### 9.3 系统提示词

只加一小段，避免每轮 token 成本：

```text
Mirrors are managed by always-in-proxy. Native git/npm/pip commands already
read the user-level mirror config. When a GitHub web/raw URL must be fetched,
use mirror_fetch instead of web_fetch. Do not edit .gitconfig, .npmrc or pip
config manually; use the mirror tool and ask before changing user-wide settings.
```

### 9.4 审批

`mirror` 的 `apply`/`reset` 在 `requireApproval: true` 时调用：

```js
const outcome = await ctx.approval.request({
  agent: exec.agent,
  toolName: 'mirror',
  callId: exec.callId,
  reason: 'Apply fastest mirror sources to user-level git/npm/pip config',
  displayReason: {
    en: 'Apply mirror settings to user-level config files?',
    zh: '要把国内镜像写入用户级 git/npm/pip 配置吗？'
  },
  signal: exec.signal
})
if (outcome !== 'allowed-once') return denied
```

- 没有 agent（例如纯命令）时不需要审批，因为是人类主动操作。
- 审批不可用/被取消时 fail closed。
- 审批只覆盖“写用户级配置”这一件事，不应被复用于其他工具。

### 9.5 Shell 可见性（可选）

`ctx.shellEnv` 不能注入 `NPM_CONFIG_REGISTRY` 等变量，但可以给 Agent 的 Shell 调用提供只读事实，帮助模型判断当前状态：

| 变量 | 示例值 | 说明 |
|---|---|---|
| `DSH_MIRROR_GITHUB` | `gh-proxy.org` | 当前 GitHub 代理 |
| `DSH_MIRROR_NPM` | `npmmirror` | 当前 npm 源 |
| `DSH_MIRROR_PIP` | `tuna` | 当前 pip 源 |
| `DSH_MIRROR_ACTIVE` | `1` | 是否已应用 |

注册示例：

```js
ctx.shellEnv.register({
  name: 'always-in-proxy',
  variables: {
    DSH_MIRROR_GITHUB: { description: 'Active GitHub mirror id or label.' },
    DSH_MIRROR_NPM: { description: 'Active npm mirror id or label.' },
    DSH_MIRROR_PIP: { description: 'Active PyPI mirror id or label.' },
    DSH_MIRROR_ACTIVE: { description: 'Whether user-level mirror config is active.' }
  },
  resolve: () => manager.shellFacts()
})
```

注意：这些变量只是“可见性”，不改变 git/npm/pip 的实际行为；不要在提示词里让模型误以为设置这些变量就能切源。

---

## 10. 人类命令

```text
/mirror                         查看状态（等价 status）
/mirror status
/mirror sources                 列出内置/自定义源
/mirror test [all|github|npm|pip] [--refresh]
/mirror apply [auto|github=<id>|npm=<id>|pip=<id>] [--dry-run]
/mirror use <target> <sourceId>
/mirror reset [all|github|npm|pip] [--force]
```

示例：

```text
/mirror test all
/mirror apply auto
/mirror use pip pip-tuna
/mirror reset pip
```

约束：

- 参数用简单 tokenizer 解析，不经过 shell；源 ID 只允许 `[a-z0-9-]`。
- 输出为紧凑表格 + 下一步提示；不输出长 JSON。
- `/mirror reset all` 在人类命令下可以直接执行，但仍要显示恢复的文件和冲突；`--force` 只在人工明确输入时接受。
- 命令注册失败（例如 commands 服务缺失）不影响工具和已有配置；使用可选注入并记录日志。

---

## 11. 设置与 UI

### 11.1 P0

- ~~使用 `ctx.settings.configure({ auto: true })` 让插件在设置页拥有自动表单。~~ 首个实现未引入 Schemastery 依赖，因此没有自动 Config 表单；配置通过 `cordis.patch.yml`、`/mirror strategy`、`/mirror enable|disable`、`/mirror source add|remove` 和 `manual` 选择管理。
- 已实现的可编辑能力：策略、目标开关、手动源、自定义源、探测参数（Config 文件）、安全选项（Config 文件）。
- `/mirror test` 的输出是 P0 的“显示 ping”方式；`mirror` Tool 返回同样的表格。
- 插件元数据：`meta.title` / `meta.description`，中英文 locale，SVG 图标。
- 标题：
  - zh: `国内镜像源`
  - en: `China Mirror Sources`
- 描述：`测速并切换 GitHub/npm/pip 国内镜像，支持自定义源、用户级配置与回滚。`

### 11.2 P1（可选）

独立 Client 面板：

- 源列表：生态、名称、baseUrl、状态、延迟条。
- “测速全部”按钮，结果实时更新。
- “应用最快”“手动切换”“回滚”按钮。
- 冲突/覆盖提示（例如项目 `.npmrc` 覆盖）。
- 面板通过 Host Remote 调用 `mirror` 服务；不直接读写配置文件。

> 不建议在 P0 做自定义 Client，因为 Host-only 插件已经能通过命令提供完整功能；先验证配置写入和安全，再做可视化。

---

## 12. 状态、持久化与并发

### 12.1 状态位置

优先级：

1. `ctx.storageDomain`（若当前 profile 挂载）——用于应用清单、自定义源、探测缓存。
2. 回退：`$DSH_HOME/always-in-proxy/state.json`（通过 Node `fs` 写，0600）。
3. 备份：`$DSH_HOME/always-in-proxy/backups/<timestamp>/...`。

不使用 `ctx.fs` 写用户目录：`ctx.fs` 受工作区沙箱约束，无法访问 `~/.npmrc` 等用户级路径。Host 插件用 Node `fs`，这是有意的边界；实现时必须做路径校验与备份。

### 12.2 并发

- 单进程内：`MirrorManager` 使用 Promise mutex，所有写操作串行。
- 跨进程：写锁文件 `state.lock`（带 PID/时间戳，超时 30s 视为 stale）；获取失败返回 `BUSY`。
- 外部编辑器同时改配置：写入前比较 `beforeHash`；不一致则失败并提示重试，不覆盖。
- 不后台轮询；测速只在命令/Tool/启动（`autoApply`）时触发。

### 12.3 缓存

- 探测结果 TTL 5 分钟；`/mirror test` 强制刷新。
- 应用状态不缓存，始终以文件和 git 实际值为准。
- 状态读取前做一次轻量校验（文件存在/哈希/当前 git entries）。

---

## 13. 安全设计

### 13.1 URL 与 SSRF

- 只允许 `https:`；HTTP 仅在 `allowInsecure: true` 且用户显式配置时允许。
- 拒绝 URL 中的用户名/密码（`https://user:pass@...`）。
- 探测和 `mirror_fetch` 前解析 DNS，拒绝 loopback、私网、链路本地、组播、保留地址；`allowPrivateHosts` 显式开启后才允许企业内网源。
- `mirror_fetch` 只允许 GitHub host 白名单；`ctx.web` 自身还会做公网校验和连接固定。
- 限制响应大小/字符数、重定向次数、超时；不执行下载内容。
- 不接受 `file:`、`data:`、`javascript:`、UNC 路径。

### 13.2 文件与命令

- Git 用 `execFile`，参数数组固定，不拼 shell。
- 配置文件写入只操作托管块/已知键；不删除 token、证书、私钥。
- 备份文件 0600；备份目录不放入仓库。
- 路径展开用 `os.homedir()` / `process.env.APPDATA`，不信任模型提供的路径。
- 符号链接：解析或拒绝，防止写到链接目标。
- 不在日志中输出 token、cookie、认证头。

### 13.3 用户意图

- 默认关闭；安装后不会自动修改任何配置文件。
- Agent 的 apply/reset 需要审批。
- 自定义源只能由人类通过设置或命令添加；Agent 不能借 Tool 添加任意 URL，避免 SSRF/供应链风险。
- 文档明确：第三方镜像可能缓存过期、内容被替换、记录访问元数据；私有/敏感仓库不要走公共代理。

### 13.4 供应链与合规

- 内置源只使用公开、可信度较高的域名；版本升级时审阅 URL 变更。
- 不自动执行镜像返回的脚本（例如 `curl | bash` 不属于本插件行为）。
- 不承诺镜像合规性；用户需遵守所在组织和地区的网络政策。

---

## 14. 错误处理与可观测性

### 14.1 错误码

| 错误码 | 含义 |
|---|---|
| `MIRROR_DISABLED` | 总开关关闭 |
| `MIRROR_NO_HEALTHY_SOURCE` | 所有候选测速失败 |
| `MIRROR_UNKNOWN_SOURCE` | source id 不存在 |
| `MIRROR_UNSUPPORTED_TARGET` | 生态不支持 |
| `MIRROR_BUSY` | 另一个写操作正在进行 |
| `MIRROR_CONFLICT` | 文件被外部修改/有冲突配置 |
| `MIRROR_PERMISSION_DENIED` | 文件无写权限 |
| `MIRROR_APPROVAL_DENIED` | 审批拒绝/取消 |
| `MIRROR_GIT_NOT_FOUND` | git 不可用（降级，不致命） |
| `MIRROR_PROBE_TIMEOUT` | 探测超时 |
| `MIRROR_INVALID_URL` | URL 校验失败 |
| `MIRROR_UNSAFE_HOST` | 私网/非白名单 host |

### 14.2 日志

- info：apply/reset 计划与结果、选择的源、耗时。
- warn：探测失败、配置被覆盖、git 缺失、写入重试。
- error：事务失败、回滚失败、状态文件损坏。
- 日志带 `target`、`sourceId`、`file`，不带敏感内容。

### 14.3 用户可见状态

```text
always-in-proxy
  enabled: true
  strategy: fastest
  github: gh-proxy.org   (applied, 38ms)
  npm:    npmmirror      (applied, 29ms)
  pip:    tuna           (applied, 36ms)
  last check: 2026-10-17 20:00:00
  warnings:
    - PIP_INDEX_URL is set and overrides pip config
```

---

## 15. 测试计划

### 15.1 单元测试

- `SourceCatalog`：内置源、去重、ID 规则、URL 归一化、无效 URL。
- `ProbeEngine`：mock `net`/`fetch`，验证超时、HEAD 失败回退 GET、采样中位数、失败惩罚。
- `Selector`：最快、手动、无健康源、优先级、20ms 抖动规则。
- `Appliers`：
  - npm 托管块插入/更新/删除，保留 token 行。
  - pip INI 只改 `index-url`，保留其他键。
  - git entries 只删自己添加的 pair，不删用户已有配置。
- `StateStore`：备份、恢复、哈希、锁、损坏状态恢复。
- `Safety`：私网、`file:`、userinfo、非 GitHub host、重定向。
- 命令解析：未知参数、`--dry-run`、非法 source id、引号。

### 15.2 集成测试（临时 HOME）

- 用临时目录模拟 `HOME`/`USERPROFILE`/`APPDATA`。
- 准备带 token 的 `.npmrc`、带 `extra-index-url` 的 `pip.ini`、带用户 `url.*` 的 `.gitconfig`。
- apply → 检查内容 → reset → 检查内容逐字节/语义恢复。
- 模拟外部修改 → 期望 `MIRROR_CONFLICT`，不覆盖。
- 模拟写失败/磁盘满 → 回滚成功。
- 模拟并发 apply → 第二个 `MIRROR_BUSY`。

### 15.3 Windows 实机

- 安装插件，确认 Settings 页面出现、图标/文案正确。
- `/mirror test all` 能显示延迟；断网时显示 timeout 而不是崩溃。
- `/mirror apply auto` 后：
  - `npm config get registry` 返回镜像；
  - `pip config list` 返回 `global.index-url`；
  - `git config --global --get-all url.*.insteadOf` 包含代理；
  - 新开 DSH Agent Shell 执行 `git clone`/`npm install`/`pip install` 走镜像（用 `--dry-run` 或日志验证）。
- `/mirror reset all` 后上述配置恢复。
- 配置目录只读/文件被占用时的错误提示。

### 15.4 安全测试

- `http://127.0.0.1`、`http://[::1]`、`file:///`、`https://user:pass@host` 被拒绝。
- 自定义源指向内网时，默认拒绝；开启 `allowPrivateHosts` 后允许。
- `mirror_fetch` 拒绝非 GitHub host 和私有仓库 URL。
- npm token / pip cert / git 其他配置未被修改。
- 恶意超长 URL、超大响应、重定向链被限制。

### 15.5 性能

- 3 个源 × 3 次采样，总耗时 < 15s。
- apply 正常 < 2s（不含网络测速）。
- 插件空闲时无定时器/无轮询；卸载后无泄漏。

---

## 16. 里程碑

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| M0 | 设计评审、API 复核、Windows 路径/权限验证 | 文档确认；关键限制达成一致 |
| M1 | 源目录、测速、状态、`/mirror test` | 能显示 3 个内置源延迟，不写任何文件 |
| M2 | Git/npm/pip Applier + 备份/回滚 | 临时 HOME 集成测试通过；实机 apply/reset 成功 |
| M3 | `mirror` Tool + 审批 + 提示词 + 自定义源 | Agent 可测速/应用；未审批不能写；自定义源可选中 |
| M4 | `mirror_fetch`、元数据/图标 | Agent 可抓 GitHub；插件信息正常显示 |
| M5 | 独立 UI、设置页、更多生态、自动模式 | 按用户反馈排期 |

---

## 17. 验收标准

1. `/mirror test all` 在 15 秒内返回 GitHub/npm/pip 的延迟与状态；不是 ICMP 时文案明确说明。
2. `/mirror apply auto` 能写入用户级 Git/npm/pip 配置；新启动的 Agent Shell 命令读取到镜像；不修改 token/证书/其他键。
3. `npm`、`pip`、`git` 三者中任意一个未安装时，其他两个仍能正常应用；缺失项显示降级状态。
4. 自定义源可通过设置添加，能被 `test` 和 `use` 选中；非法 URL/私网源默认被拒绝。
5. `/mirror reset` 能恢复应用前的配置；外部修改时拒绝覆盖并提示。
6. Agent `mirror apply` 在未审批时被拒绝；审批通过后只执行一次。
7. 插件禁用/卸载后不残留后台定时器；已写入的用户配置保留，直到用户 reset（文档明确）。
8. 英文/中文元数据、图标正常显示；无默认占位图。设置页为后续项。
9. 无管理员权限要求；不在系统目录写文件。

### 17.1 首个实现的验证记录

- 插件已作为本地 bundle 安装到当前 profile，`mirror` / `mirror_fetch` 两个工具在会话中可见。
- `mirror status`、`mirror sources`、`mirror test`、`mirror apply --dry-run` 已通过实机调用。
- `mirror_fetch` 抓取 `octocat/Hello-World` README 成功（HTTP 200）。
- 临时 HOME 集成测试覆盖 npm 托管块/token 保留、pip `index-url` 局部修改、Git pair 添加/移除、精确回滚、幂等应用。
- **未在真实用户配置上执行 apply**：当前保持 `applied: {}`，需要用户主动执行 `/mirror apply auto` 或 `mirror` Tool 的 apply（审批通过后）。

---

## 18. 风险与开放问题

### 18.1 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 清华无 npm 源 | 无法按原需求“npm 清华” | 默认 npmmirror；允许自定义企业源 |
| 项目级 `.npmrc` / 环境变量覆盖 | 用户以为已切换但实际未生效 | status 检测并警告；文档说明 |
| lockfile 中旧 registry URL | npm 仍可能访问旧源 | 可选 `replace-registry-host=always`；提示重新生成 lockfile |
| 私有仓库走公共代理 | 隐私/可用性问题 | 文档禁止；后续可做私有仓库 bypass |
| 第三方代理稳定性 | 安装失败 | 测速、失败回退、可切自定义源 |
| 配置文件被外部修改 | 覆盖用户改动 | beforeHash/冲突检测，拒绝自动覆盖 |
| Windows 文件占用 | 写入失败 | 重试 + 失败回滚 + 明确错误 |
| 透明 web_fetch 缺失 | Agent 需主动用 `mirror_fetch` | 提示词引导；P1 评估 provider 模式 |

### 18.2 已确认的决策

1. **npm 默认源**：使用 `https://registry.npmmirror.com`；如团队有内部 npm 镜像，通过 `/mirror source add` 添加并 `use`。
2. **“全局”范围**：仅用户级配置，不修改系统级，不需要管理员权限。
3. **Agent 网页访问**：使用 `mirror_fetch` 辅助工具 + 提示词，不透明替换内置 `web_fetch`。
4. **P0 UI**：首个实现使用 `/mirror` 命令 + `mirror` Tool 展示状态/延迟；独立可视化面板延后。
5. **自动应用**：安装后默认不自动修改；`autoApply` 默认 `false`，首次由用户执行 `/mirror apply auto`。

---

## 19. 参考资料

- GH-Proxy 文档：GitHub 加速与 Git 全局配置  
  https://gh-proxy.com/docs/github-accelerator
- 清华 TUNA PyPI 镜像帮助  
  https://mirrors.tuna.tsinghua.edu.cn/help/pypi/
- 清华 TUNA 镜像列表（无 npm registry）  
  https://mirrors.tuna.tsinghua.edu.cn/
- npmmirror 镜像站  
  https://npmmirror.com/
- 当前 DSH 安装中的相关包文档：
  - `@deepseek-ai/dsh-shell-env`：仅允许 `DSH_*` 环境变量
  - `@deepseek-ai/dsh-tool-pwsh`：每次调用新建 `pwsh -Command`
  - `@deepseek-ai/dsh-pwsh-local`：环境分层与配置文件读取行为
  - `@deepseek-ai/dsh-web-fetch-http`：`ctx.web` 的 fetch provider 选择与安全限制

---

## 20. 附：实现骨架（示意，不是最终代码）

```js
// 硬依赖：没有它们插件确实无法提供核心能力
export const inject = ['tools', 'systemPrompt']
export const Config = { /* Schemastery schema */ }

export function apply(ctx, config) {
  const manager = createMirrorManager(ctx, config)

  ctx.effect(() => () => manager.dispose())

  // 可选能力：缺失时降级，而不是让插件加载失败
  const commands = ctx.get('commands')
  commands?.register({
    name: 'mirror',
    description: '查看/测速/切换国内镜像源',
    input: { hint: 'status | test | apply | reset | sources' },
    handler: ({ rawInput, agent, signal }) => manager.runCommand(rawInput, { agent, signal })
  })

  ctx.tools.register(createMirrorTool(manager))

  const web = ctx.get('web')
  if (web !== undefined) {
    ctx.tools.register(createMirrorFetchTool(manager, web))
  }

  ctx.systemPrompt.section({
    name: 'always-in-proxy',
    order: 1200,
    text: 'Mirrors are managed by always-in-proxy...'
  })

  ctx.get('settings')?.configure({ auto: true })

  if (config.autoApply) {
    ctx.effect(() => {
      const controller = new AbortController()
      manager.applyFastest({ signal: controller.signal }).catch((error) => {
        ctx.logger.warn(`always-in-proxy: auto apply failed: ${String(error)}`)
      })
      return () => controller.abort()
    })
  }
}
```

> 注意：`ctx.commands`、`ctx.web`、`ctx.settings`、`ctx.approval`、`ctx.storageDomain` 都可能未挂载，必须用 `ctx.get()` 或可选注入做能力检测；不要因为可选服务缺失让整个插件加载失败。`mirror_fetch` 在 `ctx.web` 缺失时不注册，并在系统提示词中说明该能力不可用。
