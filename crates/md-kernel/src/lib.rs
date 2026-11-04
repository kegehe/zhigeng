//! md-kernel —— Markdown ↔ 块树双向转换。
//!
//! 三条设计决定，对应 docs/00 的 G1/G5 与 docs/02：
//!
//! 1. **无损是结构性的，不是"渲染器写得好"**。每个块保存它在源文本里的精确字节切片
//!    `raw`，块间空白保存为 `gap_before`。于是 `render_exact` 恒等于源文本——解析器
//!    只可能分错类型，不可能丢字节。
//! 2. **只有简单块参与规范化重建**：`paragraph / heading / todo / bullet / numbered`。
//!    编辑器改写的正是这几类。结构复杂或不认识的语法一律回显 `raw`。
//! 3. **不认识的语法降级为 `Kind::Raw`**，永不丢弃。
//!
//! 本 crate 不依赖 SQLite，不依赖 Tauri。

use std::ops::Range;

use rand::Rng;

pub const ID_PREFIX: &str = "b-";
const ID_BODY_LEN: usize = 10;
const ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// 生成块 ID：`b-` + 10 位小写字母数字（docs/02 §块 ID）。
pub fn gen_block_id() -> String {
    let mut s = String::with_capacity(ID_PREFIX.len() + ID_BODY_LEN);
    s.push_str(ID_PREFIX);
    let mut rng = rand::rng();
    for _ in 0..ID_BODY_LEN {
        s.push(ID_ALPHABET[rng.random_range(0..ID_ALPHABET.len())] as char);
    }
    s
}

pub fn is_valid_block_id(s: &str) -> bool {
    let Some(body) = s.strip_prefix(ID_PREFIX) else {
        return false;
    };
    body.len() == ID_BODY_LEN
        && body
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// 块类型。与 docs/02 §块类型 的 15 种对应；`Raw` 为第 16 种内部兜底。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadingStyle {
    /// `## 文字`
    Atx,
    /// `文字\n===` 或 `文字\n---`：规范化重建会改写成 ATX，因此不参与重建
    Setext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Paragraph,
    Heading {
        level: u8,
        style: HeadingStyle,
    },
    Divider,
    Todo {
        checked: bool,
    },
    Bullet,
    Ordered {
        marker: String,
    },
    Quote,
    Callout {
        ty: String,
        folded: bool,
    },
    Code {
        fence: String,
        info: String,
    },
    Math,
    Table,
    /// 非图片附件链接（由 note-core 依据链接目标判定）。
    Image,
    Embed,
    File,
    Html,
    Raw,
}

impl Kind {
    /// 落库的 type 列。
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Paragraph => "paragraph",
            Kind::Heading { .. } => "heading",
            Kind::Divider => "divider",
            Kind::Todo { .. } => "todo",
            Kind::Bullet => "bullet",
            Kind::Ordered { .. } => "numbered",
            Kind::Quote => "quote",
            Kind::Callout { .. } => "callout",
            Kind::Code { .. } => "code",
            Kind::Math => "math",
            Kind::Table => "table",
            Kind::Image => "image",
            Kind::Embed => "embed",
            Kind::File => "file",
            Kind::Html => "html",
            Kind::Raw => "raw",
        }
    }

    /// 只有这几类会被规范化重建；其余回显原文。保守是有意的：
    /// 宁可少规整，也不吃语法。
    pub fn is_simple(&self) -> bool {
        matches!(
            self,
            Kind::Paragraph
                | Kind::Heading {
                    style: HeadingStyle::Atx,
                    ..
                }
                | Kind::Todo { .. }
                | Kind::Bullet
                | Kind::Ordered { .. }
                | Kind::Image
                | Kind::Embed
                | Kind::File
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: Kind,
    /// `b-xxxxxxxxxx`；源文本里的写法是 `^b-xxxxxxxxxx`。
    pub id: Option<String>,
    /// 该块的精确源切片，含结尾换行；不含 `gap_before`。
    /// 嵌套块的 `raw` 相对于父块的 dedent 上下文。
    pub raw: String,
    /// 与上一个兄弟块之间的空白（仅空白与换行）。
    pub gap_before: String,
    /// 首行缩进，逐字保留。
    pub indent: String,
    /// 正文：已去掉前缀、缩进与 ID 标记，仍含行内语法。
    pub content: String,
    pub title: Option<String>,
    /// 嵌套列表项 / 引用与 Callout 内的块。
    pub children: Vec<Block>,
    /// 行内字段，只认 `due::` 与 `done::`（docs/02 §待办的到期约定）。
    pub fields: Vec<(String, String)>,
    /// 块级对齐（`<div align="…">` 包裹，docs/02 D40）。`None` 即默认靠左。
    pub align: Option<String>,
    pub line_start: usize,
    pub line_end: usize,
}

impl Block {
    /// 该块是否可按规范重建。除了类型白名单，还要求源文本各行缩进齐整——
    /// **宁可回显原文，也不要在重建时悄悄改掉用户的前导空白**。
    pub fn simple(&self) -> bool {
        // 对齐块外面裹着 `<div align>`，重建只会吐出裸正文、把包裹丢掉，
        // 所以一律回显 `raw`（docs/02 D40）。
        self.align.is_none()
            && self.kind.is_simple()
            && self.children.iter().all(Block::simple)
            && self.indent_uniform()
    }

    /// 除首行的 `indent` 外，其余非空行不得再有前导空白（Tab 也算）。
    fn indent_uniform(&self) -> bool {
        for (i, line) in self.raw.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let rest = match line.strip_prefix(&*self.indent) {
                Some(r) => r,
                None => return false,
            };
            if i > 0 && rest.starts_with([' ', '\t']) {
                return false;
            }
            if rest.starts_with('\t') {
                return false;
            }
        }
        true
    }

    /// 用于 FTS 与嵌入的纯文本（剥行内语法，含子块）。
    pub fn plain_text(&self) -> String {
        let mut buf = String::new();
        self.collect_text(&mut buf);
        buf.trim().to_string()
    }

    fn collect_text(&self, buf: &mut String) {
        if !self.content.is_empty() {
            let t = plain_inline(&self.content);
            if !t.trim().is_empty() {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(t.trim());
            }
        }
        if let Some(title) = &self.title {
            let t = plain_inline(title);
            if !t.trim().is_empty() {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(t.trim());
            }
        }
        for c in &self.children {
            c.collect_text(buf);
        }
    }

    /// 含嵌套的子树块数。
    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Block::count).sum::<usize>()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrontMatter {
    /// 含起止 `---` 与结尾换行的精确切片。
    pub raw: String,
    /// 两条 `---` 之间的 YAML 文本。
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub front_matter: Option<FrontMatter>,
    pub blocks: Vec<Block>,
    /// 文档末尾剩余的空白。
    pub trailing_gap: String,
}

/// 解析一篇笔记。永远成功：不认识的语法降级为 `Kind::Raw`。
pub fn parse(source: &str) -> Doc {
    let mut c = Cursor::new(split_lines(source));
    let front_matter = c.take_front_matter();
    let blocks = parse_blocks(&mut c);
    Doc {
        front_matter,
        blocks,
        trailing_gap: std::mem::take(&mut c.gap),
    }
}

/// 精确重建源文本。由构造保证恒等，用于回归解析器的簿记。
pub fn render_exact(doc: &Doc) -> String {
    let mut out = String::new();
    if let Some(fm) = &doc.front_matter {
        out.push_str(&fm.raw);
    }
    for b in &doc.blocks {
        push_exact(&mut out, b);
    }
    out.push_str(&doc.trailing_gap);
    out
}

fn push_exact(out: &mut String, b: &Block) {
    out.push_str(&b.gap_before);
    out.push_str(&b.raw);
}

/// 按规范重建。简单块重新渲染，其余回显 `raw`。
/// 对"本身即规范写法"的文档，输出与源文本字节相等（golden 测试把这条钉死）。
pub fn render_canonical(doc: &Doc) -> String {
    let mut out = String::new();
    if let Some(fm) = &doc.front_matter {
        out.push_str(&fm.raw);
    }
    for b in &doc.blocks {
        out.push_str(&b.gap_before);
        render_block(&mut out, b);
    }
    out.push_str(&doc.trailing_gap);
    out
}

fn render_block(out: &mut String, b: &Block) {
    if !b.simple() {
        out.push_str(&b.raw);
        return;
    }
    let eol = detect_eol(&b.raw);
    let mut body = String::new();
    match &b.kind {
        Kind::Heading { level, .. } => {
            body.push_str(&b.indent);
            for _ in 0..(*level).clamp(1, 6) {
                body.push('#');
            }
            body.push(' ');
            body.push_str(&b.content);
        }
        Kind::Divider => {
            body.push_str(&b.indent);
            body.push_str("---");
        }
        Kind::Todo { checked } => {
            body.push_str(&b.indent);
            body.push_str(if *checked { "- [x] " } else { "- [ ] " });
            body.push_str(&b.content);
        }
        Kind::Bullet => {
            body.push_str(&b.indent);
            body.push_str("- ");
            body.push_str(&b.content);
        }
        // 图片 / 嵌入 / 文件：`content` 里装的是**那一整行**，`![[…]]` 的语法本身也在里面，
        // 所以与段落同一条写法（只补缩进）。这几类原先与 `Bullet` 共用一支，规范化于是把
        // `![[a.png]]` 重写成 `- ![[a.png]]`——而 docs/02 D9 的白名单里明明有 image。
        // 这条一直没被测到，是因为 testdata 里从来没有过图片行（2026-10-09 补 07-图片 才暴露）。
        Kind::Image | Kind::Embed | Kind::File => {
            body.push_str(&b.indent);
            body.push_str(&b.content);
        }
        Kind::Ordered { marker } => {
            body.push_str(&b.indent);
            body.push_str(marker);
            body.push(' ');
            body.push_str(&b.content);
        }
        Kind::Paragraph => {
            body.push_str(&b.indent);
            body.push_str(&b.content);
        }
        other => {
            debug_assert!(!other.is_simple(), "{other:?} 不该进入规范化分支");
            out.push_str(&b.raw);
            return;
        }
    }

    // 行内字段必须写回，否则用户一保存 due:: 就消失了
    for (k, v) in &b.fields {
        body.push(' ');
        body.push_str(k);
        body.push_str(":: ");
        body.push_str(v);
    }

    // 列表嵌套：子块以两空格缩进续排
    for c in &b.children {
        body.push_str(eol);
        let mut sub = String::new();
        render_block(&mut sub, c);
        let sub_indent = format!("{}  ", b.indent);
        for line in split_keep_eol(&sub) {
            if line.trim().is_empty() {
                body.push_str(line);
            } else {
                body.push_str(&sub_indent);
                body.push_str(line.trim_start_matches([' ', '\t']));
            }
        }
    }

    // 简单块的 ID 一律附在末行尾部（Obsidian 语法）
    if let Some(id) = &b.id {
        body.push_str(" ^");
        body.push_str(id);
    }
    // 文件末行原本没有换行时不能凭空补一个，否则破坏字节相等
    if b.raw.ends_with('\n') {
        body.push_str(eol);
    }
    out.push_str(&body);
}

// ---------------------------------------------------------------------------
// 行内文本与字段
// ---------------------------------------------------------------------------

/// 只认这两个行内字段键。其余 `key::` 一律当普通文本——社区约定没有注册表，
/// 猜错就等于吃掉用户内容。
const KNOWN_FIELDS: &[&str] = &["due", "done"];

/// 从行尾剥出行内字段，返回 (字段, 剩余文本)。
pub fn extract_fields(text: &str) -> (Vec<(String, String)>, String) {
    let mut fields = Vec::new();
    let mut rest = text.to_string();
    while let Some(pos) = rest.rfind("::") {
        let head = rest[..pos].trim_end();
        let value = rest[pos + 2..].trim();
        let Some(key_start) = head.rfind([' ', '\t']) else {
            break;
        };
        let key = &head[key_start + 1..];
        if !KNOWN_FIELDS.contains(&key) || value.is_empty() || value.contains('\n') {
            break;
        }
        fields.push((key.to_string(), value.to_string()));
        rest = head[..key_start].trim_end().to_string();
    }
    fields.reverse();
    (fields, rest)
}

/// 剥离行内语法，产出可检索文本。
pub fn plain_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    // 只对**我们自己写出**的标签记账：正文里随手写的 `</span>` / `</sup>` 该原样留着
    let mut span_depth = 0usize;
    // `<sup>` / `<sub>` 只有成对才当语法。开标签先记下剥掉它的位置，扫完还留着没配对的，
    // 再原样补回去——与前端 `parseInline` 同一条判据：宁可少识别，也不吃用户的字面文字。
    // `out` 只增不减，位置随出现顺序单调不减。
    let mut opens: Vec<(usize, &'static str)> = Vec::new();
    while i < b.len() {
        match b[i] {
            b'`' => {
                let n = run_len(b, i);
                // 找同长度的闭合反引号串
                let mut j = i + n;
                let mut found = None;
                while j < b.len() {
                    if b[j] == b'`' && run_len(b, j) == n {
                        found = Some(j);
                        break;
                    }
                    j += 1;
                }
                match found {
                    Some(k) => {
                        out.push_str(&text[i + n..k]);
                        i = k + n;
                    }
                    None => i += n,
                }
            }
            b'\\' if i + 1 < b.len() => {
                let n = text[i + 1..].chars().next().unwrap().len_utf8();
                out.push_str(&text[i + 1..i + 1 + n]);
                i += 1 + n;
            }
            b'^' => {
                // 块 ID 标记不进检索文本
                let word: String = text[i + 1..]
                    .chars()
                    .take_while(|c| !c.is_whitespace())
                    .collect();
                if is_valid_block_id(&word) {
                    i += 1 + word.len();
                } else {
                    out.push('^');
                    i += 1;
                }
            }
            b'!' if text[i..].starts_with("![[") => {
                let inner = &text[i + 3..];
                match inner.find("]]") {
                    Some(e) => {
                        push_wikilink(&mut out, &inner[..e]);
                        i += 3 + e + 2;
                    }
                    None => {
                        out.push('!');
                        i += 1;
                    }
                }
            }
            b'[' if text[i..].starts_with("[[") => {
                let inner = &text[i + 2..];
                match inner.find("]]") {
                    Some(e) => {
                        push_wikilink(&mut out, &inner[..e]);
                        i += 2 + e + 2;
                    }
                    None => {
                        out.push('[');
                        i += 1;
                    }
                }
            }
            b'[' => {
                // [文字](目标) / [文字][引用]
                match text[i..].find(']') {
                    Some(close) => {
                        out.push_str(&text[i + 1..i + close]);
                        let mut j = i + close + 1;
                        if text[j..].starts_with('(') {
                            j += text[j..].find(')').map(|p| p + 1).unwrap_or(0);
                        } else if text[j..].starts_with('[') {
                            j += text[j..].find(']').map(|p| p + 1).unwrap_or(0);
                        }
                        i = j;
                    }
                    None => {
                        out.push('[');
                        i += 1;
                    }
                }
            }
            b'<' => {
                // 颜色用 `<span style="…">`、上下标用 `<sup>` / `<sub>` 落盘
                // （docs/02 D35 / D38）。标签不该进检索与嵌入——否则搜 "span" / "sup"
                // 能搜出一堆笔记，AI 的上下文里也全是标签。字本身要留下。
                let rest = &text[i..];
                if rest.starts_with("<span style=\"color:")
                    || rest.starts_with("<span style=\"background-color:")
                {
                    match rest.find("\">") {
                        Some(e) => {
                            span_depth += 1;
                            i += e + 2;
                        }
                        None => {
                            out.push('<');
                            i += 1;
                        }
                    }
                } else if rest.starts_with("</span>") && span_depth > 0 {
                    span_depth -= 1;
                    i += 7;
                } else if rest.starts_with("<sup>") {
                    opens.push((out.len(), "<sup>"));
                    i += 5;
                } else if rest.starts_with("</sup>") {
                    match opens.iter().rposition(|&(_, t)| t == "<sup>") {
                        Some(at) => {
                            opens.remove(at);
                            i += 6;
                        }
                        None => {
                            out.push('<');
                            i += 1;
                        }
                    }
                } else if rest.starts_with("<sub>") {
                    opens.push((out.len(), "<sub>"));
                    i += 5;
                } else if rest.starts_with("</sub>") {
                    match opens.iter().rposition(|&(_, t)| t == "<sub>") {
                        Some(at) => {
                            opens.remove(at);
                            i += 6;
                        }
                        None => {
                            out.push('<');
                            i += 1;
                        }
                    }
                } else {
                    out.push('<');
                    i += 1;
                }
            }
            // `==高亮==`。判据与前端同一份：两侧紧凑、体内不换行；不满足就当普通的等号，
            // `a == b` 这种数学写法不能被吃掉一个字符
            b'=' if text[i..].starts_with("==") => match text[i + 2..].find("==") {
                Some(k) => {
                    let body = &text[i + 2..i + 2 + k];
                    if !body.is_empty()
                        && !body.starts_with(char::is_whitespace)
                        && !body.ends_with(char::is_whitespace)
                        && !body.contains('\n')
                    {
                        out.push_str(body);
                        i += 2 + k + 2;
                    } else {
                        out.push('=');
                        i += 1;
                    }
                }
                None => {
                    out.push('=');
                    i += 1;
                }
            },
            b'*' | b'_' | b'~' | b'|' => {
                i += run_len(b, i);
            }
            _ => {
                let c = text[i..].chars().next().unwrap();
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    // 没等到收口的开标签按原样补回去。倒序插入，前面记下的偏移才不会被后面的插入推走；
    // 同位置的标签（`<sup><sub>` 紧挨着）也靠倒序还原成原来的先后。
    for &(at, tag) in opens.iter().rev() {
        out.insert_str(at, tag);
    }
    out
}

fn push_wikilink(out: &mut String, inner: &str) {
    match inner.rsplit_once('|') {
        Some((_, alias)) if !alias.trim().is_empty() => out.push_str(alias.trim()),
        _ => out.push_str(inner.trim()),
    }
}

fn run_len(b: &[u8], i: usize) -> usize {
    let c = b[i];
    let mut n = 0;
    while i + n < b.len() && b[i + n] == c {
        n += 1;
    }
    n
}

// ---------------------------------------------------------------------------
// 分节（docs/03 §大文档策略 / Spike C）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Section {
    /// 该节起始块的索引；`heading` 为该节标题块（首节可能没有）。
    pub range: Range<usize>,
    pub heading: Option<String>,
    pub level: u8,
}

impl Doc {
    pub fn blocks_flat(&self) -> Vec<&Block> {
        fn go<'a>(b: &'a Block, out: &mut Vec<&'a Block>) {
            out.push(b);
            for c in &b.children {
                go(c, out);
            }
        }
        let mut v = Vec::new();
        for b in &self.blocks {
            go(b, &mut v);
        }
        v
    }

    /// 按 H1/H2 切节，供分节渲染挂载/卸载编辑器实例。
    pub fn heading_sections(&self) -> Vec<Section> {
        if self.blocks.is_empty() {
            return Vec::new();
        }
        let is_cut = |b: &Block| matches!(b.kind, Kind::Heading { level: 1 | 2, .. });
        let mut starts: Vec<usize> = self
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, b)| is_cut(b))
            .map(|(i, _)| i)
            .collect();
        if starts.first() != Some(&0) {
            starts.insert(0, 0);
        }
        starts
            .iter()
            .enumerate()
            .map(|(i, &s)| {
                let e = starts.get(i + 1).copied().unwrap_or(self.blocks.len());
                let (heading, level) = if is_cut(&self.blocks[s]) {
                    heading_of(&self.blocks[s])
                } else {
                    (None, 0)
                };
                Section {
                    range: s..e,
                    heading,
                    level,
                }
            })
            .collect()
    }

    /// 含嵌套的总块数（800 块拆分预警用）。
    pub fn block_count(&self) -> usize {
        self.blocks.iter().map(Block::count).sum()
    }

    /// 未识别（`raw`/`html`）块数——设置页展示，不当失败（docs/03 §可观测性）。
    pub fn unrecognized_count(&self) -> usize {
        self.blocks_flat()
            .iter()
            .filter(|b| matches!(b.kind, Kind::Raw | Kind::Html))
            .count()
    }
}

fn heading_of(b: &Block) -> (Option<String>, u8) {
    match &b.kind {
        Kind::Heading { level, .. } => (b.id.clone(), *level),
        _ => (None, 0),
    }
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Line {
    text: String,
    eol: &'static str,
}

struct Cursor {
    lines: Vec<Line>,
    pos: usize,
    gap: String,
}

impl Cursor {
    fn new(lines: Vec<Line>) -> Self {
        Self {
            lines,
            pos: 0,
            gap: String::new(),
        }
    }
    fn at_end(&self) -> bool {
        self.pos >= self.lines.len()
    }
    fn cur(&self) -> Option<&Line> {
        self.lines.get(self.pos)
    }
    fn peek(&self, k: usize) -> Option<&Line> {
        self.lines.get(self.pos + k)
    }
    fn bump(&mut self) -> Option<Line> {
        let l = self.lines.get(self.pos).cloned();
        if l.is_some() {
            self.pos += 1;
        }
        l
    }
    fn take_gap(&mut self) -> String {
        std::mem::take(&mut self.gap)
    }
    fn take_front_matter(&mut self) -> Option<FrontMatter> {
        if self.cur()?.text.trim() != "---" {
            return None;
        }
        let mut i = self.pos + 1;
        let end = loop {
            let l = self.lines.get(i)?;
            let t = l.text.trim();
            if t == "---" || t == "..." {
                break i;
            }
            i += 1;
        };
        let slice = self.lines[self.pos..=end].to_vec();
        self.pos = end + 1;
        let raw = raw_of(&slice);
        let yaml = raw_of(&slice[1..slice.len() - 1]);
        Some(FrontMatter { raw, yaml })
    }
}

fn split_lines(src: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            let chunk = &src[start..i];
            match chunk.strip_suffix('\r') {
                Some(t) => out.push(Line {
                    text: t.to_string(),
                    eol: "\r\n",
                }),
                None => out.push(Line {
                    text: chunk.to_string(),
                    eol: "\n",
                }),
            }
            start = i + 1;
        }
    }
    if start < src.len() {
        out.push(Line {
            text: src[start..].to_string(),
            eol: "",
        });
    }
    out
}

fn split_keep_eol(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            out.push(&s[start..=i]);
            start = i + 1;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn raw_of(lines: &[Line]) -> String {
    let mut s = String::new();
    for l in lines {
        s.push_str(&l.text);
        s.push_str(l.eol);
    }
    s
}

fn blank(l: Option<&Line>) -> bool {
    l.map(|x| x.text.trim().is_empty()).unwrap_or(true)
}

fn detect_eol(raw: &str) -> &'static str {
    if raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn indent_of(text: &str) -> String {
    let n = text.len() - text.trim_start_matches(' ').len();
    text[..n].to_string()
}

/// 对齐包裹的开标签：只认我们自己写的那三种值。`left` 不落包裹。
fn wrapper_align(text: &str) -> Option<&'static str> {
    match text {
        "<div align=\"center\">" => Some("center"),
        "<div align=\"right\">" => Some("right"),
        "<div align=\"justify\">" => Some("justify"),
        _ => None,
    }
}

/// 识别对齐包裹（docs/02 D40）：开标签独占一行、紧跟一个空行，内部恰好一块正文
/// （段落或 ATX 标题），再跟一个空行与 `</div>`。
///
/// 只吃这一种精确形状。内部有多块、含空行、嵌套包裹，或者外面的 `<div>` 不是我们
/// 写的那几个 align 值，都留给 `Kind::Html` 照旧当不透明块原样回显——宁可少识别，
/// 也不替用户改他手写的 HTML。
fn take_wrapped(c: &mut Cursor) -> Option<Block> {
    let align = wrapper_align(&c.cur()?.text)?;
    // 我们自己写的空行是**真的空**（连空格都没有）。带空格的"空行"不认：
    // 认了之后第一次编辑就会把它规整掉，等于悄悄改了用户文件里的几个字节。
    if !matches!(c.peek(1), Some(l) if l.text.is_empty()) {
        return None;
    }
    let mut close = None;
    let mut i = 2;
    while let Some(l) = c.peek(i) {
        if l.text == "</div>" {
            close = Some(i);
            break;
        }
        i += 1;
    }
    let close = close?;
    // 正文与收尾标签之间必须隔一个空行，否则那不是"包裹一段"的形状
    if close < 3 || !matches!(c.peek(close - 1), Some(l) if l.text.is_empty()) {
        return None;
    }
    // 正文内部不能再有空行：那会切出多块，属于 B 方案（容器）的领地
    if (2..close - 1).any(|k| blank(c.peek(k))) {
        return None;
    }
    let inner: Vec<Line> = (2..close - 1).filter_map(|k| c.peek(k).cloned()).collect();
    let mut ic = Cursor::new(inner);
    let mut blocks = parse_blocks(&mut ic);
    if blocks.len() != 1 || !ic.gap.is_empty() {
        return None;
    }
    let mut b = blocks.pop().unwrap();
    let alignable = matches!(
        b.kind,
        Kind::Paragraph
            | Kind::Heading {
                style: HeadingStyle::Atx,
                ..
            }
    );
    if !alignable || !b.children.is_empty() || b.align.is_some() {
        return None;
    }
    let slice: Vec<Line> = (0..=close).filter_map(|k| c.peek(k).cloned()).collect();
    b.raw = raw_of(&slice);
    b.gap_before = String::new();
    b.align = Some(align.to_string());
    b.line_start = 0;
    b.line_end = 0;
    for _ in 0..=close {
        c.bump();
    }
    Some(b)
}

fn parse_blocks(c: &mut Cursor) -> Vec<Block> {
    let mut out = Vec::new();
    loop {
        if c.at_end() {
            break;
        }
        if blank(c.cur()) {
            let l = c.bump().unwrap();
            c.gap.push_str(&l.text);
            c.gap.push_str(l.eol);
            continue;
        }
        let start = c.pos;
        // 对齐包裹必须先于 HTML 块判定：`<div align="center">` 本身是 HTML 行，
        // 认出来之后里面那一块才是可编辑正文。
        let mut batch: Vec<Block> = if let Some(b) = take_wrapped(c) {
            vec![b]
        } else {
            match classify(c) {
                Start::Fence => take_code(c).into_iter().collect(),
                Start::Math => take_math(c).into_iter().collect(),
                Start::Atx(level) => take_atx(c, level).into_iter().collect(),
                Start::Hr => take_hr(c).into_iter().collect(),
                Start::Quote => take_quote(c).into_iter().collect(),
                // 列表不产生容器块：条目本身就是可寻址块（docs/02 的 bullet/numbered）
                Start::List { ordered, marker } => take_list_items(c, ordered, marker),
                Start::Table => take_table(c).into_iter().collect(),
                Start::Html => take_html(c).into_iter().collect(),
                Start::Paragraph => take_paragraph(c).into_iter().collect(),
            }
        };
        // 独占成行的块 ID 归属于它上面那个块（docs/02 §块 ID）。
        // 不在这里处理就会被解析成一个空段落，且该块的 ID 永久丢失。
        if let Some(last) = batch.last_mut() {
            if last.id.is_none() {
                let line_text = c
                    .cur()
                    .map(|l| l.text.trim().to_string())
                    .unwrap_or_default();
                if let Some(body) = line_text.strip_prefix('^') {
                    if is_valid_block_id(body) {
                        let l = c.bump().unwrap();
                        last.raw.push_str(&raw_of(std::slice::from_ref(&l)));
                        last.line_end = c.pos;
                        last.id = Some(body.to_string());
                    }
                }
            }
        }
        if batch.is_empty() {
            // 防御：任何分类都必须至少产出一个块，否则推进一行避免死循环
            let l = c.bump().unwrap();
            let raw = raw_of(std::slice::from_ref(&l));
            let mut b = mk(Kind::Raw, &[l], String::new(), None, Vec::new(), Vec::new());
            b.raw = raw;
            batch.push(b);
        }
        let gap = c.take_gap();
        let mut ln = start + 1;
        for (i, mut b) in batch.drain(..).enumerate() {
            // 只有第一个块认领累积的空行；列表条目自带的 gap（松散列表）不能被覆盖
            if i == 0 {
                b.gap_before = gap.clone();
            }
            // 首个块的 gap 已在 `start` 之前被消费掉，不能再计一次行号
            if i > 0 {
                ln += b.gap_before.matches('\n').count();
            }
            let consumed = b.raw.matches('\n').count()
                + if b.raw.ends_with('\n') || b.raw.is_empty() {
                    0
                } else {
                    1
                };
            b.line_start = ln;
            b.line_end = ln + consumed.saturating_sub(1);
            ln += consumed;
            out.push(b);
        }
    }
    out
}

enum Start {
    Fence,
    Math,
    Atx(u8),
    Hr,
    Quote,
    List { ordered: bool, marker: String },
    Table,
    Html,
    Paragraph,
}

fn classify(c: &Cursor) -> Start {
    let raw = &c.cur().unwrap().text;
    let t = raw.trim_start_matches(' ');
    let indent_ok = raw.len() - t.len() <= 3;
    if indent_ok {
        if t.starts_with("```") || t.starts_with("~~~") {
            return Start::Fence;
        }
        if t.starts_with("$$") {
            return Start::Math;
        }
        if t.starts_with('#') {
            let level = t.chars().take_while(|ch| *ch == '#').count();
            let after = &t[level..];
            if level <= 6 && (after.is_empty() || after.starts_with([' ', '\t'])) {
                return Start::Atx(level as u8);
            }
        }
        if is_hr(t) {
            return Start::Hr;
        }
        if t.starts_with('>') {
            return Start::Quote;
        }
        if let Some((ordered, marker)) = list_marker(t) {
            return Start::List { ordered, marker };
        }
        if t.contains('|') {
            if let Some(next) = c.peek(1) {
                if is_table_delim(next.text.trim()) {
                    return Start::Table;
                }
            }
        }
        if t.starts_with('<') && t[1..].starts_with(is_html_tag_char) {
            // 行首的**行内颜色 span 与上下标**不是 HTML 块（2026-10-28 / 2026-11-02 实测）：
            // "把一整行上色"存出来就是 `<span style="color:#…">整行</span>`，段首一个
            // `<sup>` 也会让这一行以 `<` 开头——按这里原来的判据会被读成 `html` 不透明块，
            // 再打开时那一块变成源码、不能当正文编辑。CommonMark 的 HTML 块（类型 7）要求
            // **整行只有一个标签**，而这一行标签后面跟着正文，本来就是段落。只排除我们自己
            // 产出的这几种写法，别的 `<div>` 照旧当不透明块（宁可少识别，也不吃用户的语法）。
            if !(t.starts_with("<span style=\"color:")
                || t.starts_with("<span style=\"background-color:")
                || t.starts_with("<sup>")
                || t.starts_with("<sub>"))
            {
                return Start::Html;
            }
        }
    }
    Start::Paragraph
}

fn is_html_tag_char(b: char) -> bool {
    b.is_ascii_alphabetic() || matches!(b, '!' | '/' | '?')
}

fn is_hr(t: &str) -> bool {
    let mut it = t.chars().filter(|c| !c.is_whitespace());
    match it.next() {
        Some(m @ ('-' | '*' | '_')) => it.clone().count() >= 2 && it.all(|c| c == m),
        _ => false,
    }
}

fn is_setext(t: &str) -> Option<u8> {
    let s = t.trim();
    if !s.is_empty() && s.chars().all(|c| c == '-') {
        Some(2)
    } else if !s.is_empty() && s.chars().all(|c| c == '=') {
        Some(1)
    } else {
        None
    }
}

fn is_table_delim(t: &str) -> bool {
    !t.is_empty()
        && t.contains('-')
        && t.contains('|')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// 无序 `-`/`*`/`+`，有序 `1.` / `1)`，其后必须有空白或行尾。
fn list_marker(t: &str) -> Option<(bool, String)> {
    if let Some(rest) = t.strip_prefix(['-', '*', '+']) {
        return if rest.is_empty() || rest.starts_with([' ', '\t']) {
            Some((false, t[..1].to_string()))
        } else {
            None
        };
    }
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 9 {
        return None;
    }
    let rest = &t[digits.len()..];
    let delim = rest.chars().next()?;
    if delim != '.' && delim != ')' {
        return None;
    }
    let after = &rest[delim.len_utf8()..];
    if after.is_empty() || after.starts_with([' ', '\t']) {
        Some((true, format!("{digits}{delim}")))
    } else {
        None
    }
}

fn mk(
    kind: Kind,
    lines: &[Line],
    content: String,
    title: Option<String>,
    children: Vec<Block>,
    fields: Vec<(String, String)>,
) -> Block {
    let raw = raw_of(lines);
    let text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let (id, _) = trailing_id(&text);
    Block {
        kind,
        id,
        raw,
        gap_before: String::new(),
        indent: lines
            .first()
            .map(|l| indent_of(&l.text))
            .unwrap_or_default(),
        content,
        title,
        children,
        fields,
        align: None,
        line_start: 0,
        line_end: 0,
    }
}

/// 取出文本尾部的 `^b-xxx`（行内或独占成行都算），返回 (id, 去掉标记的文本)。
fn trailing_id(text: &str) -> (Option<String>, String) {
    let trimmed = text.trim_end();
    let Some(idx) = trimmed.rfind('^') else {
        return (None, trimmed.to_string());
    };
    let cand = &trimmed[idx + 1..];
    let before_empty = trimmed[..idx].trim_end().is_empty();
    let sep_ok = idx == 0 || trimmed[..idx].ends_with([' ', '\t']);
    if is_valid_block_id(cand) && (sep_ok || before_empty) {
        (
            Some(cand.to_string()),
            trimmed[..idx].trim_end().to_string(),
        )
    } else {
        (None, trimmed.to_string())
    }
}

fn take_code(c: &mut Cursor) -> Option<Block> {
    let open = c.bump()?;
    let ot = open.text.trim_start();
    let ch = ot.as_bytes()[0] as char;
    let fence: String = ot.chars().take_while(|x| *x == ch).collect();
    let info = ot[fence.len()..].trim().to_string();
    let mut lines = vec![open];
    let mut closed = false;
    while let Some(l) = c.cur() {
        let lt = l.text.trim_start_matches(' ');
        let is_close = lt.starts_with(&fence)
            && lt.chars().take_while(|x| *x == ch).count() >= fence.len()
            && lt[fence.len()..].trim().is_empty();
        lines.push(c.bump().unwrap());
        if is_close {
            closed = true;
            break;
        }
    }
    // 代码正文存进 content，供 FTS 与嵌入检索；围栏本身不参与
    let body: Vec<&str> = lines[1..lines.len().saturating_sub(if closed { 1 } else { 0 })]
        .iter()
        .skip(1)
        .map(|l| l.text.as_str())
        .collect();
    let _ = closed;
    Some(mk(
        Kind::Code { fence, info },
        &lines,
        body.join("\n"),
        None,
        Vec::new(),
        Vec::new(),
    ))
}

fn take_math(c: &mut Cursor) -> Option<Block> {
    let first = c.bump()?;
    let one_line = {
        let t = first.text.trim();
        t.chars().count() > 4 && t.starts_with("$$") && t.ends_with("$$")
    };
    let mut lines = vec![first];
    if !one_line {
        while let Some(l) = c.cur() {
            let done = l.text.trim() == "$$";
            lines.push(c.bump().unwrap());
            if done {
                break;
            }
        }
    }
    Some(mk(
        Kind::Math,
        &lines,
        String::new(),
        None,
        Vec::new(),
        Vec::new(),
    ))
}

fn take_atx(c: &mut Cursor, level: u8) -> Option<Block> {
    let l = c.bump()?;
    let t = l.text.trim_start();
    let n = t.chars().take_while(|ch| *ch == '#').count();
    let rest = t[n..].trim();
    let (id, rest) = trailing_id(rest);
    let (fields, content) = extract_fields(rest.trim());
    let mut b = mk(
        Kind::Heading {
            level,
            style: HeadingStyle::Atx,
        },
        &[l],
        content,
        None,
        Vec::new(),
        fields,
    );
    b.id = id.or(b.id);
    Some(b)
}

fn take_hr(c: &mut Cursor) -> Option<Block> {
    let l = c.bump()?;
    Some(mk(
        Kind::Divider,
        &[l],
        String::new(),
        None,
        Vec::new(),
        Vec::new(),
    ))
}

fn take_table(c: &mut Cursor) -> Option<Block> {
    let mut lines = Vec::new();
    while let Some(l) = c.cur() {
        if l.text.trim().is_empty() {
            break;
        }
        lines.push(c.bump().unwrap());
    }
    Some(mk(
        Kind::Table,
        &lines,
        String::new(),
        None,
        Vec::new(),
        Vec::new(),
    ))
}

fn take_html(c: &mut Cursor) -> Option<Block> {
    let mut lines = Vec::new();
    while let Some(l) = c.cur() {
        if l.text.trim().is_empty() {
            break;
        }
        lines.push(c.bump().unwrap());
    }
    Some(mk(
        Kind::Html,
        &lines,
        String::new(),
        None,
        Vec::new(),
        Vec::new(),
    ))
}

fn take_quote(c: &mut Cursor) -> Option<Block> {
    let mut lines = Vec::new();
    while let Some(l) = c.cur() {
        let t = l.text.trim_start_matches(' ');
        if t.starts_with('>') {
            lines.push(c.bump().unwrap());
            continue;
        }
        if !l.text.trim().is_empty() && !starts_block(c) {
            lines.push(c.bump().unwrap()); // 懒惰续行
            continue;
        }
        break;
    }
    // 剥 `> ` 前缀后递归解析内部块。引用/Callout 永远回显 raw，
    // 所以懒惰续行与前缀不齐整的情况都不会丢内容。
    let mut inner = Vec::with_capacity(lines.len());
    for l in &lines {
        let t = l.text.trim_start_matches(' ');
        match t.strip_prefix('>') {
            Some(body) => inner.push(Line {
                text: body.strip_prefix(' ').unwrap_or(body).to_string(),
                eol: l.eol,
            }),
            None => inner.push(l.clone()),
        }
    }
    // Callout 的标题就是内部第一行，不能等到合并成段落之后再拆——
    // 那样 `> [!question] 标题` 与下一行 `> 正文` 会并成一个段落，标题吃进正文。
    let head_line = inner
        .first()
        .map(|l| l.text.trim().to_string())
        .unwrap_or_default();
    let (kind, title, skip) = match parse_callout_head(&head_line) {
        Some((ty, folded)) => {
            let cut = head_line.find(']').unwrap() + 1;
            let t = head_line[cut..]
                .trim()
                .trim_start_matches(['-', '+'])
                .trim()
                .to_string();
            (
                Kind::Callout { ty, folded },
                if t.is_empty() { None } else { Some(t) },
                1,
            )
        }
        None => (Kind::Quote, None, 0),
    };
    let mut ic = Cursor::new(if skip == 0 {
        inner
    } else {
        inner[1..].to_vec()
    });
    let children = parse_blocks(&mut ic);
    // 引用/Callout 的正文由 children 承载，content 留空以免重复计入检索文本
    Some(mk(kind, &lines, String::new(), title, children, Vec::new()))
}

fn starts_block(c: &Cursor) -> bool {
    let t = match c.cur() {
        Some(l) => l.text.trim_start_matches(' '),
        None => return true,
    };
    is_hr(t)
        || t.starts_with("```")
        || t.starts_with("~~~")
        || t.starts_with('#')
        || t.starts_with('>')
        || t.starts_with("$$")
        || list_marker(t).is_some()
}

fn parse_callout_head(t: &str) -> Option<(String, bool)> {
    let rest = t.strip_prefix("[!")?;
    let end = rest.find(']')?;
    let ty = rest[..end].to_string();
    if ty.is_empty() || ty.contains([' ', '\n']) {
        return None;
    }
    let after = &rest[end + 1..];
    let folded = after.trim_start().starts_with('-');
    Some((ty, folded))
}

/// 收集整个列表区间，返回条目块（列表不产生容器块）。
/// `ordered` 决定更深缩进的子列表条目如何续排；`marker` 保留首个条目的原始记号。
fn take_list_items(c: &mut Cursor, ordered: bool, marker: String) -> Vec<Block> {
    let Some(first) = c.cur() else {
        return Vec::new();
    };
    let base_indent = indent_of(&first.text).len();
    let mut lines: Vec<Line> = Vec::new();
    while let Some(l) = c.cur() {
        if l.text.trim().is_empty() {
            // 空行后仍是列表内容则并入，否则列表到此为止
            let mut k = 1;
            while matches!(c.peek(k), Some(x) if x.text.trim().is_empty()) {
                k += 1;
            }
            let keep = match c.peek(k) {
                Some(n) => {
                    let ind = indent_of(&n.text).len();
                    let m = list_marker(n.text.trim_start_matches(' '));
                    matches!(&m, Some((_, mk)) if ind >= base_indent && !marker_kind_mismatch(ordered, mk))
                        || (m.is_none() && ind > base_indent)
                }
                None => false,
            };
            if keep {
                lines.push(c.bump().unwrap());
                continue;
            }
            break;
        }
        let ind = indent_of(&l.text).len();
        let m = list_marker(l.text.trim_start_matches(' '));
        match m {
            // 同级或更深缩进的条目行都留在本区间
            Some((_, mk)) if ind <= base_indent => {
                if marker_kind_mismatch(ordered, &mk) && !lines.is_empty() {
                    break; // 另一种列表（- 与 1. 相邻但不是同一列表）
                }
                lines.push(c.bump().unwrap());
            }
            Some(_) => lines.push(c.bump().unwrap()), // 更深缩进的子列表
            None if !lines.is_empty() && (ind > base_indent || !starts_block(c)) => {
                lines.push(c.bump().unwrap()) // 条目续行
            }
            None => break,
        }
    }
    if lines.is_empty() {
        return Vec::new();
    }
    let _ = marker;
    split_list_items(&lines, base_indent)
}

/// 条目记号与列表类型是否不一致：`ordered` 列表的记号应以数字开头，
/// 无序列表应是 `-` / `*` / `+`。相邻但不同类型的两个列表要切开。
fn marker_kind_mismatch(ordered: bool, mk: &str) -> bool {
    let digit = mk.chars().next().is_some_and(|c| c.is_ascii_digit());
    ordered != digit
}

/// 列表条目的构建中间态。
struct ListItemState {
    marker: String,
    orig: Vec<Line>,
    body: Vec<Line>,
    col: usize,
    gap: Vec<Line>,
}

fn split_list_items(lines: &[Line], base_indent: usize) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut cur: Option<ListItemState> = None;
    // 空行先攒着：下一个是同级条目就是它的 gap，是续行就回填进当前条目。
    // 直接把空行塞进上一条目的 raw 也行，但那样规范化重建会把它丢掉。
    let mut pending: Vec<Line> = Vec::new();
    for l in lines {
        let ind = indent_of(&l.text).len();
        let t = l.text.trim_start_matches(' ');
        let m = list_marker(t);
        if l.text.trim().is_empty() {
            pending.push(l.clone());
            continue;
        }
        let starts_here = m.as_ref().is_some_and(|(_, mk)| {
            ind == base_indent && (t[mk.len()..].starts_with([' ', '\t']) || t.trim_end() == mk)
        });
        if starts_here {
            if let Some(it) = cur.take() {
                out.push(finish_item(it));
            }
            let (_, mk) = m.unwrap();
            let after = &t[mk.len()..];
            let spaces = (after.len() - after.trim_start().len()).clamp(1, 4);
            let col = ind + mk.len() + spaces;
            cur = Some(ListItemState {
                marker: mk.clone(),
                orig: vec![l.clone()],
                body: vec![Line {
                    text: after[spaces..].to_string(),
                    eol: l.eol,
                }],
                col,
                gap: std::mem::take(&mut pending),
            });
        } else if let Some(it) = cur.as_mut() {
            for g in pending.drain(..) {
                it.orig.push(g.clone());
                it.body.push(Line {
                    text: String::new(),
                    eol: g.eol,
                });
            }
            let text = if ind >= it.col {
                l.text.col(it.col)
            } else {
                t.to_string()
            };
            it.orig.push(l.clone());
            it.body.push(Line { text, eol: l.eol });
        } else {
            // 没有当前条目却出现悬空内容：交回上层，避免吞掉
            pending.clear();
        }
    }
    if let Some(it) = cur.take() {
        out.push(finish_item(it));
    }
    out
}

fn finish_item(it: ListItemState) -> Block {
    let ListItemState {
        marker,
        orig,
        body,
        col,
        gap,
    } = it;
    let mut blk = build_list_item(marker, &orig, &body, col);
    blk.gap_before = raw_of(&gap);
    blk
}

trait SliceExt {
    fn col(&self, n: usize) -> String;
}
impl SliceExt for str {
    fn col(&self, n: usize) -> String {
        let n = n.min(self.len());
        self[n..].to_string()
    }
}

/// `raw` 取自 `orig`（源文本原始行，含记号与缩进），否则重建会丢掉 `- `/`1.` 记号。
fn build_list_item(marker: String, orig: &[Line], body: &[Line], _col: usize) -> Block {
    let head = body[0].text.trim();
    // `- [ ]` / `- [x]`：方括号内必须恰为一个空格或 x/X，否则不是待办
    // （`[文字](链接)` 开头的条目很容易被误判成待办）。
    let todo = match head.strip_prefix('[') {
        Some(rest) if rest.len() >= 2 && rest.as_bytes()[1] == b']' => match rest.as_bytes()[0] {
            b' ' => Some((false, rest[2..].trim())),
            b'x' | b'X' => Some((true, rest[2..].trim())),
            _ => None,
        },
        _ => None,
    };
    let ordered_marker = marker.chars().next().is_some_and(|c| c.is_ascii_digit());
    let (kind, content_head) = match todo {
        Some((checked, rest)) => (Kind::Todo { checked }, rest.to_string()),
        None if ordered_marker => (Kind::Ordered { marker }, head.to_string()),
        None => (Kind::Bullet, head.to_string()),
    };
    let (id, content_head) = trailing_id(&content_head);
    let (fields, content) = extract_fields(content_head.trim());
    let mut children = Vec::new();
    if body.len() > 1 {
        let mut ic = Cursor::new(body[1..].to_vec());
        children = parse_blocks(&mut ic);
    }
    let raw = raw_of(orig);
    let (raw_id, _) = trailing_id(&raw);
    Block {
        kind,
        id: id.or(raw_id),
        raw,
        gap_before: String::new(),
        indent: String::new(),
        content,
        title: None,
        children,
        fields,
        align: None,
        line_start: 0,
        line_end: 0,
    }
}

/// 普通段落交给 `extract_fields` 之前的正文。
///
/// 行首半角空格记在 `indent` 里，这里剥掉，规范化时再补回去。开头的全角空格
/// （U+3000）是首行缩进，必须留在 `content` 里：编辑器只看见 `content`，按
/// `trim()` 剪掉的话，改一个字再保存，文件里的缩进就没了。标题和列表项不走这里。
fn paragraph_body(body: &str) -> &str {
    let body = body.trim_end();
    let body = body.trim_start_matches(' ');
    body.trim_start_matches(|c: char| c != '\u{3000}' && c.is_whitespace())
}

fn take_paragraph(c: &mut Cursor) -> Option<Block> {
    let mut lines: Vec<Line> = Vec::new();
    while let Some(l) = c.cur().cloned() {
        if l.text.trim().is_empty() {
            break;
        }
        if !lines.is_empty() {
            if let Some(level) = is_setext(&l.text) {
                c.bump();
                let joined = lines
                    .iter()
                    .map(|x| x.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let (id, body) = trailing_id(&joined);
                let (fields, content) = extract_fields(body.trim());
                let mut all = lines.clone();
                all.push(l.clone());
                let mut b = mk(
                    Kind::Heading {
                        level,
                        style: HeadingStyle::Setext,
                    },
                    &all,
                    content,
                    None,
                    Vec::new(),
                    fields,
                );
                b.id = id;
                return Some(b);
            }
            if starts_block(c) {
                break;
            }
        }
        c.bump();
        lines.push(l);
    }
    let joined = lines
        .iter()
        .map(|x| x.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let (id, body) = trailing_id(&joined);
    let (fields, content) = extract_fields(paragraph_body(&body));
    let kind = media_kind(&content);
    let mut b = mk(kind, &lines, content, None, Vec::new(), fields);
    b.id = id;
    Some(b)
}

/// 单元素段落按 docs/02 归为 image / embed / file。
fn media_kind(content: &str) -> Kind {
    let t = content.trim();
    if let Some(rest) = t.strip_prefix("![[") {
        if let Some(inner) = rest.strip_suffix("]]") {
            let target = inner.split('|').next().unwrap_or("");
            return if is_image_target(target) {
                Kind::Image
            } else {
                Kind::Embed
            };
        }
    }
    if t.starts_with("![") && t.ends_with_with_link() {
        return Kind::Image;
    }
    if t.len() > 3
        && t.starts_with("[[")
        && t.ends_with("]]")
        && !is_image_target(t[2..t.len() - 2].split('|').next().unwrap_or(""))
    {
        return Kind::File;
    }
    Kind::Paragraph
}

trait TailExt {
    fn ends_with_with_link(&self) -> bool;
}
impl TailExt for str {
    fn ends_with_with_link(&self) -> bool {
        self.ends_with(')') && self.contains("](")
    }
}

fn is_image_target(t: &str) -> bool {
    const EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"];
    let name = t.rsplit('/').next().unwrap_or(t);
    match name.rsplit_once('.') {
        Some((_, e)) => EXT.contains(&e.to_ascii_lowercase().as_str()),
        None => false,
    }
}

// 注：容器块（引用/Callout）的 id 由 mk() 从源文本尾部提取，末条条目的 ID 会同时
// 出现在容器与条目上。落库时只登记条目与引用块本身，容器不占 blocks 行。
