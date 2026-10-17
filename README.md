# always-in-proxy

DSH 插件：测速并切换 GitHub / npm / pip 国内镜像，写入用户级配置，支持自定义源、状态查看和回滚。

## 已实现

- GitHub：`gh-proxy.org` 前缀代理，写入 Git 用户级 `url.*.insteadOf`
- npm / pnpm：默认 `https://registry.npmmirror.com`，写入 `~/.npmrc`
- pip：默认清华 TUNA `https://pypi.tuna.tsinghua.edu.cn/simple`，写入用户级 `pip.ini`
- 应用层测速：DNS / TCP / TLS / TTFB，显示中位数延迟
- 自动选择最快源，或手动指定源
- 自定义 GitHub 前缀代理、npm registry、PyPI simple index
- 备份、回滚、冲突检测、幂等应用
- Agent 工具：`mirror`、`mirror_fetch`
- 人类命令：`/mirror ...`
- 可选 `DSH_MIRROR_*` Shell 环境事实

> 清华 TUNA 没有 npm registry 镜像；npm 默认使用 npmmirror。范围仅用户级，不修改系统级配置，不需要管理员权限。

## 使用

在对话中输入：

```text
/mirror
/mirror test all
/mirror apply auto
/mirror apply pip=pip-tuna
/mirror reset pip
```

或让 Agent 调用 `mirror` 工具：

```text
status / sources / test / apply / reset
```

`mirror_fetch` 用于让 Agent 通过镜像抓取公开 GitHub 网页/raw 文件：

```text
mirror_fetch("https://raw.githubusercontent.com/octocat/Hello-World/master/README")
```

## 自定义源

```text
/mirror source add npm npm-company https://npm.example.com "公司 npm 镜像"
/mirror source add github my-proxy https://gh.example.com/
/mirror use npm npm-company
```

自定义源默认必须是 HTTPS；默认拒绝探测私网地址。当前实现没有独立可视化面板，Ping 结果通过 `/mirror test` 或 `mirror` 工具输出。

## 重要限制

- 只改用户级配置文件；已运行的进程不会重新读取配置，新启动的命令才生效。
- 项目级 `.npmrc`、`PIP_INDEX_URL`、`NPM_CONFIG_REGISTRY` 等可能覆盖插件配置。
- GitHub 只处理 HTTPS，不处理 `git@github.com:` SSH。
- 公共 GitHub 代理不适合私有仓库。
- 配置写入需要用户主动执行 `/mirror apply`；不会在安装时自动修改。
- Agent 的 `mirror apply/reset` 默认需要审批；审批不可用时请使用 `/mirror` 命令。

## 开发

```bash
node --check index.js
node --check src/*.js
node tests/smoke.mjs
```

设计文档：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
