//! `note` —— M0 验证入口。
//!
//! 现在提供 `scan`（应用 docs/02 的排除规则遍历 Vault）与 `parse`（把一篇笔记
//! 解析成块树并校验无损往返），后续陆续加 `reindex` / `search` / `bench` / `eval`。
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
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
    /// 解析一篇笔记，校验字节级无损往返并输出块树
    Parse {
        file: PathBuf,
        /// 额外校验：规范化重建是否与源文本相等（本身即规范写法时应成立）
        #[arg(long)]
        check_canonical: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Scan { path, json } => cmd_scan(path, json),
        Cmd::Parse {
            file,
            check_canonical,
        } => cmd_parse(file, check_canonical),
        Cmd::Reindex { path, dry_run } => cmd_reindex(path, dry_run),
        Cmd::Search { path, query, limit } => cmd_search(path, &query, limit),
        Cmd::Bench { notes, out } => cmd_bench(notes, out),
        Cmd::IpcBench { notes, iters } => cmd_ipc_bench(notes, iters),
        Cmd::Capture { path, text, bench } => cmd_capture(&path, text.as_deref(), bench),
    }
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
    let mut idx = note_core::index::Index::open(&vault)?;
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
    let mut idx = note_core::index::Index::open(&vault)?;
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
    let mut idx = note_core::index::Index::open(&v)?;
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
