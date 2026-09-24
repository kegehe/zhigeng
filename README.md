# note_service

**AI 原生的本地优先个人知识库（Windows 桌面端优先）。**

不是"笔记软件里接一个 AI"，而是整个产品长在 AI 上：你只管往里丢东西，AI 负责整理、串联、回忆，并在合适的时机主动把该看的东西推给你。

判据只有一条：**把全部 AI 模块摘掉，剩下的应该是一个能用但没人愿意用的空壳**。如果只是"少了个润色按钮"，那叫接入 AI。

> 状态：M0 地基完成，M1 进行中。**内核、命令行、桌面端都已真机跑过**（Windows 11 / WebView2）。下面逐项写清哪些是验证过的。

---

## 现在能做什么（已验证）

| 能力 | 怎么验证 |
|---|---|
| Markdown ↔ 块树双向转换，字节级无损往返 | `cargo test -p md-kernel`（19 项，含 proptest 随机恒等往返） |
| Vault 扫描与排除、路径越界拒绝、原子写、回收站、冲突判定 | `cargo test -p note-core --test vault`（10 项） |
| SQLite 索引：全量/增量重建一致、无孤儿索引行、中文分词检索、隐私硬门、链接图 | `cargo test -p note-core --test index`（10 项） |
| 速记捕获：落 `inbox/`、标题推导、重名不覆盖 | `note capture` + 8 项单测 |
| 服务层端到端：新建→编辑→改名→归档→删除→恢复，全程 md 与索引零漂移；删除后入链转悬空、恢复后自动接回；失败的移动不改索引；悬空锚点不再让保存炸掉 | `cargo test -p note-core --test service`（16 项）+ `note reindex <Vault> --dry-run` |
| **块编辑器的无损门槛**：5 个真实语法样本过编辑器后逐字节等于源文件（什么都不改 / 改一处再改回 / 连算两次不变样 / 勾选待办要落盘 / 空笔记不多出换行） | `pnpm test`（`src/editor/roundtrip.test.ts`，22 项）——**这项不绿，行内编辑器不许接到界面上** |
| 桌面端：首启选库、列表/搜索/浏览、速记窗 + `Alt+Shift+N`、托盘、明暗主题 | 真机跑通；同步 IPC p95 4.3–4.6ms（G6 预算 8ms） |
| 编辑与自动保存：停手 800ms 落盘、冲突不覆盖、改名/归档/删除/恢复 | 真机验证；`cargo test -p note-core --test service` |
| 性能基线与预算检查 | `note bench` / `note ipc-bench` / `note write-bench` / `node scripts/guard.mjs` |

正文是**自动保存**的：停手 800ms 或失焦就落盘（Ctrl+S 仍在）。保存带 `expect_hash`——这篇在你编辑期间被别处改过时，界面会给你"用磁盘版本 / 仍然存我这份"，不静默覆盖。

**没做的**：块级所见即所得编辑器（目前只有整篇 Markdown 源码编辑）、目录树 UI、反链与标签视图、
导入 Notion/Obsidian、任何 AI 调用（M2 起）、macOS/Linux、云同步。
**做了但还没验**：NSIS 安装包（`bundle.active` 仍为 `false`）、纯 Win10 上的 Mica 降级、崩溃强杀下的落盘一致性。

---

## 快速开始

### 环境

- Windows 10/11；**Rust ≥ 1.85**（实测 1.95）、**Node ≥ 20**（实测 22）、pnpm ≥ 10
- MSVC 工具链（VS 2022 Build Tools + Windows SDK）
- WebView2 Runtime（Win11 自带；Win10 由安装器带 bootstrapper）

### 装依赖与跑测试

```bash
pnpm install
cargo test --workspace          # 47 项，应全绿
node scripts/guard.mjs          # 护栏：依赖方向 / 预算键 / 样式禁止清单
pnpm build                      # 前端类型检查 + 打包
```

### 命令行内核

```bash
cargo build -p note-cli

# 准备一个 Vault（目录必须先存在，命令不会替你决定数据放哪儿）
# cmd 里：mkdir D:\Notes   或在资源管理器里新建
./target/debug/note.exe capture D:\Notes "第一条想法：分节渲染要实测才知道代价"
./target/debug/note.exe reindex  D:\Notes
./target/debug/note.exe search   D:\Notes 分词
./target/debug/note.exe scan     D:\Notes
./target/debug/note.exe parse    testdata/roundtrip/02-列表.md --check-canonical

# 性能
./target/debug/note.exe bench      --notes 5000   # 扫描/重建/检索吞吐
./target/debug/note.exe ipc-bench                # 同步读命令 p95，红线 8ms
./target/debug/note.exe write-bench --notes 2000   # 写路径 p95（当前超线，见上）
./target/debug/note.exe capture . --bench 150    # 捕获分段计时（写进临时库，不碰真实 Vault）
```

### 图形界面

```bash
pnpm tauri dev      # 首次编译较久。默认热键 Alt+Shift+N 唤起速记窗
pnpm dev            # 只起前端（http://127.0.0.1:1425/），此时没有 Tauri 运行时，界面会明确提示
```

第一次启动会让你**确认笔记目录**（默认 `D:\Notes`，没有 D 盘则回落 `%USERPROFILE%\Notes`），
不会静默建库。确认后速记内容落 `<Vault>/inbox/`，改目录只要重开一个 Vault。

安装包尚未产出：`src-tauri/tauri.conf.json` 里 `bundle.active` 还是 `false`，图标是脚本画的占位字形。

---

## 它是怎么设计的

### 三条最根本的决定

1. **Markdown 文件是唯一真相源。** `<Vault>/.note/index.db` 是纯派生物——删掉它必须能靠扫描 Vault 完整重建，重建器与增量解析共用同一份代码。派生的东西（分词、向量、切片边界、AI 过程数据）永远不进 `.md` 文件。
2. **块（block）是可寻址的最小单元。** 每块带稳定 ID，写成 Obsidian 原生语法 ` ^b-k3x9m2v7qa`，所以用户在 Obsidian 里写的 `[[笔记#^b-xxx]]` 我们直接认，反之亦然。AI 的每条引用都能精确点回原文。
3. **AI 不得静默改写笔记。** AI 的一切写意图先落 `suggestions` 表，用户在建议箱里逐条看 diff、接受后才写盘；`link`/`merge`/`split`/`archive`/`restructure` 在代码层禁止自动执行。**无引用不作答**，隐私过滤在 SQL 层完成而不是靠 prompt。

### 后端 = 本地服务层

没有远程后端（无账号、单用户）。所谓后端是进程内的 `note-core`，被三个入口共用：

```
   Tauri IPC (UI)   ┐
   note CLI (基准)   ├──►  service::Hub  ──►  领域层 / 存储层 / AI 网关
   MCP server (待做) ┘
```

只有服务层可被外部调用，只有存储层可碰磁盘和数据库——否则 CLI 和 UI 会走出不一样的索引，这类 bug 极难查。同步命令的硬上限是 **8ms**，超了必须改成"立即返回 + 事件流"。

### 一个 Vault 长什么样

```
<Vault>/
  inbox/        速记落这里，AI 整理的输入
  notes/        正式笔记，可自由建子目录
  archive/      归档（移动即生效，状态由目录推导，不写进 front-matter）
  views/        动态视图定义（只是查询，不参与检索）
  attachments/  二进制资产，SHA-256 内容寻址命名
  .note/        应用私有：index.db / trash / versions / cache / logs（可再生）
```

整个 Vault 复制一份就是完整迁移（只有 API Key 存在 Windows 凭据管理器里，换机需重输——刻意的安全取舍）。

### 七条全局不变量

G1 Markdown 唯一真相源 · G2 摘掉 AI 必须是空壳 · G3 AI 不得静默改写 · G4 无引用不作答 · G5 无损往返 · G6 同步调用 ≤ 8ms 且打字到屏幕 ≤ 16ms · G7 任何动作 100ms 内有反馈。详见 `docs/00-文档导航.md`。

---

## 实测性能（5000 篇 / debug 构建）

| 指标 | 实测 | 预算 |
|---|---|---|
| 全量重建索引 | 6.8s（外推 2 万篇 ≈ 27s） | < 60s |
| `scan` 5000 个文件 | 256ms | — |
| 关键词检索 p95 | 9ms | < 80ms |
| 同步命令 p95（最差 `search_keyword`） | 1.35ms | < 8ms |
| 捕获落盘（含 fsync）p95 | 2.69ms | < 8ms |
| 单篇增量索引 p95 | 7.33ms | 超线 → 已改异步 |

数字都记在 `perf-budget.json`，由 `scripts/guard.mjs` 把关。release 构建尚未测。

---

## 仓库结构

```
crates/
  md-kernel/    Markdown ↔ 块树，无损往返的唯一实现点（不依赖 SQLite、不依赖 Tauri）
  note-core/    后端服务层：vault / index / capture / service / schema
  note-cli/     note 命令行：scan · reindex · search · capture · bench · ipc-bench · write-bench · write-profile · parse
src-tauri/      薄壳：窗口、托盘、单实例、全局热键、Mica、command 注册
src/            React 19 + TS + Tailwind v4；ui/tokens.css 是全仓库唯一允许颜色字面量的地方
docs/           规格即真相：00 导航 · 01 范围 · 02 数据模型 · 03 架构 · 04 AI · 05 路线图 · 06 样式 · adr/
testdata/       往返 golden 语料
probes/         一次性验证原型（Spike C，允许丢弃）
scripts/        guard.mjs：CI 护栏
```

依赖方向单向：`src-tauri` / `note-cli` / `note-mcp` → `note-core` → `md-kernel`。

---

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 地基：块模型、索引与重建器、CLI、壳 | 基本完成，缺真机安装器验证 |
| **M1** | 能记能查（**全程无需 API Key**） | 进行中：捕获已好，编辑器/目录树/搜索 UI/导入待做 |
| **M2** | 记忆层：混合检索 + 强制引用问答 + 评测集 | 未开始 |
| **M3** | 组织层：建议箱、自动整理、动态视图、图谱 | 未开始 |
| **M4** | 主动层：定时整理、周期回顾、关联推送（差异化重心） | 未开始 |
| **M5** | 生成层 + Agent + MCP Server 暴露 | 未开始 |

每档的**验收标准**写在 `docs/05-路线图与验收标准.md`，不达标不进下一档。

## 明确不做

登录与账号、权限与角色、多人协作与评论、云端托管与多端同步、Web/移动端、计费配额、macOS/Linux 适配、和 Notion 拼块编辑器细节。理由见 `docs/01`。

---

## 开发约定

- **文档是规格不是笔记**：中文文件名带序号；SQL、目录、字段名即最终规格；同一事实只在一处定义（块类型→02，建议枚举→04，阈值→03，范围→01，里程碑→05）。
- **推翻既定决定要写 ADR**：`docs/adr/` 下 `ADR-NNN-中文标题.md`，说明背景、选项、结论、代价。已有 4 条，其中 ADR-004 是**被实测数据推翻后重写的**。
- 提交前跑：`cargo fmt --all` · `cargo test --workspace` · `pnpm test` · `node scripts/guard.mjs`。
- 测试名用中文短语（读失败信息更快），已配 `#![allow(non_snake_case)]`。

## 许可

还没定。`Cargo.toml` 里暂写 `MIT`，但仓库内**没有 LICENSE 文件**——正式开源前需要明确一次（这决定别人能不能商用、要不要署名，不该由代码注释顺手定）。
