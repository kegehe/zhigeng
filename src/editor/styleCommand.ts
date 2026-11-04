import type { ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection } from "@tiptap/pm/state";

import { applyBlockType, blockTypePatch, 块转换位置, type BlockTypeId } from "./blocks";
import { 调色板, 底色of } from "./colors";
import { serializeInline } from "./inline";
import { 引用账本 } from "./quoteFace";
import type { 锚 } from "./rewrite";

/**
 * 显式样式动词的**本地快路径**（2026-11-02）。
 *
 * "把这段加粗""改成二级标题""换成红色"这类要求没有歧义，也不需要措辞——让一次网络
 * 往返去猜它，只会多花一笔 token、多等两秒，还会把结果塞进"预览 → 点替换"那道流程里。
 * 所以识别得**严**：整句归一之后必须与一条动词表**完全对上**才本地执行；带上
 * "再正式一点""顺便压缩到一半"这类内容要求的一律不拦，交回模型。
 *
 * 三条边界：
 * 1. **只在有选区时走**。没有选区时"加粗"说不清加粗哪一段，那是整篇编辑的事。
 * 2. 行内样式只动**选中的那几个字**；块类型（标题 / 列表 / 引用）动**光标所在的那一块**——
 *    Markdown 没有"半行标题"这种语法。
 * 3. 与模型那条路一样**只落一笔事务**，`Ctrl+Z` 一步回来；没有改动就不发事务。
 */

type 标记名 = "bold" | "italic" | "strike" | "code" | "highlight" | "sup" | "sub";

export type 样式命令 =
  | { 类: "标记"; 标: 标记名; 开: boolean; 名: string }
  | { 类: "颜色"; 标: "textColor" | "bgColor"; 色: string | null; 名: string }
  | { 类: "清除" }
  | { 类: "块"; 型: BlockTypeId; 名: string }
  | { 类: "引用" };

export type 应用果 = {
  /** 没有改动就是 null：调用方不许发空事务（会把笔记白标一次脏） */
  tr: Transaction | null;
  /** 给用户看的一句话：做了什么，或者为什么没动 */
  说明: string;
};

const 标点 = /[\s，。！？、；：""''（）()【】\[\]「」《》,.!?;:'"`~]/g;
const 礼貌头 = /^(请你|请|麻烦你|麻烦|帮我|帮忙|能不能|可以|你)/;
const 礼貌尾 = /(一下|吧|呢|呗|谢谢|好吗|可以吗|行吗)$/;
const 指代 = /^(选中的|圈起来的|这几个字|这些字|这部分|这一段|这段|这一句|这句|这行|当前段落|当前段|当前行|该段|它)/;
const 动作头 = /^(改成|改为|设为|设置为|变成|变作|换为|换成|调成|调为|变为|作为|做成|成|为)/;
const 连接 = "(?:改成|改为|设为|设置为|变成|换成|调成|调为|变为|用|成|为|是)?";

/** 归一：命令只有"整句就是一个动作"时才认，所以先把礼貌、指代与动词头削掉 */
function 归一(令: string): string {
  let s = 令.trim().toLowerCase().replace(标点, "");
  for (let i = 0; i < 3; i++) s = s.replace(礼貌头, "");
  s = s.replace(/^(把|将)/, "");
  s = s.replace(指代, "");
  s = s.replace(/^用/, "");
  s = s.replace(动作头, "");
  for (let i = 0; i < 3; i++) s = s.replace(礼貌尾, "");
  return s;
}

const 标记词: [RegExp, 标记名, string][] = [
  [/^(?:加粗|粗体|加黑|粗体字|加粗显示|bold)$/, "bold", "加粗"],
  [/^(?:斜体|倾斜|斜体字|意大利体|italic)$/, "italic", "斜体"],
  [/^(?:删除线|中划线|划掉|删除线格式|strike)$/, "strike", "删除线"],
  [/^(?:行内代码|行内码|代码格式|等宽|等宽字体|代码|code)$/, "code", "行内代码"],
  [/^(?:高亮|高亮显示|荧光笔|标记高亮|highlight)$/, "highlight", "高亮"],
  [/^(?:上标|上标格式|superscript|sup)$/, "sup", "上标"],
  [/^(?:下标|下标格式|subscript|sub)$/, "sub", "下标"],
];

/** 颜色词 → 调色板。`黄` / `橘` 都落到 amber（调色板里它叫「橙」） */
const 色别名: Record<string, string> = {
  红: "red",
  橙: "amber",
  黄: "amber",
  橘: "amber",
  绿: "green",
  蓝: "blue",
  紫: "purple",
  灰: "gray",
};

function 找色(s: string): { id: string; 名: string; hex: string } | null {
  const m = /^(红|橙|黄|橘|绿|蓝|紫|灰)色?$/.exec(s);
  if (!m) return null;
  const id = 色别名[m[1]!]!;
  const 项 = 调色板.find((c) => c.id === id);
  return 项 ? { id, 名: 项.名, hex: 项.hex } : null;
}

const 标题数: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function 找标题(s: string): number | null {
  let m = /^(?:标题|大标题)([1-6一二三四五六])$/.exec(s);
  if (!m) m = /^第?([1-6一二三四五六])(?:级|号)?标题$/.exec(s);
  if (!m) m = /^h([1-6])$/.exec(s);
  if (!m) return null;
  return 数字(m[1]!);
}

function 数字(s: string): number {
  return 标题数[s] ?? Number(s);
}

/** 整句归一后认一条命令；认不出就是 null（交回模型，不许猜） */
export function 识别样式命令(令: string): 样式命令 | null {
  const s = 归一(令);
  if (!s) return null;

  // 1) 清除格式。排在动词表前面：「清除所有格式」不能只命中「清除加粗」那种半截
  if (/^(?:清除|清空|去掉|去除|取消|删除|移除)(?:所有|全部)?(?:的)?(?:格式|样式)$/.test(s)) {
    return { 类: "清除" };
  }

  // 2) 块类型。Markdown 的块语法只能整块换，所以这一档动的是光标所在的那一块
  const 级 = 找标题(s);
  if (级 !== null) {
    return { 类: "块", 型: `heading${级}` as BlockTypeId, 名: `标题 ${级}` };
  }
  if (/^(?:正文|普通段落|普通文本|正文段落|段落|恢复正文|回到正文)$/.test(s)) {
    return { 类: "块", 型: "paragraph", 名: "正文" };
  }
  if (/^(?:无序列表|无序|项目符号|项目符号列表|圆点列表|圆点|列表|bullet)$/.test(s)) {
    return { 类: "块", 型: "bullet", 名: "无序列表" };
  }
  if (/^(?:有序列表|有序|编号列表|数字列表|numbered)$/.test(s)) {
    return { 类: "块", 型: "numbered", 名: "有序列表" };
  }
  if (/^(?:待办|待办事项|待办列表|任务列表|任务项|任务|勾选框|复选框|todo)$/.test(s)) {
    return { 类: "块", 型: "todo", 名: "待办" };
  }
  if (/^(?:引用块|引用格式|引用|blockquote|quote)$/.test(s)) {
    return { 类: "引用" };
  }

  // 3) 颜色。先认带角色词的那种，再认光秃秃一个颜色词
  const 文色 = new RegExp(`^(?:文字色|文字颜色|字体颜色|字体色|字色|颜色|字)${连接}(红|橙|黄|橘|绿|蓝|紫|灰)色?$`).exec(s);
  if (文色) {
    const 色 = 找色(文色[1]!);
    if (色) return { 类: "颜色", 标: "textColor", 色: 色.hex, 名: 色.名 };
  }
  const 底色 = new RegExp(`^(?:底色|背景色|背景)${连接}(红|橙|黄|橘|绿|蓝|紫|灰)色?$`).exec(s);
  if (底色) {
    const 色 = 找色(底色[1]!);
    if (色) return { 类: "颜色", 标: "bgColor", 色: 底色of(色.hex), 名: 色.名 };
  }
  const 裸色 = 找色(s);
  if (裸色) return { 类: "颜色", 标: "textColor", 色: 裸色.hex, 名: 裸色.名 };

  // 4) 去掉某一种样式
  const 去 = /^(?:取消|去掉|去除|删除|移除|不要|清除|拿掉|关掉)(.+)$/.exec(s);
  if (去) {
    const 尾 = 去[1]!;
    for (const [re, 标, 名] of 标记词) {
      if (re.test(尾)) return { 类: "标记", 标, 开: false, 名 };
    }
    if (/^(?:文字色|文字颜色|字体颜色|字体色|字色|颜色)$/.test(尾)) {
      return { 类: "颜色", 标: "textColor", 色: null, 名: "文字色" };
    }
    if (/^(?:底色|背景色|背景)$/.test(尾)) {
      return { 类: "颜色", 标: "bgColor", 色: null, 名: "底色" };
    }
  }

  // 5) 加某一种样式
  for (const [re, 标, 名] of 标记词) {
    if (re.test(s)) return { 类: "标记", 标, 开: true, 名 };
  }

  return null;
}

const 块名表: Record<string, string> = {
  mdOpaque: "代码 / 引用这类源码块",
  mdTable: "表格",
  mdImage: "图片",
  mdQuote: "引用",
  mdQuoteHead: "Callout 标题",
};

const 块名 = (类: string): string => 块名表[类] ?? "这一块";

const 清掉 = [
  "bold",
  "italic",
  "strike",
  "code",
  "sup",
  "sub",
  "highlight",
  "textColor",
  "bgColor",
] as const;

/** 应用一条命令。纯函数式的：只返回事务，不发出去——落笔由调用方决定 */
export function 应用样式命令(state: EditorState, 锚: 锚, 命: 样式命令): 应用果 {
  const 字 = [...锚.text].length;
  const $ = state.doc.resolve(锚.from);

  if (命.类 === "标记") {
    const 型 = state.schema.marks[命.标];
    if (!型) return { tr: null, 说明: `这个编辑器里没有「${命.名}」` };
    // 代码 / 引用在模型里是 `mdOpaque`（`marks: ""`）：`addMark` 在它里面什么也不做，
    // 原来那句"已经是加粗了"于是成了假话——用户看到的是代码，不是已经加粗的代码。
    if (!$.parent.type.allowsMarkType(型)) {
      return { tr: null, 说明: "代码 / 引用这类源码块里不能加行内样式——直接在源文本里写 Markdown" };
    }
    const tr = state.tr;
    if (命.开) tr.addMark(锚.from, 锚.to, 型.create());
    else tr.removeMark(锚.from, 锚.to, 型);
    if (!tr.docChanged) {
      return {
        tr: null,
        说明: 命.开 ? `这段已经是${命.名}了，没有改动` : `这段本来就没有${命.名}，没有改动`,
      };
    }
    return { tr, 说明: 命.开 ? `已给选中的 ${字} 字加${命.名}` : `已去掉选中的 ${字} 字的${命.名}` };
  }

  if (命.类 === "颜色") {
    const 型 = state.schema.marks[命.标];
    if (!型) return { tr: null, 说明: `这个编辑器里没有「${命.名}」` };
    if (!$.parent.type.allowsMarkType(型)) {
      return { tr: null, 说明: "代码 / 引用这类源码块里不能加行内样式——直接在源文本里写 Markdown" };
    }
    const tr = state.tr;
    if (命.色) tr.addMark(锚.from, 锚.to, 型.create({ color: 命.色 }));
    else tr.removeMark(锚.from, 锚.to, 型);
    if (!tr.docChanged) {
      return {
        tr: null,
        说明: 命.色 ? `这段已经是这个${命.名}了，没有改动` : `这段本来就没有${命.名}，没有改动`,
      };
    }
    return {
      tr,
      说明: 命.色
        ? `已把选中的 ${字} 字${命.标 === "bgColor" ? "加上" : "改成"}${命.名}${命.标 === "bgColor" ? "底色" : ""}`
        : `已去掉选中的 ${字} 字的${命.名}`,
    };
  }

  if (命.类 === "清除") {
    const tr = state.tr;
    for (const n of 清掉) {
      const 型 = state.schema.marks[n];
      if (型) tr.removeMark(锚.from, 锚.to, 型);
    }
    // 与工具栏的「清除格式」同一条口径：行内样式去掉，块回正文；链接保留
    if ($.depth >= 1) {
      // 引用里动的是光标所在的子块，不是整段引用（整段引用换类型会抛 RangeError）
      const 位 = 块转换位置($);
      const 块 = state.doc.nodeAt(位);
      const 补 = 块 ? blockTypePatch(块, "paragraph") : null;
      if (块 && 补) {
        tr.setNodeMarkup(位, state.schema.nodes[补.typeName], {
          ...块.attrs,
          ...补.attrs,
        });
      }
    }
    if (!tr.docChanged) return { tr: null, 说明: "这里没有可清除的格式，没有改动" };
    return { tr, 说明: `已清除选中的 ${字} 字的格式（链接保留）` };
  }

  if (命.类 === "块") {
    if ($.depth < 1) return { tr: null, 说明: "光标不在正文块里，改不了块类型" };
    const 位 = 块转换位置($);
    const 块 = state.doc.nodeAt(位) ?? $.node(1);
    const tr = applyBlockType(state, 位, 命.型);
    if (!tr) {
      const 不能 =
        块.type.name !== "mdParagraph" &&
        块.type.name !== "mdHeading" &&
        块.type.name !== "mdItem";
      return {
        tr: null,
        说明: 不能
          ? `${块名(块.type.name)}不能原地换成${命.名}——先把它改成普通正文`
          : `这一块已经是${命.名}了，没有改动`,
      };
    }
    // 块类型换的是**整块**（选中的是块里的哪几个字都一样），这句话要在界面里说白
    return { tr, 说明: `已把这一块改成${命.名}` };
  }

  return 转引用(state, $, 字);
}

/**
 * 段落 / 标题 / 列表项 → 引用。
 *
 * 新建时先落成 `mdOpaque`（正文就是自己的源文本，带账本），下一次载入由
 * `引用接管` 翻成结构化引用。块锚点写在行内末尾（`> … ^b-id`），所以不能走
 * `replaceBlockWithSource`：那条路会给新块一份空账本，再补一个落脚点段落——
 * 转一次引用就把块 ID 和原来那一行的排版都换掉了。
 * 这里直接建节点，沿用它自己的 `mdRaw` / `mdGap`（换内容不改排版），只把 `mdSig` 清空
 * 让保存时按新正文重新产出。
 */
function 转引用(state: EditorState, $: ResolvedPos, 字: number): 应用果 {
  if ($.depth < 1) return { tr: null, 说明: "光标不在正文块里，变不成引用" };
  // 引用里不能再套一层：内核的 `take_quote` 把嵌套引用当不可表示的形状，
  // 写出去也只能退回源文本面，不如直接说清楚
  if ($.node(1).type.name === "mdQuote") {
    return { tr: null, 说明: "引用里不能再套一层引用" };
  }
  const 块 = $.node(1);
  if (块.type.name !== "mdParagraph" && 块.type.name !== "mdHeading" && 块.type.name !== "mdItem") {
    return { tr: null, 说明: `${块名(块.type.name)}不能变成引用` };
  }
  if (Number(块.attrs.mdDepth ?? 0) > 0) {
    return { tr: null, 说明: "这是一个嵌套列表项，变成引用会丢掉层级——先把缩进去掉" };
  }
  const 字段 = Array.isArray(块.attrs.mdFields) ? (块.attrs.mdFields as unknown[]) : [];
  if (字段.length) {
    return { tr: null, 说明: "这一段末尾挂着行内字段，变成引用会把它们吞进引用正文——先删掉字段" };
  }
  const 文 = serializeInline(块);
  if (!文.trim()) return { tr: null, 说明: "这一段是空的，没有可变成引用的内容" };
  const opaque = state.schema.nodes.mdOpaque;
  if (!opaque) return { tr: null, 说明: "这个编辑器里没有引用块" };
  const id = typeof 块.attrs.mdId === "string" ? 块.attrs.mdId : "";
  const 源 = `> ${文}${id ? ` ^${id}` : ""}`;
  const 账 = 引用账本(源, "quote", id || null);
  const 起 = $.before(1);
  const 新 = opaque.create(
    {
      ...块.attrs,
      mdKind: "quote",
      mdLevel: null,
      mdChecked: null,
      mdSig: "",
      ...(账 ? { mdQuoteMarks: 账.缀.join("\n"), mdQuoteAnchor: 账.锚 } : {}),
    },
    state.schema.text(账 && 账.身 ? 账.身 : 源),
  );
  const tr = state.tr.replaceWith(起, 起 + 块.nodeSize, 新);
  // 选中整块：引用立刻以渲染后的样子出现（光标放进块里会把那一面翻回源文本）
  tr.setSelection(NodeSelection.create(tr.doc, 起));
  return { tr, 说明: `已把这一块（${字} 字里的整段）变成引用` };
}
