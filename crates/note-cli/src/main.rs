//! `note` —— M0 验证入口。
//!
//! 现在提供 `scan`（应用 docs/02 的排除规则遍历 Vault）与 `parse`（把一篇笔记
//! 解析成块树并校验无损往返），后续陆续加 `reindex` / `search` / `bench` / `eval`。
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use note_core::service::Hub;
use note_core::vault::Vault;

#[derive(Parser)]
#[command(name = "note", version, about = "AI 原生本地笔记的命令行内核")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 按扫描与排除规则列出 Vault 内全部笔记
    Scan {
        /// Vault 根目录
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// 导入外部 Markdown（Obsidian 库、一个目录）。默认只预览，加 --apply 才写盘
    Import {
        /// 目标 Vault
        path: PathBuf,
        /// 源目录
        src: PathBuf,
        /// 库内的目标前缀
        #[arg(long, default_value = "notes")]
        into: String,
        /// 真的写盘
        #[arg(long)]
        apply: bool,
    },
    /// 备份：配置第二个目录、跑一次增量快照、看某篇的历史、从快照恢复
    Backup {
        /// Vault 根目录
        path: PathBuf,
        /// 把备份指到这个目录（另一块盘 / NAS 挂载点）
        #[arg(long)]
        dir: Option<String>,
        /// 显式关掉备份（与"还没配置"是两回事）
        #[arg(long)]
        disable: bool,
        /// 列出最近的快照
        #[arg(long)]
        list: bool,
        /// 列出某篇文件的快照历史
        #[arg(long)]
        history: Option<String>,
        /// 恢复这个相对路径；要配 --from 指定哪一份
        #[arg(long)]
        restore: Option<String>,
        /// 从哪份快照恢复（配合 --restore）
        #[arg(long)]
        from: Option<String>,
    },
    /// 全量重建索引并报告统计与自检结果
    Reindex {
        path: PathBuf,
        /// 只报告偏差，不写库（docs/03 §可观测性）
        #[arg(long)]
        dry_run: bool,
    },
    /// 关键词检索（jieba 分词 + BM25）
    Search {
        path: PathBuf,
        query: String,
        #[arg(short, long, default_value_t = 20)]
        limit: usize,
    },
    /// 某一篇的版本历史（撤销的落点在这里）
    Versions {
        /// Vault 根目录
        path: PathBuf,
        /// 库内相对路径（notes/甲.md）
        rel: String,
        /// 打印某一版的正文（配合上面列出的编号）
        #[arg(long)]
        show: Option<i64>,
    },
    /// 性能基准：造 N 篇笔记，测扫描/重建/检索耗时（docs/03 §性能预算）
    Bench {
        #[arg(long, default_value_t = 5000)]
        notes: usize,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// 捕获一条速记（落 inbox/ 并立刻索引这一篇）
    Capture {
        /// Vault 目录
        path: PathBuf,
        /// 速记正文，可多行（--bench 时可省）
        text: Option<String>,
        /// 在临时库里连拍 N 条测捕获耗时，不碰 path 指向的真实 Vault
        #[arg(long)]
        bench: Option<usize>,
    },
    /// 量同步 IPC 命令耗时（G6 的 8ms 红线）
    IpcBench {
        #[arg(long, default_value_t = 500)]
        notes: usize,
        #[arg(long, default_value_t = 200)]
        iters: usize,
    },
    /// 量写路径耗时：保存 / 移动 / 删除 / 恢复（G6 的 8ms 红线同样管这些）
    WriteBench {
        #[arg(long, default_value_t = 2000)]
        notes: usize,
        #[arg(long, default_value_t = 40)]
        iters: usize,
    },
    /// 把写路径拆成四段分别计时，用来定位超线出在哪一步
    WriteProfile {
        #[arg(long, default_value_t = 2000)]
        notes: usize,
    },
    /// 把一篇 md 的编辑器结构（front-matter + 块树 + 每块精确源切片）导成 JSON。
    /// 前端那个字节级往返测试吃的是这份夹具，保证两边用的是同一份解析结果。
    EditDoc { file: PathBuf },
    /// 解析一篇笔记，校验字节级无损往返并输出块树
    Parse {
        file: PathBuf,
        /// 额外校验：规范化重建是否与源文本相等（本身即规范写法时应成立）
        #[arg(long)]
        check_canonical: bool,
    },
    /// 模型接入：嵌入落库、混合检索、带引用问答（建议箱属于 M3）
    Ai {
        path: PathBuf,
        #[command(subcommand)]
        命令: AiCmd,
    },
    /// 跑评测集：recall@K 与"该空手却给了结果"的条数
    Eval {
        /// 装了评测语料的 Vault
        path: PathBuf,
        #[arg(long, default_value = "testdata/eval/v1.toml")]
        suite: PathBuf,
        #[arg(long, default_value_t = 8)]
        k: usize,
        /// **对照档**：把图扩展那一路摘掉再量一遍。量新增那一路的增益必须有这个数，
        /// 不然报出来的永远是"加了东西之后"的那一个好数字
        #[arg(long)]
        no_graph: bool,
        /// 强制开重排再量一遍（**每道题多打一趟模型**，会花钱）。与不开那次对比
        /// 就是 rerank 的真实增益——假端点演不出这个数，它只会照脚本回话
        #[arg(long)]
        rerank: bool,
    },
}

#[derive(Subcommand)]
enum AiCmd {
    /// 把没嵌过的切片送去嵌入。隐私笔记与视图**不参与**；`--limit` 先试一小批
    Embed {
        #[arg(long)]
        limit: Option<usize>,
    },
    /// 看嵌了多少、还剩多少、多少永远不嵌
    Status,
    /// 混合检索（关键词 + 链接，配了嵌入模型再加语义）。
    /// **只有语义那一路开着时才打一次网络**；不配模型也能跑，那一趟走的是本地两路
    Search {
        query: String,
        #[arg(short, long, default_value_t = 10)]
        limit: usize,
        /// **对照档**：这一趟强制让模型把候选排一遍（配置里那一格默认关）。
        /// 量重排的增益必须有这个开关，不然看到的永远是"没重排"的那一版
        #[arg(long)]
        rerank: bool,
        /// 反方向的对照档：这一趟**不**重排，哪怕配置里开着
        #[arg(long)]
        no_rerank: bool,
    },
    /// 带引用的问答。**会打模型**；库里没有依据时一次都不打
    Ask {
        query: String,
        /// 一边收一边把字打到标准输出（流式）。量"首字多久到"用这个
        #[arg(long)]
        stream: bool,
    },
    /// 从**标准输入**读一把 Key 存进 Windows 凭据管理器。
    /// 为什么要这条路：贴进界面输入框会被 WebView 里的脚本看到，写进命令行参数会进
    /// 进程表与会话记录——只有管道能让它既不进对话也不留痕。本命令**只回末 4 位**。
    #[command(name = "key-stdin")]
    KeyStdin,
    /// 最近的生成记录（含失败的）：引用了哪几块、多少 token、有没有重试过
    Runs {
        #[arg(short, long, default_value_t = 10)]
        limit: i64,
    },
    /// 问端点「你家有哪些模型」，并挑出能当嵌入模型用的那些。**零请求体、不发笔记内容**
    Models,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Scan { path, json } => cmd_scan(path, json),
        Cmd::Parse {
            file,
            check_canonical,
        } => cmd_parse(file, check_canonical),
        Cmd::Import {
            path,
            src,
            into,
            apply,
        } => cmd_import(&path, &src, &into, apply),
        Cmd::Backup {
            path,
            dir,
            disable,
            list,
            history,
            restore,
            from,
        } => cmd_backup(
            &path,
            dir.as_deref(),
            disable,
            list,
            history.as_deref(),
            restore.as_deref(),
            from.as_deref(),
        ),
        Cmd::Reindex { path, dry_run } => cmd_reindex(path, dry_run),
        Cmd::Search { path, query, limit } => cmd_search(path, &query, limit),
        Cmd::Versions { path, rel, show } => cmd_versions(path, &rel, show),
        Cmd::Bench { notes, out } => cmd_bench(notes, out),
        Cmd::IpcBench { notes, iters } => cmd_ipc_bench(notes, iters),
        Cmd::Capture { path, text, bench } => cmd_capture(&path, text.as_deref(), bench),
        Cmd::WriteBench { notes, iters } => cmd_write_bench(notes, iters),
        Cmd::WriteProfile { notes } => cmd_write_profile(notes),
        Cmd::Eval {
            path,
            suite,
            k,
            no_graph,
            rerank,
        } => cmd_eval(
            path,
            suite,
            k,
            note_core::retrieve::跑法 {
                开图: !no_graph,
                重排: rerank.then_some(true),
            },
        ),
        Cmd::Ai { path, 命令 } => cmd_ai(path, 命令),
        Cmd::EditDoc { file } => {
            let src = std::fs::read_to_string(&file)?;
            println!(
                "{}",
                serde_json::to_string(&note_core::service::edit_doc_of(&src))?
            );
            Ok(())
        }
    }
}

/// 导入。默认 dry-run：先看计划再动手，因为"把一万个文件塞进用户的库"不该一步到位。
fn cmd_import(path: &Path, src: &Path, into: &str, apply: bool) -> Result<()> {
    use note_core::import;
    let vault = Vault::open(path)?;
    let 计划 = import::plan(&vault, src, into)?;
    let 新写 = 计划.iter().filter(|e| !e.already_there).count();
    let 改名 = 计划
        .iter()
        .filter(|e| e.dest_rel != format!("{into}/{}", e.src_rel))
        .count();
    if !apply {
        for e in 计划.iter().take(20) {
            println!(
                "{}  {}  {}",
                if e.already_there {
                    "已存在"
                } else if e.markdown {
                    "笔记"
                } else {
                    "附件"
                },
                e.src_rel,
                e.dest_rel
            );
        }
        if 计划.len() > 20 {
            println!("… 共 {} 项", 计划.len());
        }
        println!(
            "预览：{新写} 个要新写（其中 {改名} 个改了名字），库里已有的跳过。加 --apply 落盘"
        );
        return Ok(());
    }
    let idx = note_core::index::Index::open(&vault)?;
    let t = std::time::Instant::now();
    let r = import::import_and_index(&vault, &idx, src, into, false)?;
    println!(
        "导入完成：笔记 {} 篇、附件 {} 个、跳过 {} 个，{}（{:.2}s）",
        r.notes.len(),
        r.assets.len(),
        r.skipped.len(),
        if 改名 > 0 {
            format!("{改名} 个改了名字")
        } else {
            "没有改名".into()
        },
        t.elapsed().as_secs_f64()
    );
    for (from, to) in &r.renamed {
        println!("  改名 {from} → {to}");
    }
    let 漂移 = idx.drift(&vault)?;
    let 孤儿 = idx.orphan_counts()?;
    println!("自检：漂移 {漂移}，孤儿 {孤儿:?}");
    if 漂移 != 0 || !孤儿.is_clean() {
        bail!("导入后索引与文件不一致，先别用");
    }
    Ok(())
}

/// 备份的命令行入口。产品里这些动作各有界面，但按 docs/03 的纪律每一条都要能脱离壳
/// 验证——CLI 与 UI 走出不一样的备份，是最难查的那类 bug。
fn cmd_backup(
    path: &Path,
    dir: Option<&str>,
    disable: bool,
    list: bool,
    history: Option<&str>,
    restore: Option<&str>,
    from: Option<&str>,
) -> Result<()> {
    let mut hub = Hub::open(path)?;
    if dir.is_some() || disable {
        hub.set_backup(dir, disable)?;
        if disable {
            println!("已关闭备份（显式选择，界面不再提醒）");
        } else {
            println!("备份目录：{}", dir.unwrap_or(""));
        }
        return Ok(());
    }
    if let Some(rel) = history {
        let rows = hub.snapshots_of(rel)?;
        if rows.is_empty() {
            println!("快照里没有 {rel}");
        }
        for r in rows {
            println!("{}  {}  收了 {} 个文件", r.id, r.taken_at, r.copied_files);
        }
        return Ok(());
    }
    if list {
        let rows = hub.snapshots_recent(30)?;
        if rows.is_empty() {
            println!("还没有快照。先用 --dir 指到另一个盘上的目录");
        }
        for r in rows {
            println!(
                "{}  {}  增量 {} / 全库 {}",
                r.id, r.taken_at, r.copied_files, r.total_files
            );
        }
        return Ok(());
    }
    if let Some(rel) = restore {
        let id = from.ok_or_else(|| anyhow!("--restore 要配 --from <快照 id>"))?;
        hub.snapshot_restore(rel, id)?;
        // CLI 这条路没有"后台"，恢复完顺手重新索引，一步到位更好验
        hub.index_one(rel)?;
        println!("已从 {id} 恢复 {rel}，并重新索引");
        return Ok(());
    }
    match hub.snapshot_now(true)? {
        Some(s) => println!(
            "快照 {} 完成：增量 {} 个文件，全库 {} 个",
            s.id, s.copied_files, s.total_files
        ),
        None => {
            let info = hub.app_info()?;
            println!(
                "{}",
                if info.backup_disabled {
                    "备份已关闭（显式选择）"
                } else if info.backup_dir.is_none() {
                    "没配备份目录，什么都没做"
                } else {
                    "今天已经快照过了"
                }
            );
        }
    }
    Ok(())
}

fn cmd_reindex(path: PathBuf, dry_run: bool) -> Result<()> {
    let vault = Vault::open(&path)?;
    if dry_run {
        let idx = note_core::index::Index::open(&vault)?;
        let drift = idx.drift(&vault)?;
        let orphans = idx.orphan_counts()?;
        println!("偏差块/文件 {drift}，孤儿 {orphans:?}");
        if drift != 0 || !orphans.is_clean() {
            anyhow::bail!("索引与 md 不一致，请 reindex");
        }
        return Ok(());
    }
    let idx = note_core::index::Index::open(&vault)?;
    let t = std::time::Instant::now();
    let stats = idx.rebuild_all(&vault)?;
    let secs = t.elapsed().as_secs_f64();
    println!(
        "重建完成：{} 篇 / {} 块 / {} 切片 / {} 链接，用时 {secs:.2}s（{:.0} 篇/秒）",
        stats.notes,
        stats.blocks,
        stats.chunks,
        stats.links,
        stats.notes as f64 / secs
    );
    println!(
        "未识别块 {}，漂移 {}，孤儿 {:?}",
        stats.unrecognized,
        idx.drift(&vault)?,
        idx.orphan_counts()?
    );
    Ok(())
}

fn cmd_search(path: PathBuf, query: &str, limit: usize) -> Result<()> {
    let vault = Vault::open(&path)?;
    let idx = note_core::index::Index::open(&vault)?;
    if idx.table_counts()?.get("notes").copied().unwrap_or(0) == 0 {
        idx.rebuild_all(&vault)?;
    }
    let hits = idx.search_keyword(query, limit)?;
    if hits.is_empty() {
        println!("没有命中：{query}");
        return Ok(());
    }
    for h in &hits {
        println!(
            "{:>8.3}  {}#{}  {}",
            h.score,
            h.path,
            h.block_id,
            h.snippet.replace('\n', " ")
        );
    }
    println!("{} 条命中", hits.len());
    Ok(())
}

/// 版本历史。一条快照 = 一个**曾经存在过**的版本，也就是那次操作之前盘上的内容。
///
/// 所以第一遍存完历史还是空的（新文件没有前像），第二遍才把第一版记下来——
/// 这不是漏记，是"前像"这条语义本身如此。
fn cmd_versions(path: PathBuf, rel: &str, show: Option<i64>) -> Result<()> {
    let hub = Hub::open(&path)?;
    if let Some(id) = show {
        let 正文 = hub.note_version_content(rel, id)?;
        print!("{正文}");
        return Ok(());
    }
    let 行 = hub.note_versions(rel)?;
    if 行.is_empty() {
        println!("{rel} 还没有版本历史");
        return Ok(());
    }
    for r in &行 {
        println!(
            "#{:<4} {:<12} {:<7} {}  {}",
            r.id,
            r.reason,
            format!("{} B", r.size),
            r.created_at_text,
            &r.content_hash[..8.min(r.content_hash.len())]
        );
    }
    println!("{} 版", 行.len());
    Ok(())
}

/// 嵌入落库与进度。**这一步会真的把切片文本发给云端 API**，所以：
/// - 隐私位（`ai_private` / `no_ai`）与视图文件在 SQL 层就被排除，压根不进待嵌清单；
/// - 没填嵌入模型名就直接报错，不猜一个默认值去烧 token。
fn cmd_ai(path: PathBuf, 命令: AiCmd) -> Result<()> {
    use note_core::embed;
    let vault = Vault::open(&path)?;
    let idx = note_core::index::Index::open(&vault)?;
    match 命令 {
        AiCmd::Embed { limit } => {
            let 报 = embed::补齐(&vault, idx.conn(), limit)?;
            println!(
                "模型 {}：这一轮嵌了 {} 个切片（{} 批），表 {}",
                报.model, 报.embedded, 报.batches, 报.table
            );
            println!(
                "还剩 {} 个待嵌；{} 个因隐私位或视图身份永不嵌。中途失败就再跑一次，已嵌的不会重来。",
                报.pending, 报.excluded
            );
        }
        AiCmd::Ask { query, stream } => {
            use note_core::answer::事件 as 事;
            let 起 = std::time::Instant::now();
            let mut 首字: Option<std::time::Duration> = None;
            let mut 想了 = 0usize;
            let 答 = note_core::answer::ask流(&vault, idx.conn(), &query, &mut |e| match e {
                事::文本(字) => {
                    if !stream {
                        return;
                    }
                    if 首字.is_none() {
                        首字 = Some(起.elapsed());
                    }
                    use std::io::Write;
                    print!("{字}");
                    let _ = std::io::stdout().flush();
                }
                事::思考(字) => {
                    想了 += 字.chars().count();
                }
                事::重来 => {
                    if stream {
                        // 第一次的答案引用了没给过的编号，不会被采信——已经打出来的字要擦掉。
                        // 界面上是同一个信号（`ai://reset`），这里用一行提示代替清屏
                        println!("\n（引用了没给过的编号，清空重来）");
                    }
                }
            })?;
            if stream {
                println!();
            }
            if let Some(到) = 首字 {
                println!(
                    "  首字 {}ms{}（思考不进答案，只算进度）",
                    到.as_millis(),
                    if 想了 > 0 {
                        format!("｜想了 {想了} 字")
                    } else {
                        String::new()
                    }
                );
            }
            println!(
                "模型 {}｜候选 {}｜in {} / out {} tokens｜{}ms{}",
                答.model,
                答.candidates,
                答.in_tokens,
                答.out_tokens,
                答.ms,
                if 答.retried {
                    "｜引用违规后重生成过一次"
                } else {
                    ""
                }
            );
            if !stream {
                println!("\n{}\n", 答.text);
            }
            if 答.citations.is_empty() {
                println!(
                    "{}",
                    if 答.insufficient {
                        "没有可采信的引用（依据不足）。"
                    } else {
                        "回答里没带编号引用。"
                    }
                );
            } else {
                println!("引用：");
                for c in &答.citations {
                    println!(
                        "  [{}] {}  ← {}",
                        c.label,
                        c.path,
                        c.snippet.replace('\n', " ")
                    );
                }
            }
        }
        AiCmd::Runs { limit } => {
            let 行 = note_core::answer::最近运行(idx.conn(), limit)?;
            if 行.is_empty() {
                println!("还没有生成记录。");
                return Ok(());
            }
            for r in 行 {
                println!(
                    "{}  {}  {}  {}  in {} / out {}  引用 {} 个{}",
                    r.id,
                    r.task,
                    if r.ok { "采纳  " } else { "未采纳" },
                    r.model,
                    r.in_tokens,
                    r.out_tokens,
                    r.cited.len(),
                    if r.retried { "（重试过）" } else { "" }
                );
            }
        }
        AiCmd::Models => {
            let cfg = note_core::ai::load(&vault)?;
            if cfg.base_url.as_deref().unwrap_or("").trim().is_empty() {
                println!("没填接口地址（设置里那一格），所以没地方可问");
                return Ok(());
            }
            let 发 = note_core::ai::列模型(&cfg)?;
            println!(
                "这家给了 {} 个模型（{}ms）：{}",
                发.all.len(),
                发.ms,
                if 发.all.is_empty() {
                    "空清单".into()
                } else {
                    发.all.join(", ")
                }
            );
            if 发.embed_candidates.is_empty() {
                println!(
                    "含 embed 的：0 个 —— 这一家多半没有嵌入接口（DeepSeek、Anthropic 就没有）。\
                     语义那一路不开，检索走关键词与链接。"
                );
            } else {
                println!(
                    "含 embed 的：{} 个，可以填进嵌入模型那一格 → {}",
                    发.embed_candidates.len(),
                    发.embed_candidates.join(", ")
                );
            }
        }
        AiCmd::KeyStdin => {
            use std::io::Read;
            let mut 串 = String::new();
            std::io::stdin()
                .read_to_string(&mut 串)
                .map_err(|e| anyhow::anyhow!("标准输入读不动：{e}"))?;
            let 串 = 串.trim();
            note_core::ai::set_key(串)?;
            let 有 = note_core::ai::key_hint();
            // **空输入是"删掉"，不是"存了一把空的"**：那两种结果得说两句话。
            // 第一版这里不分叉，删完回一句"写了，但当场读不回来"，把成功报成了故障
            match (串.is_empty(), 有) {
                (true, None) => println!("已删掉凭据管理器里的那把 Key（当场读回：没有）"),
                (true, Some(尾)) => println!("想删掉，但还读得回来：{尾}——**没删成**"),
                (false, Some(尾)) => println!("已存进 Windows 凭据管理器：{尾}"),
                (false, None) => println!(
                    "写了，但当场读不回来——凭据管理器多半不可用（组策略或被占用），别当成配好了"
                ),
            }
        }
        AiCmd::Status => {
            let 模型 = note_core::ai::load(&vault)?
                .embedding_model
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty());
            match 模型 {
                None => println!("没填嵌入模型名（设置里那一格），所以没有向量表"),
                Some(m) => {
                    let 进 = embed::进度of(idx.conn(), &m)?;
                    println!(
                        "模型 {m} → 表 {}：已嵌 {}，待嵌 {}，不收（隐私位/视图）{}",
                        进.table, 进.embedded, 进.pending, 进.excluded
                    );
                }
            }
        }
        AiCmd::Search {
            query,
            limit,
            rerank,
            no_rerank,
        } => {
            let 法 = note_core::retrieve::跑法 {
                开图: true,
                重排: match (rerank, no_rerank) {
                    (true, _) => Some(true),
                    (_, true) => Some(false),
                    _ => None,
                },
            };
            let 结 = note_core::retrieve::检索(&vault, idx.conn(), &query, 法)?;
            let 走了 = 结.走了那句();
            let 钱 = 结.rerank_in + 结.rerank_out;
            let 钱话 = if 钱 > 0 {
                format!("，重排那一趟 {} tok", 钱)
            } else {
                String::new()
            };
            if let Some(h) = &结.hint {
                println!("  {h}");
            }
            let 中 = 结.hits;
            if 中.is_empty() {
                println!("没有命中：{query}（这一趟走【{走了}】{钱话}）");
                return Ok(());
            }
            for (i, h) in 中.iter().take(limit).enumerate() {
                let 来源: Vec<&str> = h.from.iter().map(|r| r.显示名()).collect();
                println!(
                    "{:>3}. {:>7.4} [{}] {}  {}",
                    i + 1,
                    h.rrf,
                    来源.join("+"),
                    h.path,
                    h.snippet.replace('\n', " ")
                );
            }
            println!(
                "{} 条命中（这一趟走【{走了}】，单篇最多 {} 块{钱话}）",
                中.len(),
                note_core::retrieve::每篇配额
            );
        }
    }
    Ok(())
}

/// 跑评测集。**语义那一路开没开要印在第一行旁边**：没配模型时这个数只反映关键词，
/// 拿它当"AI 检索达标了"是假的（docs/04 §评测集 要的是 recall@8 ≥ 0.85 与幻觉率 = 0）。
fn cmd_eval(
    path: PathBuf, suite: PathBuf, k: usize, 法: note_core::retrieve::跑法
) -> Result<()> {
    let 文本 =
        std::fs::read_to_string(&suite).with_context(|| format!("读评测集 {}", suite.display()))?;
    let 套 = note_core::retrieve::读套件(&文本)?;
    let vault = Vault::open(&path)?;
    let idx = note_core::index::Index::open(&vault)?;
    let 成 = note_core::retrieve::评测(&vault, idx.conn(), &套, k, 法)?;
    println!(
        "评测集 {} 条（正 {} / 负 {}），K={}；这一趟走【{}】",
        成.entries,
        成.positives,
        成.negatives,
        成.k,
        成.走了(),
    );
    if !成.semantic {
        // 三种原因都算"没开"：没配模型、还没嵌过、**跑的时候连不上**。
        // 原来只写前两种——加了"连不上就退回"这一档之后，那句话就成了一句可能的话（docs/05 M2 ③）
        println!(
            "  语义那一路没开（没配模型、还没嵌过，或跑的时候连不上）——下面这个数只反映上面写着的那几路。"
        );
    }
    if !成.graph {
        println!("  对照档：图扩展那一路被 `--no-graph` 摘掉了，这个数是拿它当基线的。");
    }
    println!(
        "  重排：{}",
        if 成.reranked {
            "这一轮至少有一趟真被模型重排过"
        } else {
            "这一轮没有任何一趟被重排（配置里那格关着、没配对话模型，或回包读不出）"
        }
    );
    println!(
        "recall@{} = {:.1}%（{}/{}）｜MRR = {:.3}",
        成.k,
        成.recall_at_k * 100.0,
        成.hits,
        成.positives,
        成.mrr
    );
    println!(
        "依据强度分布（升序）。阈值要读的是\"负\"那一堆的顶与\"正·中\"那一堆的底之间的间隙，
         间隙不存在就说明这个量不可比——那要先修的是分数，不是阈值："
    );
    let mut 分 = 成.scores.clone();
    分.sort_by(|a, b| {
        a.top
            .partial_cmp(&b.top)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for x in &分 {
        println!("  {:.3} [{:>3}] {}", x.top, x.kind, x.q);
    }
    if 成.misses.is_empty() {
        println!("没有漏。");
    } else {
        println!("漏掉 {} 条：", 成.misses.len());
        for m in &成.misses {
            println!("  - {m}");
        }
    }
    if 成.negatives_with_candidates.is_empty() {
        println!("负样本全部空手。");
    } else {
        println!(
            "负样本里有 {} 条进了候选——召回层给候选是本职，判\"答不答\"是答案层的分数阈值：",
            成.negatives_with_candidates.len()
        );
        for x in &成.negatives_with_candidates {
            println!("  - {x}");
        }
    }
    Ok(())
}

fn cmd_bench(notes: usize, out: Option<PathBuf>) -> Result<()> {
    use std::io::Write;
    let dir = match &out {
        Some(p) => {
            std::fs::create_dir_all(p)?;
            p.clone()
        }
        None => std::env::temp_dir().join(format!("note-bench-{}", std::process::id())),
    };
    std::fs::create_dir_all(&dir)?;
    let t0 = std::time::Instant::now();
    {
        let v = Vault::open(&dir)?;
        for i in 0..notes {
            let body = format!(
                "---
id: n-bench{i:05}
title: 基准笔记 {i}
---

第 {i} 篇的正文，讲分节渲染与检索配额。 ^b-bench{i:05}

- 条目甲
- 条目乙

参见 [[基准笔记{}]]。
",
                (i + 1) % notes
            );
            v.write_atomic(&format!("notes/bench/{i:05}.md"), body.as_bytes())?;
        }
    }
    let write_ms = t0.elapsed().as_millis() as u64;
    let v = Vault::open(&dir)?;
    let idx = note_core::index::Index::open(&v)?;
    let stats = idx.rebuild_all(&v)?;
    let scan_t = std::time::Instant::now();
    let n_files = v.scan()?.len();
    let scan_ms = scan_t.elapsed().as_millis() as u64;
    let q_t = std::time::Instant::now();
    let hits = idx.search_keyword("分节渲染", 20)?;
    let q_ms = q_t.elapsed().as_millis() as u64;
    let orphans = idx.orphan_counts()?;
    let drift = idx.drift(&v)?;
    println!(
        "bench notes={notes} 写入 {write_ms}ms，重建 {}ms（{} 块 / {} 切片），scan {scan_ms}ms，查询 {q_ms}ms 命中 {}",
        stats.elapsed_ms, stats.blocks, stats.chunks, hits.len()
    );
    println!("孤儿 {orphans:?} 漂移 {drift} 文件数 {n_files}");
    if out.is_none() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let _ = Write::flush(&mut std::io::stdout());
    Ok(())
}

fn cmd_scan(path: PathBuf, json: bool) -> Result<()> {
    let vault =
        Vault::open(&path).with_context(|| format!("打开 Vault 失败: {}", path.display()))?;
    let files = vault.scan()?;
    if json {
        let rows: Vec<serde_json::Value> = files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "rel": f.rel,
                    "status": format!("{:?}", f.status).to_lowercase(),
                    "kind": format!("{:?}", f.kind).to_lowercase(),
                    "size": f.size,
                    "hash": &f.content_hash[..12],
                })
            })
            .collect();
        serde_json::to_writer(std::io::stdout(), &rows)?;
        println!();
    } else {
        let mut out = std::io::stdout().lock();
        for f in &files {
            writeln!(
                out,
                "{:<6} {:<9} {:>8}  {}  {}",
                match f.kind {
                    note_core::vault::NoteKind::Note => "note",
                    note_core::vault::NoteKind::View => "view",
                },
                match f.status {
                    note_core::vault::NoteStatus::Inbox => "inbox",
                    note_core::vault::NoteStatus::Active => "active",
                    note_core::vault::NoteStatus::Archived => "archived",
                },
                f.size,
                &f.content_hash[..12],
                f.rel
            )?;
        }
        writeln!(out, "共 {} 个笔记文件", files.len())?;
    }
    Ok(())
}

fn cmd_parse(file: PathBuf, check_canonical: bool) -> Result<()> {
    let src =
        std::fs::read_to_string(&file).with_context(|| format!("读取失败: {}", file.display()))?;
    let doc = md_kernel::parse(&src);

    // G5 的第一道闸：精确重建必须与源文本字节相等
    let exact = md_kernel::render_exact(&doc);
    if exact != src {
        let (a, b) = (src.len(), exact.len());
        bail!("无损往返失败：源 {a} 字节，重建 {b} 字节");
    }
    let mut mismatch = 0usize;
    if check_canonical {
        let canon = md_kernel::render_canonical(&doc);
        if canon != src {
            mismatch = 1;
            eprintln!("规范化重建与源文本不同（源不是规范写法，或渲染器有缺陷）");
            write_diff_sample(&src, &canon);
        }
    }

    let flat = doc.blocks_flat();
    println!(
        "{}: {} 块（简单 {} / 未识别 {}），front-matter {}",
        file.file_name().and_then(|s| s.to_str()).unwrap_or("?"),
        flat.len(),
        flat.iter().filter(|b| b.simple()).count(),
        doc.unrecognized_count(),
        doc.front_matter.is_some(),
    );
    for b in &doc.blocks {
        print_tree(b, 0);
    }
    if mismatch == 1 {
        bail!("canonical 校验未通过");
    }
    Ok(())
}

fn print_tree(b: &md_kernel::Block, depth: usize) {
    let id = b.id.as_deref().unwrap_or("-");
    println!(
        "{}{:<10} id={id:<13} {:?}",
        "  ".repeat(depth),
        b.kind.as_str(),
        if b.content.chars().count() > 40 {
            let t: String = b.content.chars().take(40).collect();
            format!("{t}…")
        } else {
            b.content.clone()
        }
    );
    for c in &b.children {
        print_tree(c, depth + 1);
    }
}

fn write_diff_sample(a: &str, b: &str) {
    let ai: Vec<&str> = a.lines().collect();
    let bi: Vec<&str> = b.lines().collect();
    for i in 0..ai.len().max(bi.len()) {
        let x = ai.get(i).copied().unwrap_or("<无>");
        let y = bi.get(i).copied().unwrap_or("<无>");
        if x != y {
            eprintln!("  第 {} 行不同:\n    源: {x}\n    重: {y}", i + 1);
            return;
        }
    }
}

/// 量同步 IPC 命令的真实耗时。G6 的红线是 8ms，而 UI 侧只负责不阻塞，
/// 真正决定能不能守住的是这几个 handler 的成本（docs/03 §后端调用纪律）。
fn cmd_ipc_bench(notes: usize, iters: usize) -> Result<()> {
    use std::time::Instant;

    let dir = std::env::temp_dir().join(format!("note-ipcbench-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let budget = read_ipc_budget_ms()?;
    {
        let v = Vault::open(&dir)?;
        for i in 0..notes {
            let body = format!(
                "---\nid: n-ipc{i:05}\ntitle: IPC 基准笔记 {i}\n---\n\n第 {i} 篇正文，讲分节渲染与检索配额。 ^b-ipc{i:05}\n\n- 条目甲\n- 条目乙\n",
            );
            v.write_atomic(&format!("notes/ipc/{i:05}.md"), body.as_bytes())?;
        }
    }
    let hub = note_core::service::Hub::open(&dir)?;

    let pick = {
        let list = hub.list_notes(10)?;
        list.notes
            .first()
            .map(|n| n.rel.clone())
            .context("基准库里没有笔记")?
    };

    let mut measured: Vec<(&str, Vec<f64>)> = Vec::new();
    macro_rules! bench {
        ($name:literal, $body:expr) => {{
            let mut samples = Vec::with_capacity(iters);
            for _ in 0..iters {
                let t = Instant::now();
                let _ = $body?;
                samples.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            measured.push(($name, samples));
        }};
    }
    bench!("app_info", hub.app_info());
    bench!("list_notes(200)", hub.list_notes(200));
    bench!("read_note", hub.read_note(&pick));
    bench!("search_keyword", hub.search_keyword("分节渲染", 20));

    let mut failed = false;
    println!("IPC 基准：{notes} 篇 / 每项 {iters} 次，红线 p95 < {budget:.1}ms");
    for (name, mut s) in measured {
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |p: f64| s[((s.len() as f64 * p) as usize).min(s.len() - 1)];
        let over = q(0.95) > budget;
        failed |= over;
        println!(
            "  {:<18} p50 {:>6.2}ms  p95 {:>6.2}ms  max {:>6.2}ms  {}",
            name,
            q(0.5),
            q(0.95),
            s[s.len() - 1],
            if over { "超线" } else { "ok" }
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
    if failed {
        anyhow::bail!("有同步命令超过 8ms 预算：该改异步 + 事件流，而不是给 UI 加 loading");
    }
    Ok(())
}

/// 写路径基准。每条操作名义上只碰一篇笔记，但索引里有按**笔记总数**放大的步骤
/// （链接查找表要扫 notes 全表，删除/移动还要全量重解析链接图）。
/// 这条命令就是用来在规模下把它们抓出来的——别等用户改个名卡住才发现。
fn cmd_write_bench(notes: usize, iters: usize) -> Result<()> {
    use std::time::Instant;

    let dir = std::env::temp_dir().join(format!("note-writebench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    {
        let v = Vault::open(&dir)?;
        for i in 0..notes {
            let body = format!(
                "---\nid: n-wb{i:05}\ntitle: 写基准 {i}\n---\n\n第 {i} 篇正文，讲分节渲染。见 [[写基准 {}]]。 ^b-wb{i:05}a\n",
                (i + 1) % notes
            );
            v.write_atomic(&format!("notes/{i:05}.md"), body.as_bytes())?;
        }
    }
    let mut hub = note_core::service::Hub::open(&dir)?;
    let rel = "notes/00000.md";
    let alt = "notes/00000-移开.md";
    let content = String::from_utf8_lossy(&hub.vault().read(rel)?).to_string();
    let budget = read_ipc_budget_ms()?;

    // 红线管的是**同步那一半**。后台补索引再慢，代价也只是"晚一点才可搜"，
    // 不会让界面发涩——所以两张表分开看，别拿后台的耗时去判超线。
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    let mut save_s = Vec::new();
    let mut save_b = Vec::new();
    let mut move_s = Vec::new();
    let mut move_b = Vec::new();
    let mut trash_s = Vec::new();
    let mut trash_b = Vec::new();
    for _ in 0..iters {
        // 带 expect_hash 才走的是真路径：它多一次读盘 + 算 hash
        let base = hub.vault().note_file(rel)?.content_hash;
        let t = Instant::now();
        hub.save_note_write(rel, &content, Some(&base), note_core::versions::手工)?;
        save_s.push(ms(t));
        let t = Instant::now();
        hub.index_one(rel)?;
        save_b.push(ms(t));

        // 移一次、补一次索引，再移回来、再补一次：两步必须配对，
        // 否则索引那一步会去读已经被移走的文件
        let t = Instant::now();
        hub.note_move_file(rel, alt)?;
        move_s.push(ms(t));
        let t = Instant::now();
        hub.index_moved(rel, alt)?;
        move_b.push(ms(t));
        let t = Instant::now();
        hub.note_move_file(alt, rel)?;
        move_s.push(ms(t));
        let t = Instant::now();
        hub.index_moved(alt, rel)?;
        move_b.push(ms(t));

        let t = Instant::now();
        hub.note_trash_file(rel)?;
        trash_s.push(ms(t));
        let t = Instant::now();
        hub.index_trashed(rel)?;
        trash_b.push(ms(t));
        let batch = hub.list_trash()?[0].batch.clone();
        hub.note_restore_file(&batch, rel)?;
        hub.index_one(rel)?;
    }

    println!("写路径基准：{notes} 篇 / 每项 {iters} 次，同步那一半红线 p95 < {budget:.1}ms");
    let mut failed = false;
    let report = |label: &str, rows: Vec<(&str, Vec<f64>)>, gate: bool| -> bool {
        println!("  {label}");
        let mut bad = false;
        for (name, mut s) in rows {
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let q = |p: f64| s[((s.len() as f64 * p) as usize).min(s.len() - 1)];
            let over = gate && q(0.95) > budget;
            bad |= over;
            println!(
                "    {:<14} p50 {:>7.2}ms  p95 {:>7.2}ms  max {:>7.2}ms  {}",
                name,
                q(0.5),
                q(0.95),
                s[s.len() - 1],
                if !gate {
                    "后台"
                } else if over {
                    "超线"
                } else {
                    "ok"
                }
            );
        }
        bad
    };
    failed |= report(
        "同步（落盘/改名/删除返回前）：",
        vec![("save", save_s), ("move", move_s), ("trash", trash_s)],
        true,
    );
    report(
        "后台（索引与链接图）：",
        vec![("index", save_b), ("moved", move_b), ("trashed", trash_b)],
        false,
    );
    let _ = std::fs::remove_dir_all(&dir);
    if failed {
        anyhow::bail!("同步写路径超过 8ms 预算：还有活留在返回前，把它挪进 index_one/index_moved");
    }
    Ok(())
}

/// 把一次保存拆开量，定位超线到底出在哪一步。上面那条只给总数，改之前得先知道改谁。
fn cmd_write_profile(notes: usize) -> Result<()> {
    use note_core::index::Index;
    use std::time::Instant;

    let dir = std::env::temp_dir().join(format!("note-writeprof-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let mut v = Vault::open(&dir)?;
    for i in 0..notes {
        let body = format!(
            "---\nid: n-wp{i:05}\ntitle: 分段基准 {i}\n---\n\n第 {i} 篇正文。见 [[分段基准 {}]]。 ^b-wp{i:05}a\n",
            (i + 1) % notes
        );
        v = {
            v.write_atomic(&format!("notes/{i:05}.md"), body.as_bytes())?;
            v
        };
    }
    let idx = Index::open(&v)?;
    idx.rebuild_all(&v)?;
    let rel = "notes/00000.md";
    let file = v.note_file(rel)?;
    let content = String::from_utf8_lossy(&v.read(rel)?).to_string();
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;

    // 每步跑 20 次取中位数，避免把冷缓存当成本
    let mut acc = vec![0f64; 4];
    for _ in 0..20 {
        let t = Instant::now();
        v.write_atomic(rel, content.as_bytes())?;
        acc[0] += ms(t);
        let t = Instant::now();
        idx.index_file(&file, &content)?;
        acc[1] += ms(t);
        let t = Instant::now();
        idx.rebuild_links_of_note(rel)?;
        acc[2] += ms(t);
        let t = Instant::now();
        idx.rebuild_links()?;
        acc[3] += ms(t);
    }
    let names = [
        "write_atomic（含 fsync）",
        "index_file（单篇重建）",
        "rebuild_links_of_note",
        "rebuild_links（全量）",
    ];
    println!("写路径分段：{notes} 篇，20 次合计");
    for (n, a) in names.iter().zip(&acc) {
        println!("  {n:<26} {:>8.1}ms  单次 {:>7.2}ms", a, a / 20.0);
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// 预算从 perf-budget.json 读，避免文档与代码两处数字各说各话。
fn read_ipc_budget_ms() -> Result<f64> {
    let candidates = [
        std::path::PathBuf::from("perf-budget.json"),
        std::path::PathBuf::from("../perf-budget.json"),
        std::path::PathBuf::from("../../perf-budget.json"),
    ];
    for p in candidates {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            let v: serde_json::Value = serde_json::from_str(&raw)?;
            if let Some(n) = v.get("同步IPC调用_p95_ms").and_then(|x| x.as_f64()) {
                return Ok(n);
            }
        }
    }
    Ok(8.0)
}

/// 捕获路径的实测入口：落盘 + 单篇增量索引，两项预算一起看
/// （速记窗唤起 < 100ms 是端到端目标，同步命令 < 8ms 是这条内部的红线）。
fn cmd_capture(path: &std::path::Path, text: Option<&str>, bench: Option<usize>) -> Result<()> {
    use std::time::Instant;

    let (dir, tmp) = match bench {
        Some(n) => {
            let d = std::env::temp_dir().join(format!("note-cap-{}", std::process::id()));
            std::fs::create_dir_all(&d)?;
            println!("bench 模式：忽略 {path:?}，用临时库 {}", d.display());
            let _ = n;
            (d, true)
        }
        None => (path.to_path_buf(), false),
    };

    let mut hub = note_core::service::Hub::open(&dir)?;

    match bench {
        Some(n) => {
            // 三段分开量：带 fsync 的落盘 / 不带 fsync 的落盘 / 单篇增量索引。
            // 目的是看清 8ms 预算到底被谁吃掉的，而不是笼统地说"要异步化"。
            let mut fsync = Vec::with_capacity(n);
            let mut cached = Vec::with_capacity(n);
            let mut index = Vec::with_capacity(n);
            {
                // 预热：jieba 词典首载、WAL 建库、连接池冷启都是一次性的，
                // 算进"每次捕获"的预算会把结论带偏
                let w = hub.capture_write("预热条目不计入统计", None, true)?;
                hub.index_captured(&w.rel, &w.content)?;
            }
            for i in 0..n {
                let t = Instant::now();
                hub.capture_write(&format!("捕获压测持久 {i}\n第二块"), None, true)?;
                fsync.push(t.elapsed().as_secs_f64() * 1000.0);

                let t = Instant::now();
                hub.capture_write(&format!("捕获压测缓写 {i}\n第二块"), None, false)?;
                cached.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            // 索引统一在落盘之后做，顺带验证"落盘顺序与索引顺序可以脱节"
            for f in hub.vault().scan()? {
                let content = String::from_utf8_lossy(&hub.vault().read(&f.rel)?).to_string();
                let t = Instant::now();
                hub.index_captured(&f.rel, &content)?;
                index.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            let q = |v: &[f64], p: f64| {
                let mut w = v.to_vec();
                w.sort_by(|a, b| a.partial_cmp(b).unwrap());
                (
                    w[((w.len() as f64 * p) as usize).min(w.len() - 1)],
                    w[w.len() - 1],
                )
            };
            println!("捕获分段基准（{n} 次）：");
            for (name, v) in [
                ("落盘 + fsync     ", &fsync),
                ("落盘 仅页缓存    ", &cached),
                ("单篇增量索引    ", &index),
            ] {
                let (p95, _) = q(v, 0.95);
                let (p50only, _) = q(v, 0.5);
                let (p90, _) = q(v, 0.9);
                let mut top: Vec<f64> = v.to_vec();
                top.sort_by(|a, b| b.partial_cmp(a).unwrap());
                let top5 = top
                    .iter()
                    .take(5)
                    .map(|x| format!("{x:.1}"))
                    .collect::<Vec<_>>()
                    .join(" / ");
                println!(
                    "  {name} p50 {p50only:>6.2}ms  p90 {p90:>6.2}ms  p95 {p95:>6.2}ms  最慢 5 次 {top5}"
                );
            }
            let hits = hub.search_keyword("压测", 5)?;
            println!("索引完成后立刻可搜：命中 {} 条", hits.len());
            let budget = read_ipc_budget_ms()?;
            if q(&fsync, 0.95).1 > budget {
                println!(
                    "→ 落盘(含 fsync) p95 已超 {budget:.1}ms 预算：速记窗必须\"先回显再落盘\"，\n  且落盘失败要能明确报错，不能静默丢内容"
                );
            }
            if tmp {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        None => {
            let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
                anyhow::bail!("给一段速记正文，或用 --bench N 压测");
            };
            let c = hub.capture(text, None)?;
            println!("已存 {}（id {}，索引 {}ms）", c.rel, c.id, c.index_ms);
            let hits = hub.search_keyword(&c.title, 5)?;
            println!("立刻搜索“{}”命中 {} 条", c.title, hits.len());
        }
    }
    Ok(())
}
