/**
 * 检索结果在界面上的两句话：这一条是**哪几路**捞上来的、这一趟走了**哪几路**。
 *
 * 名字与 Rust 那边一一对上（`note_core::retrieve::路::显示名`、`三路` 那张顺序表、
 * `走了哪几路` 的分隔符），由 `search.test.ts` 从 `retrieve.rs` 读原文比对，两边不一致就红。
 * 它刻意**只读形状不读函数体**——后端把实现改成 filter/map 这种写法，界面无感。
 * 这条护栏不是洁癖：
 * 上一档界面上写死的是"两路都中"，图扩展那一路一接上它当场变成谎——而它只是一个字符串，
 * 前端单测永远拦不住（2026-10-10 档 A 那条"话与控件对不上"是同一个形状）。
 */

/** 后端 serde 给的是小写档名（`#[serde(rename_all = "lowercase")]`），这边照收 */
export const 路名: Record<string, string> = {
  keyword: "关键词",
  semantic: "语义",
  graph: "链接",
};

/**
 * 一条命中的来源徽章。三条口径：
 * 1. **说得出是哪几路**，不用"多路都中"那种把档数写死的话——加一档路就得改一次文案，
 *    而没人会记得改；
 * 2. 认不出的档名**原样显示**。界面上多一个生词是难看，把一个不知道是什么的东西
 *    翻译成"关键词"是说谎；
 * 3. 顺序跟后端给的一致（关键词 → 语义 → 链接），前端不再排。
 */
export function 来源徽章(from: string[]): string {
  return from.map((f) => 路名[f] ?? f).join("+");
}

/**
 * 这一趟走了哪几路。**与 Rust 那份同序、同名、同分隔符**：关键词 → 链接 → 语义。
 * 面板右上角那句话、CLI 那行总结、hint 那句话都该是这么拼出来的，
 * 而不是各自写一句"关键词 + 语义两路合并"。
 */
export function 走了哪几路(semantic: boolean, graph: boolean): string {
  const 名 = ["关键词"];
  if (graph) 名.push("链接");
  if (semantic) 名.push("语义");
  return 名.join(" + ");
}

/**
 * 重排生效时加在后面那一段。**与 Rust 的 `重排尾巴` 逐字相等**（`search.test.ts` 比的就是
 * 这个），因为界面上右上角与 CLI 那行总结必须说同一句话。
 * 重排不是"一路"——它是合并之后的一道工序，所以不进上面那句话的主体。
 */
export const 重排尾巴 = " · 已重排";

/** 面板右上角与审计行读的那一句。三个布尔都是后端给的事实，不猜 */
export function 走了那句(semantic: boolean, graph: boolean, reranked: boolean): string {
  return 走了哪几路(semantic, graph) + (reranked ? 重排尾巴 : "");
}

/**
 * 侧栏那块的名字。原来叫「语义补充」——图扩展那一路接上之后它对任何 Key 都成立，
 * 而**没配嵌入模型时这一块照样有东西**，再叫"语义"就是把本地那一半说没了。
 */
export const 面板标题 = "检索补充";
