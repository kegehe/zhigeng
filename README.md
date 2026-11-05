# 知更

本地优先的个人知识库，Windows 桌面端。仓库目录名是 `zhigeng`。

笔记以普通 Markdown 文件放在你选定的目录里。程序不建账号，也没有自己的云。索引从这些文件派生：删掉 `.note/index.db` 再打开这个库，空索引会按笔记重建；也可以运行 `note reindex`。嵌入向量不会跟着这次重建回来，要重新计算。回收站、冲突副本、保存历史、`.note/config.toml` 和侧栏的自定义顺序删了不会从笔记里长回来。

问答和改写会把相关片段发到你填写的模型地址。模型给出的修改要先预览，点「替换选中」或「应用修改」才写入。像「加粗」这种整句都能认出的样式指令会直接改选区，不经过模型。

规格、数据格式和取舍写在 [`docs/`](docs/00-文档导航.md)。这份说明只讲它是什么、现在能做什么、怎么跑起来。

## 现在能做什么

**记录**

- 打开笔记就能打字。停手约 800ms 自动保存，`Ctrl+S` 仍然可用。
- 这篇在编辑期间被别的程序改过时，保存不会静默覆盖，可以选择用磁盘上的版本，或仍然存自己这份。
- 全局热键 `Alt+Shift+N` 打开速记窗，内容落进库的 `inbox/`。
- 从 Obsidian 或一个目录导入，默认放进库里的 `notes/`。界面上可以先看计划；命令行不加 `--apply` 只预览。内容已经相同的文件会跳过；同名但内容不同的不覆盖，另存成带序号的文件名。点号开头的目录、`node_modules` 和 `target` 不收。

**整理与查找**

- 侧栏按路径显示目录树。可以建目录、在目录里新建笔记，也可以把笔记拖进别的目录（这是在移动文件）。树上是最近改过的 300 篇；库更大时，界面会说明还有多少没列出来，其余用搜索找。别人在库外新建的空目录，要重新打开程序才出现。
- 侧栏先给出关键词结果（中文分词）。归档的笔记，以及 front-matter 里标了 `ai.private` 或 `ai.no_ai` 的笔记，不会出现在这批结果里。随后补上笔记之间的链接；配了嵌入模型并且已经算过向量，再补一路语义结果。
- `Ctrl+K` 打开命令面板：跳到某篇笔记，或打开回收站、导入、备份、设置和问答，也可以切换主题和行高。输入的标题一条都对不上时，可以用这个标题新建一篇。改名、归档和删除不在这里，那几项还要再确认一次。
- 文末列出谁链到这篇、这篇链到谁。对方是笔记时可以点进去；链空的和图片附件只标出来。
- `Ctrl+F` 在当前这篇里查找，`Ctrl+H` 打开替换。这只改屏幕上能改的字，不搜整库。

**编辑**

正文是块编辑器，保存结果仍是 Markdown。没改过的块按原来的字节写回。

- 段落、一到六级标题、无序 / 有序 / 待办列表、引用、代码块、表格、分隔线、图片。带子项的嵌套列表整块按原来的源文本保留，不能拆成一项一项来改。
- 待办用 `- [ ]` / `- [x]` 落盘。点该项左缘的方框切换勾选。
- 行内：加粗、斜体、删除线、行内代码、上标、下标、链接、文字颜色、底色和高亮。
- 对得齐的表格是网格：在格子里打字，`Tab` 跳格，可以加减行列、设置列对齐、框选多格。列数对不齐的表仍按源文本编辑。
- 粘贴图片后按内容的哈希存进 `attachments/`，正文只加一行图片引用。同一张图再贴一次不会多出一份文件。
- 工具栏和选区气泡可以改块类型、列表和首行缩进。行首手柄用来换类型、插入引用 / 代码块 / 表格 / 分隔线、拖动排序和删除这一块，没有首行缩进。空行行首打 `/` 唤出同一份块菜单。笔记开头的标签、属性与 AI 开关在右上角「属性」面板里改——只动对应的那几行，其余字节照旧。

**问答**

设置里填写 OpenAI 兼容端点（也适用于 DeepSeek、Kimi、Ollama 的 `/v1` 等）。API Key 只进 Windows 凭据管理器，不写进笔记，界面也不回显全文。

- 「问答」要求答案带引用。引用了没给过的材料时，不把那次生成当答案。
- 底部对话框：选中一段时改这一段，先预览，点「替换选中」才写入。没选中时按块给出整篇修改方案，点「应用修改」才写入。说清是清空整篇时，不调用模型，还要点「确认清空」。这几笔都可以撤销。
- 笔记开头写成下面这样时，这篇不进搜索、不参与嵌入，也不会整篇发给模型。选区改写只发选中的那段；整篇编辑会被拒绝。`private` 和 `no_ai` 开一个就生效，目录树里仍然看得到这篇。

  ```yaml
  ai:
    private: true
  ```
- 断网或端点不可用时，关键词和链接两路照常可用，生成会说明暂时不可用。

**数据**

- 删除进回收站，可以恢复。
- 配了备份目录之后，每天第一次启动时把变化过的文件增量复制到那个目录，保留最近 30 份，也可以在备份面板里立刻做一份。界面里可以按篇恢复某一份快照。备份目录不能放在笔记库里面；也可以明确选择不备份。
- 别的程序改了库里已有的笔记后，列表会跟上。这篇没有未保存的修改时，正文也会换成磁盘上的版本；有未保存的修改时不会被盖掉。
- 保存时会另记一份历史。连续手改如果隔得不远，会并成一条；模型写入的那几条各自保留。这一份目前只有命令行 `note versions` 能看。

## 环境

- Windows 10 或 Windows 11
- [Rust](https://rustup.rs/) 1.85 或更高（工作区 `rust-version`）
- [Node.js](https://nodejs.org/) 20.19 或 22.12 以上（Vite 7 的要求）
- [pnpm](https://pnpm.io/)
- MSVC 生成工具（Visual Studio 2022 Build Tools）和 Windows SDK
- WebView2：Windows 11 自带；Windows 10 需要安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

## 启动

在仓库根目录：

```powershell
pnpm install
start.bat
```

`start.bat` 会先清掉占用开发端口的本项目进程，再执行 `pnpm tauri dev`。端口上如果是别的程序，脚本不会替你结束它。第一次编译 Rust 和 Tauri 会比较久。

第一次打开时先确认笔记目录（默认 `D:\Notes`；没有 D 盘时用用户目录下的 `Notes`）。程序不会在你没确认的情况下建库。接着会问备份放哪：挑一个库外面的目录，或选「我不备份」。目录一旦记下来，以后启动直接打开上次的库，不会再问；备份以后到设置里改。

开发服务地址是 `http://127.0.0.1:1425`。这个端口写在 `vite.config.ts` 里，并且必须和 `src-tauri/tauri.conf.json` 的 `devUrl` 一致。

在 `start.bat` 的窗口里按 Ctrl+C 时，命令提示符会问要不要终止批处理。选 **N**，启动脚本才能自己结束进程并放开端口。选 Y 会把清理一起停掉，残留留到下一次 `start.bat`。不想看到这一问，可以在 PowerShell 里直接运行：

```powershell
.\scripts\dev.ps1
```

其他启动方式：

```powershell
pnpm tauri dev                      # 与 start.bat 相同，但不预先清端口
.\scripts\dev.ps1 -FrontendOnly     # 只开网页，没有托盘、热键和本地笔记服务
pnpm dev                            # 同上，页面在 http://127.0.0.1:1425/
.\scripts\dev.ps1 -Stop             # 只清理残留进程
stop.bat                            # 同上
```

只开前端时，页面会提示没有 Tauri 运行时，笔记读写不可用。

安装包还没有启用。`src-tauri/tauri.conf.json` 里 `bundle.active` 仍是 `false`。

## 命令行

命令行和图形界面用的是同一套笔记库代码。命令行自己打开那个目录，不是连到正在运行的窗口。先编译：

```powershell
cargo build -p note-cli
```

可执行文件在 `target\debug\note.exe`。下面把 Vault 换成你的笔记目录。目录要先存在。

```powershell
.\target\debug\note.exe capture D:\Notes "一条速记"
.\target\debug\note.exe reindex D:\Notes
.\target\debug\note.exe search   D:\Notes 关键词
.\target\debug\note.exe scan     D:\Notes
.\target\debug\note.exe import   D:\Notes "D:\某个 Markdown 目录"
.\target\debug\note.exe import   D:\Notes "D:\某个 Markdown 目录" --apply
.\target\debug\note.exe backup   D:\Notes --dir E:\笔记备份
.\target\debug\note.exe versions D:\Notes notes\某一篇.md
.\target\debug\note.exe ai       D:\Notes status
```

`note ai ask` 和嵌入会访问你配置的模型端点。`note --help` 和 `note ai --help` 列出全部子命令。

## 测试

```powershell
node scripts/check.mjs
```

这一条会跑 Rust 格式与检查、Rust 测试、TypeScript 检查、前端测试和仓库护栏。性能红线另跑：

```powershell
node scripts/check.mjs --bench
```

只跑前端测试时用 `pnpm test`。

## 一个笔记库里有什么

```
<Vault>/
  inbox/         速记
  notes/         正式笔记，可以有子目录
  archive/       归档（把文件移进来即归档）
  views/         视图定义，不参与检索
  attachments/   图片等附件。从编辑器贴进去的按内容哈希命名
  .note/         索引、配置、侧栏顺序、回收站、冲突副本和保存历史。索引可以重建；其余几项不行
```

复制整个目录就可以换机器。API Key 留在这台电脑的凭据管理器里，换机需要重新填写。

## 仓库结构

```
crates/md-kernel/   Markdown 与块树的转换
crates/note-core/   笔记库、索引、检索、问答
crates/note-cli/    note 命令行
src-tauri/          桌面壳：窗口、托盘、全局热键
src/                界面（React、TypeScript）
docs/               规格
testdata/           往返与评测样本
scripts/            启动脚本与检查入口
```

## 还没做

- 标签和属性的浏览界面（索引进库了，没有专门的视图）
- 每次保存那份历史的图形界面（备份快照的恢复已经在界面里；`note versions` 还没有）
- 建议箱、自动整理、关系图谱
- 定时回顾，以及让别的程序通过 MCP 读取这个库
- macOS、Linux、手机端和云同步
- 安装包

这些界线写在 [`docs/01-产品定位与范围.md`](docs/01-产品定位与范围.md) 和 [`docs/05-路线图与验收标准.md`](docs/05-路线图与验收标准.md)。

## 许可

`Cargo.toml` 里写的是 MIT。仓库里还没有 `LICENSE` 文件，正式对外发布前需要补上。
