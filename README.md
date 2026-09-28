# note_service

**AI 原生的本地优先个人知识库（Windows 桌面端优先）。**

不是"笔记软件里接一个 AI"，而是整个产品长在 AI 上：你只管往里丢东西，AI 负责整理、串联、回忆，并在合适的时机主动把该看的东西推给你。

判据只有一条：**把全部 AI 模块摘掉，剩下的应该是一个能用但没人愿意用的空壳**。如果只是"少了个润色按钮"，那叫接入 AI。

> 状态：M0 地基完成（欠账列在 §路线图），M1 进行中。**内核、命令行、桌面端都已真机跑过**（Windows 11 / WebView2）。下面逐项写清哪些是验证过的。

---

## 现在能做什么（已验证）

| 能力 | 怎么验证 |
|---|---|
| Markdown ↔ 块树双向转换，字节级无损往返 | `cargo test -p md-kernel`（19 项，含 proptest 随机恒等往返） |
| Vault 扫描与排除、路径越界拒绝、原子写、回收站、冲突判定 | `cargo test -p note-core --test vault`（10 项） |
| SQLite 索引：全量/增量重建一致、无孤儿索引行、中文分词检索、隐私硬门、链接图、标签与属性分列入库 | `cargo test -p note-core --test index`（16 项） |
| 速记捕获：落 `inbox/`、标题推导、重名不覆盖 | `note capture` + 9 项单测 |
| 服务层端到端：新建→编辑→改名→归档→删除→恢复，全程 md 与索引零漂移；删除后入链转悬空、恢复后自动接回；失败的移动不改索引；悬空锚点不再让保存炸掉；外部改盘/新建/删除后索引自己收敛 | `cargo test -p note-core --test service`（22 项）+ `note reindex <Vault> --dry-run` |
| **块编辑器的无损门槛**：6 个真实语法样本过编辑器后逐字节等于源文件（什么都不改 / 改一处再改回 / 连算两次不变样 / 勾选待办要落盘 / 空笔记不多出换行 / **块类型切换与绕圈回到原样** / 不透明块拒绝被洗成段落 / **拖拽重排后空白按 Markdown 规矩重算** / **改不透明块不许把整块写成空** / **工具栏插入的三种骨架内核按字节认回** / **回车拆段不许把原块的账本留给新块**） | `pnpm test`（`src/editor/roundtrip.test.ts`，56 项）——**这项不绿，行内编辑器不许接到界面上**。已接上，且**浏览与编辑是同一个实例**（只读视图不再另养一份渲染器）：真机在含表格/代码/嵌套列表/引用/`^b-` 锚点/`due::`/`$E=mc^2$` 的笔记里打一次字，文件只多出那一个字符，其余逐字节不动；DOM 标记跨"浏览↔编辑"存活，全程实例数为 1 |
| 桌面端：首启选库、列表/搜索/浏览、速记窗 + `Alt+Shift+N`、托盘、明暗主题 | 真机跑通；同步 IPC p95 4.3–4.6ms（G6 预算 8ms） |
| 编辑与自动保存：停手 800ms 落盘、冲突不覆盖、改名/归档/删除/恢复 | 真机验证；`cargo test -p note-core --test service` |
| **打开笔记就能打字**（没有"编辑模式"这回事）+ 常驻工具栏 14 个控件（块类型 10 种 / 加粗斜体删除线行内码 / 链接 / 清除格式 / 插入分隔线·引用·表格 / 上下移 / 撤销重做）+ 选区气泡 + `/` 块菜单 + 行首前缀起块 + `Alt+↑↓` 移动整块 | 真机：`#` + 空格 → 落盘 `# 第 2 段…`（`#` 与触发空格都被吃掉）；选中四字 → 气泡 → 加粗落盘带 `**`；空行敲 `/` → 块菜单，且**越过自动保存窗口菜单还在**。类型切换给 10 种（正文 / 标题 1–6 / 无序 / 有序 / 待办），插入给 3 种结构块（分隔线 / 引用 / 表格）——**它们的源文本先由 `testdata/roundtrip/06-插入骨架.md` 让内核按字节认回来**，再往界面上放；字号 / 居中 / 颜色仍然不放，Markdown 没有那种语法，给了就是拿用户的字节换一个大按钮（见 [02] D27） |
| **常驻顶部工具栏**（块类型下拉 + 加粗 / 斜体 / 删除线 / 行内码 + 撤销重做），跟着光标所在块实时高亮 | 真机六项：不选东西也在、下拉随块变（停在列表项就显示"无序列表"）、下拉选标题 2 → 落盘只有那一行变成 `## `、**重复选同一类型不产生落盘**、工具栏加粗 → `**`、撤销/重做都回得去、滚动 400px 后仍粘在屏内。链接后来补进这条栏——**与气泡共用同一个 `LinkEditor` 组件**，两处各写一份输入框早晚分叉 |
| 行首 `⋮` 手柄：鼠标停在哪个块就贴到哪一块，点开改类型、按住拖拽排序 | 真机：手柄 top 与该块 offsetTop 一致；点手柄出七项菜单 → 段落变 `- 项`、再点回正文**整篇回到源文件字节**；拖第一段到末尾后**逐字节等于期望**（`- 项甲\n- 项乙\n\n第四段\n\n第一段\n`）——列表后面那段前自动补出空行，不会被读成列表项的续行；`^b-p1` / `^b-p4` 各自跟着自己的块走，链接指向不漂 |
| 块操作全键盘可做（`Alt+↑/↓` 移动整块、`Ctrl+Alt+0–3` 改正文/标题、`Ctrl+Shift+7/8/9` 改三种列表） | 记法跟 Google Docs，与手柄/下拉/`/` 共用同一批函数；真机：连按两次 `Alt+↓` 光标始终跟着那一块走、`Ctrl+Alt+2` → `## 第一段`、`Ctrl+Shift+8` → `- 第一段`、再 `Ctrl+Alt+0` + `Alt+↑` 两次 → **整篇逐字节等于源文件**。键表与三条实现口径见 [03] §块级快捷键 |
| 焦点指示落在**当前块**（左页边一条竖线），不给整篇套圈 | 真机：`outline-style: none`、竖线 `top` 与所在块 `offsetTop` 一致、按方向键跟着走；**连按 5 次方向键之后文件指纹一字未变**（标记只写 DOM，不发事务，所以"挪光标"永远不会变成"改笔记"） |
| 外部改了文件，界面自己跟上（Obsidian / 编辑器 / 同步盘） | `note-core::watch` 递归监听 + hash 闸门；真机：外部改一篇 400ms 后正文更新，新建/删除的笔记自己进出列表。正在编辑的一篇**不会**被冲掉 |
| 标签与属性进了索引（`tags` / `props`） | front-matter 的 `tags:` / `props:` 按类型分列落库，改一次不残留；视图界面还没做，缺的只是读接口 |
| 导入外部 Markdown（Obsidian 库、一个目录）：预览 → 落盘 → 逐篇索引 | `note import <Vault> <源目录>`（默认只预览，加 `--apply` 才写）；界面侧栏「导入」。内容不改字节、子目录保留、同名不同内容一律避让不覆盖。1000 篇规模用例在 `cargo test` 里钉住 |
| 每日快照备份到第二个目录：增量、保留 30 份、按篇恢复 | `note backup <Vault> --dir <另一个盘>`，再加 `--list` / `--history` / `--restore`；界面里是侧栏的「备份」面板与首启第二步。真机走通：改坏一篇 → 恢复 → 内容逐字节回来，被覆盖的那份留在 `.note/conflicts/` |
| 性能基线与预算检查 | `node scripts/check.mjs --bench`（把 `note ipc-bench` / `note write-bench` 接进同一条命令，超线即非零退出）· `note bench` · `scripts/guard.mjs` |
| 长文档（验收 ⑥，2999 块 / 490KB，release 真机）：滚动 0 掉帧、打字事件处理 p95 0.2ms、打开编辑器 297ms | CDP 发可信按键 + Event Timing，方法写在 [ADR-004] §真机测量结果；"输入到呈现 P95 < 16ms" 这条写法在 60Hz 上不可达，口径已按实测改成"≤ 一帧"（120Hz 16ms / 60Hz 33ms） |

正文是**自动保存**的：停手 800ms 或失焦就落盘（Ctrl+S 仍在）。保存带 `expect_hash`——这篇在你编辑期间被别处改过时，界面会给你"用磁盘版本 / 仍然存我这份"，不静默覆盖。

**没做的**：目录树 UI、反链视图（`links` 表有数据但没有读接口）、
命令面板、标签与属性的**视图界面**（数据已经在库里，缺读接口）、
Notion 的 zip 导入（MD/Obsidian 已可做）、导出、任何 AI 调用（M2 起）、macOS/Linux、云同步。
**做了但还没验**：NSIS 安装包（`bundle.active` 仍为 `false`）、纯 Win10 上的 Mica 降级、崩溃强杀下的落盘一致性。
**已关闭的性能硬伤**：后台补索引曾与读命令抢同一把 `Hub` 锁——保存一篇 2702 块的笔记后，下一个读命令 dev 实测要等 **3.26 秒**。现在补索引走**第二条连接**并把单篇的三步包进**一个事务**，同一动作降到 **96ms**（稳态 19ms，预算 80ms；剩下的 16ms 是 WAL 正在写 5MB 时读方的代价，解法是分批提交，不是回到一把锁）。见 [03] §后端调用纪律。

---

## 快速开始

### 环境

- Windows 10/11；**Rust ≥ 1.85**（实测 1.95）、**Node ≥ 20**（实测 22）、pnpm ≥ 10
- MSVC 工具链（VS 2022 Build Tools + Windows SDK）
- WebView2 Runtime（Win11 自带；Win10 由安装器带 bootstrapper）

### 装依赖与跑测试

```bash
pnpm install
node scripts/check.mjs          # 一条命令跑完所有门禁（105 项 Rust 测试 + clippy + tsc + 56 项 vitest + 护栏）
node scripts/check.mjs --bench  # 再加性能门禁：ipc-bench / write-bench，超 8ms 即非零退出
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

# 备份：指一个别的盘上的目录，之后每天第一次启动自动做一次增量快照
./target/debug/note.exe backup D:\Notes --dir E:\笔记备份
./target/debug/note.exe backup D:\Notes                       # 立刻做一次
./target/debug/note.exe backup D:\Notes --list
./target/debug/note.exe backup D:\Notes --history notes/甲.md
./target/debug/note.exe backup D:\Notes --restore notes/甲.md --from 20260926-005225-795

# 导入外部 Markdown：默认只出预览，加 --apply 才写盘
./target/debug/note.exe import D:\Notes "D:\我的 Obsidian 库"
./target/debug/note.exe import D:\Notes "D:\我的 Obsidian 库" --apply

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
  note-core/    后端服务层：vault / index / capture / service / schema / snapshot
  note-cli/     note 命令行：scan · reindex · search · capture · bench · ipc-bench · write-bench · write-profile · parse
src-tauri/      薄壳：窗口、托盘、单实例、全局热键、Mica、command 注册
src/            React 19 + TS + Tailwind v4；ui/tokens.css 是全仓库唯一允许颜色字面量的地方
docs/           规格即真相：00 导航 · 01 范围 · 02 数据模型 · 03 架构 · 04 AI · 05 路线图 · 06 样式 · adr/
testdata/       往返 golden 语料
probes/         一次性验证原型（Spike C，允许丢弃）
scripts/        check.mjs：一条命令跑完所有门禁 · guard.mjs：护栏四项（依赖方向 / 预算键 / 样式禁止清单 / 悬空依赖声明）· hooks/pre-push：可选的 push 前拦截
```

依赖方向单向：`src-tauri` / `note-cli` / `note-mcp` → `note-core` → `md-kernel`。

---

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 地基：块模型、索引与重建器、CLI、壳 | 完成，但欠四笔：安装器从没跑过（`bundle.active: false`）、`note-mcp` crate 不存在、**没有 CI**（没有远端，所以 workflow 文件是安慰剂；现在是一条命令 `node scripts/check.mjs` 加一个可选的 `scripts/hooks/pre-push`）、Spike B（Obsidian 真机互操作）与崩溃强杀一致性测试未做 |
| **M1** | 能记能查（**全程无需 API Key**） | 进行中：捕获、编辑器（**打开即可编辑** + 气泡工具栏 + `/` 块菜单）、搜索、回收站、**每日快照备份**、**导入外部 Markdown**、**外部改动自动刷新**、**标签与属性入库**已好；目录树、反链视图、标签/属性的**界面**（数据已经在库里）、命令面板、导出待做 |
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
- 提交前跑一条命令：`node scripts/check.mjs`（fmt / clippy `-D warnings` / Rust 测试 / tsc / vitest / 护栏，缓存热时约 20 秒）。想让它自动挡 push：`git config core.hooksPath scripts/hooks`。**仓库没有远端，所以没有 CI**——门禁不会自己跑，这条命令与可选的 hook 是现在的替代品。
- 测试名用中文短语（读失败信息更快），已配 `#![allow(non_snake_case)]`。

## 许可

还没定。`Cargo.toml` 里暂写 `MIT`，但仓库内**没有 LICENSE 文件**——正式开源前需要明确一次（这决定别人能不能商用、要不要署名，不该由代码注释顺手定）。
