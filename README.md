# dsh-plugin-manager

DSH（DeepSeek Harness）Web 插件：在浏览器里**启用 / 禁用任意已安装插件**，并对每一次插件**下载做审计**（记录来源与时间）。

解决的问题：

- dsh 自带的插件清单（plugin-inventory）是**只读**的，没有启停开关；
- 装过的插件「什么时候装的、从哪来的」没有记录。

## 功能

- **插件列表**：组合出 dsh web 当前的全部插件行（含 bundle 归属、版本、描述、来源仓库、注册表、tarball、安装时间），核心组件（`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 的行）标记为受保护、不可切换；
- **启用 / 禁用**：向 profile 的 `cordis.patch.yml` 写入 `{id, disabled}` 覆盖行——与 dsh 官方 telemetry 开关同一机制，dsh web 通过 HMR **即时生效**，无需重启（个别 UI 变化可能需要刷新页面）；
- **下载审计**：监听 profile 的 `package.json` / `pnpm-lock.yaml` / `.npmrc`，插件安装 / 更新 / 移除时自动追加一条 JSONL 记录：事件、包名、版本、来源仓库、注册表、tarball、安装时间（node_modules 目录 mtime）、发现方式。dsh 未运行期间的变更在下次启动补记为基线；
- **审计日志**：`~/.dsh/plugin-manager/audit.jsonl`（与状态快照 `state.json` 同目录）。

## 安装

```sh
# 在插件源码目录外执行（本包无构建步骤，直接安装目录即可）
dsh plugin --profile web add file:D:/path/to/dsh-plugin-manager
```

然后重启 `dsh web`。侧边栏右下角出现 🧩 悬浮按钮，点击打开「插件管理」面板。

依赖：`yaml`（由 pnpm 自动安装）。Node >= 22.19。

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-manager
```

审计日志文件保留在 `~/.dsh/plugin-manager/`。

## 工作原理

- **启停**：`lib/core.js` 把 profile 目录下 `cordis.patch.yml`（用户 patch 层，被 dsh web 的 HMR 实时监听）作为开关存储。禁用 = 追加 `- id: <rowId>\n  disabled: true`；启用 = 移除该行。文件用 yaml Document API 原地修改，保留注释与无关条目；包含 `!!js` 表达式的既有文件会被拒绝改写（避免破坏）。
- **组合**：按 `dsh.profile.bundles` 顺序解析每个 bundle 的 `cordis.patch.yml`（`!!js` 中性化为字符串后解析，绝不求值），再叠加用户层，得到与 `dsh --dump-config` 一致的完整行树，并标注每行来自哪个 bundle。
- **审计**：5 秒轮询 profile 关键文件 mtime；变化时对比状态快照，diff 出安装 / 更新 / 移除事件，附上 `package.json` 的 repository / homepage、`.npmrc` 的 registry、`pnpm-lock.yaml` 的 tarball。
- **安全**：所有 HTTP 路由 `/api/dsh-plugin-manager/*` 仅限本机回环访问（同源校验），与 dsh-web-ui 设置桥同一围栏。

## HTTP API（loopback only）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-plugin-manager/plugins` | 全部插件行（含 enabled / protected / 来源 / 安装时间） |
| POST | `/api/dsh-plugin-manager/plugins/toggle` | `{rowId, enabled}`，写 patch 层 |
| GET | `/api/dsh-plugin-manager/audit` | 最近 300 条审计记录（新在前） |
| POST | `/api/dsh-plugin-manager/audit/rescan` | 立即扫描一次变更 |

## 测试

```sh
node test/core.test.mjs   # fixture 组合/启停往返 + 真实 profile 只读列举
```

## License

MIT
