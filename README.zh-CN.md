# pi-session-history

[English](./README.md) | [中文](./README.zh-CN.md)

无需离开 Agent，即可搜索、查看并恢复历史 [Pi](https://github.com/earendil-works/pi) 编程会话。

安装后可以直接对 Pi 说：

```text
搜索我之前关于“数据库迁移”的会话，然后打开最相关的结果。
```

Agent 会调用只读的 `pi_history` Tool，搜索 Pi 本地 JSONL 会话存储，并按范围读取规范化后的转录。交互用户也可以运行 `/history`，预览、交给 Agent 分析或恢复某个会话。

## 为什么需要它

Pi 的本地会话文件保存了技术决策、失败尝试、工具输出和实现上下文。内置会话选择器适合恢复一个已知会话，但 Agent 本身不能把历史会话作为可检索材料。`pi-session-history` 用一个有界、只读的 Tool 补上这条路径。

## 提供的能力

- 跨项目词法搜索，或只筛选当前工作目录。
- 通过 [`@letta-ai/trajectory`](https://github.com/letta-ai/trajectory) 规范化消息、推理、工具调用和工具结果。
- 按规范化记录分页读取转录。
- 默认排除当前活动会话，避免搜索命中自身。
- `/history` 交互选择器，支持预览、交给 Agent 和恢复会话。
- 不建立索引、不收集遥测，也不通过网络传输会话内容。

## 环境要求

- Pi `0.80.10` 或兼容的更高版本。CI 中的宿主包固定为 `0.80.10`。
- Node.js `20` 或更高版本。

## 安装

### npm

```bash
pi install npm:pi-session-history
```

### Git

```bash
pi install git:github.com/yoyooyooo/pi-session-history
```

### 本地源码

```bash
git clone https://github.com/yoyooyooo/pi-session-history.git
cd pi-session-history
npm install
pi install .
```

安装后重启 Pi，或运行 `/reload`。

## 快速开始

1. 安装并重载插件。
2. 对 Pi 说：

   ```text
   查找我之前关于缓存失效的 Pi 会话，并总结里面的关键决策。
   ```

3. Agent 应先用 `action: "search"` 调用 `pi_history`，再使用返回的精确路径调用 `action: "read"`。
4. 成功的搜索结果包含会话标题、路径、工作目录、更新时间、命中摘录和分页信息。

直接交互使用：

```text
/history
/history 缓存失效
```

不修改 Pi 设置的临时加载验证：

```bash
pi --no-extensions -e . --list-models
```

## Agent Tool

本包注册一个 Tool：

```text
pi_history
```

它支持三个 action。

### Search

```json
{
  "action": "search",
  "query": "database migration",
  "limit": 10
}
```

搜索不区分大小写，采用词法匹配。空白分隔的查询词使用 AND 语义：每个查询词都必须出现在同一会话中，但可以分别出现在不同记录里。

### List

```json
{
  "action": "list",
  "limit": 10,
  "scope": "cwd"
}
```

`scope` 可以是：

- `all`：检查本地 Pi 存储中的所有项目，这是默认值。
- `cwd`：只保留记录工作目录与当前 Pi 工作目录相同的会话。

### Read

应优先使用 `search` 或 `list` 返回的精确路径：

```json
{
  "action": "read",
  "session": "/home/me/.pi/agent/sessions/.../session.jsonl",
  "offset": 0,
  "recordLimit": 80,
  "maxCharacters": 30000
}
```

当 `details.hasMore` 为 true 时，从 `details.nextOffset` 继续。当 `details.recordTruncated` 为 true 时，应先增大 `maxCharacters` 并重试当前 offset，再向后翻页。

精确路径只有在规范化解析后仍位于 Pi 会话目录中才会被接受。也可以传会话 ID，但它必须能在所选 `scanLimit` 范围内唯一定位。

### 参数

| 参数             | 适用 action      |  默认值 |    上限 | 说明                                 |
| ---------------- | ---------------- | ------: | ------: | ------------------------------------ |
| `query`          | `search`         |       — |       — | 必填的词法查询。                     |
| `session`        | `read`           |       — |       — | 必填的会话 ID 或精确结果路径。       |
| `scope`          | 全部             |   `all` |       — | `all` 或 `cwd`。                     |
| `limit`          | `list`、`search` |    `10` |    `50` | 最大返回结果数。                     |
| `scanLimit`      | 全部             |  `1000` |  `5000` | 最多检查多少个最新会话文件。         |
| `includeCurrent` | 全部             | `false` |       — | 是否包含当前活动会话。               |
| `offset`         | `read`           |     `0` |       — | 规范化记录偏移量。                   |
| `recordLimit`    | `read`           |    `80` |   `200` | 单次响应考虑的记录数。               |
| `maxCharacters`  | `read`           | `30000` | `50000` | 应用全局 Tool 输出限制前的字符预算。 |

所有 Tool 响应还会受到 50 KiB UTF-8 和 2,000 行的全局限制，以先达到者为准。

## 交互命令

```text
/history
/history database migration
```

命令会打开会话选择器，并提供三个动作：

1. 预览规范化转录。
2. 把会话路径插入编辑器，请 Agent 分析。
3. 恢复所选 Pi 会话。

该命令依赖 Pi 交互 UI。`pi_history` Tool 才是 Agent 的自主检索接口。

## 存储与性能

插件按以下顺序查找会话：

1. 已设置的 `$PI_CODING_AGENT_DIR`。
2. 默认的 `~/.pi/agent`。

会话文件应位于 `<agent-dir>/sessions/<project>/*.jsonl`。

其他行为：

- `list` 收集到请求数量的合格会话后停止。
- `search` 会扫描所选 `scanLimit` 的完整范围，以保证排序有意义。
- 完整 JSONL 行会被组合成约 1 MiB 的规范化批次；单个超大 JSONL 行可能超过这个批次目标。
- 格式错误或不可读的会话会被跳过并计数。
- 只要仍含有可用记录，部分写入或被中断的会话也可以读取。
- 本包不维护持久索引，因此搜索成本随所选语料规模增长。

## 隐私与安全

Pi 扩展使用用户自身权限执行。安装第三方扩展前应审查源码。

`pi-session-history` 是只读插件：

- 不修改或删除会话文件。
- 不发起网络请求。
- 会返回本地会话路径，因为后续读取需要稳定标识。
- 精确路径会在规范化路径和符号链接解析后限制在 Pi 会话目录内。
- 搜索结果和转录内容会在进入 Agent 上下文前执行输出限制。

会话内容可能包含源码、工具输出、文件路径、其他工具曾打印的凭据或其他敏感数据。应把 Tool 结果和日志视为敏感材料。

私下报告漏洞的方法见 [SECURITY.md](SECURITY.md)。

## 限制

- 搜索是词法匹配，不是语义搜索或向量检索。
- 会话分支共用一个追加式 JSONL 文件。规范化读取保留文件记录顺序，不会只选择活动分支。
- `@letta-ai/trajectory` 会在规范化阶段限制超大的工具参数和工具结果。
- 本包通过 trajectory 兼容的 OpenClaw adapter 读取 Pi 当前的 SessionManager JSONL 结构。

## 更新与卸载

```bash
pi update npm:pi-session-history
pi remove npm:pi-session-history
```

Git 安装可以运行 `pi update --extensions`，或安装新的固定 ref。

## 开发

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run check
```

`npm run check` 会执行格式检查、lint、类型检查、测试和 npm 打包预检。

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。首次发布后，后续版本通过版本 tag 和 `.github/workflows/publish.yml` 中的 npm Trusted Publishing 发布。

## 许可证

[MIT](LICENSE)
