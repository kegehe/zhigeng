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
