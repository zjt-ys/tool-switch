# tool-switch

DeepSeek Harness 插件：按对话开关可调用工具（用户和 AI 都能切换），并内置「工具自检」提示词策略——模型接手任务时先关掉用不上的工具族，需要时再打开。

## 功能

- **三个入口，一份逻辑**：设置页（`settings.section`）、会话头快捷面板、AI 的 `tool_switch` / `tool_switch_manage` 工具，操作的都是同一份状态
- **自动分类**：按工具名自动分组（`mcp:rea` / `mcp:rea/inspect` 这类嵌套族，`core` 收拢无分隔符的名字），新装插件零配置入组
- **用户分组**：可自建分组、嵌套、指定成员；分组开关覆盖组内全部工具
- **会话级 + 全局默认**：每个对话可单独切换，全局默认决定新对话的初始状态；`apply-all` 一键把当前会话状态铺到所有对话
- **工具自检策略**：向系统提示词注入一段策略，要求模型先看工具目录、按族关掉本次用不上的重型工具（如 REA 的 200+ 个 schema）；策略可在设置页编辑（开关 / 点名的工具族 / 附加要求 / 注入预览），只有当 `tool_switch` 本身可调用时才注入
- **AI 可读清单**：全部工具、分组、全局默认写进 `$DSH_HOME/tool-switch/*.json`，AI 和用户读同一份

## 安装

在 DeepSeek Harness 里用 Plugin Manager 安装本目录（bundle 方式）：

```
plugin_manager install_bundle → E:\工作区\tool-switch
```

或把本包 clone 到任意目录后以 `file:` 依赖挂进 profile。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：工具注册表装配、`/tool-switch` 命令、两个模型工具、`/api/tool-switch/*` 路由、提示词策略 |
| `client.js` | 浏览器半：设置页（分组树、搜索、策略编辑、会话面板） |
| `groups.js` | 分类纯函数：自动分组路径、覆盖判断、树构建（自底向上聚合） |
| `store.js` | 持久层：原子写 JSON 文档、合并写入器 |
| `test/` | `node --test` 回归测试（零依赖） |

## 测试

```powershell
node --test test/policy.test.mjs
```

## 状态文件

- `tools.json` — 工具清单（AI 可读目录）
- `groups.json` — 用户分组
- `state.json` — 全局默认（关闭名单）
- `policy.json` — 工具自检策略

## License

MIT
