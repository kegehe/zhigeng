import { Fragment, type Mark } from "@tiptap/pm/model";
import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import type { JSONContent } from "@tiptap/core";

import { 以块级记号开头 } from "./blocks";
import { inlineToJson, 序列化行内 } from "./inline";

/**
 * 改写的判据。**与界面分成两半**：这里全是纯函数，底部对话框、落笔那一下
 * 共用同一份判断——两处各判一次，早晚有一处放进来一个"跨块的选区"。
 *
 * 这一档只改**一段里的文字**：
 * - 跨块替换要重新解析 Markdown 并重排块边界，那是另一档的事；
 * - 整块选中（原子块 / 表格）没有"一段连续文字"的含义；
 * - 选区里带硬换行时，回稿会被塞进同一个段落，字节形状与用户看的不是一回事。
 * 这三种都明说原因，不把按钮灰掉让人猜。
 */

/** 与 `note_core::rewrite::选段上限` 同数：那边是最后一道闸，这边先拦一次。 */
export const 选段上限 = 8000;

/** 选中范围。`text` 是**逐字节用于失鲜判定**的那一份，不 trim。 */
export type 锚 = { from: number; to: number; text: string };
export type 取段 = { ok: true; 锚: 锚 } | { ok: false; why: string };

/** 解释给人看的原因。都写"下一步做什么"，不只说"不行"。 */
export function 取选段(state: EditorState): 取段 {
  const { selection } = state;
  if (selection.empty) return { ok: false, why: "先选中一段文字" };
  if (selection instanceof NodeSelection) {
    return { ok: false, why: "不能整块选中，请选中具体的文字" };
  }
  const { $from, $to } = selection;
  if (!$from.sameParent($to)) {
    return { ok: false, why: "一次只能改同一段里的文字，请把选区收在一段内" };
  }
  if (!$from.parent.isTextblock) {
    return { ok: false, why: "这里不是普通文字，不能改写" };
  }
  // 叶子节点（硬换行）在 textBetween 里默认是一个 "\n"
  const text = state.doc.textBetween(selection.from, selection.to, "\n");
  if (/[\r\n]/.test(text)) {
    return { ok: false, why: "只能改一段连续的文字，不能带换行" };
  }
  if (!text.trim()) return { ok: false, why: "选中的是空白，没有可改的文字" };
  const 字 = [...text].length;
  if (字 > 选段上限) {
    return {
      ok: false,
      why: `选中的文字太长（${字} 字，单次最多 ${选段上限} 字），请分几次改`,
    };
  }
  return { ok: true, 锚: { from: selection.from, to: selection.to, text } };
}

/**
 * 对话框里那块"选中的文本"预览。**只看选区，不看光标**：没有选区返回 null，
 * 界面据此把这一次的要求当成"对整篇说的"。
 *
 * 能不能改仍由 `取选段` 判：预览照实显示用户圈住的字，同时把原因带上——
 * 跨块、整块、含换行这些情况在按下发送前就能看见，不用等失败一次才知道。
 */
export type 选区概况 = {
  /** 用户圈住的原文（按行拼，含换行）。界面显示时自己截断，判定仍用 `取选段` */
  text: string;
  字数: number;
  能用: boolean;
  why: string | null;
};

export function 看选区(state: EditorState): 选区概况 | null {
  if (state.selection.empty) return null;
  const { from, to } = state.selection;
  const text = state.doc.textBetween(from, to, "\n");
  const 判 = 取选段(state);
  return {
    text,
    字数: [...text].length,
    能用: 判.ok,
    why: 判.ok ? null : 判.why,
  };
}

/**
 * 等待回稿期间文档被改过时，锚点跟着事务走：**同步在选区前头插的字不该算失鲜**。
 * `from` 用 assoc=1（插在起点上的字落在选区外），`to` 用 assoc=-1（插在终点上的同理）。
 */
export function 随事务(锚: 锚, tr: Transaction): 锚 {
  if (!tr.docChanged) return 锚;
  return {
    ...锚,
    from: tr.mapping.map(锚.from, 1),
    to: tr.mapping.map(锚.to, -1),
  };
}

/** 这一锚还算不算数：位置合法，且那段字节还是原来那段。 */
export function 能替换(state: EditorState, 锚: 锚): boolean {
  if (锚.from < 0 || 锚.from >= 锚.to) return false;
  if (锚.to > state.doc.content.size) return false;
  return state.doc.textBetween(锚.from, 锚.to, "\n") === 锚.text;
}

/**
 * 发给模型的那一份原文：**行内样式按 Markdown 语法带着走**（2026-11-02）。
 *
 * 从前发的是 `textBetween`，加粗 / 斜体 / 颜色在模型眼里全都不存在，回稿回来也只剩
 * 纯文字——"只把这句话改得正式一点"会把用户精心标的重点一起洗掉。现在发的是选区切片
 * 的序列化结果，与文件里那一行的写法是同一套词汇，模型照着改、照着回，样式才留得住。
 */
export function 选区源(state: EditorState, 锚: 锚): string {
  return 序列化行内(state.doc.slice(锚.from, 锚.to).content);
}

/** 替换的结果：事务 + **落进文档之后的纯文字**（失鲜判定与新锚点都要用它）。 */
export type 替换果 = { tr: Transaction; 文: string };

/**
 * 回稿落在**行首**（块首，或块内一根硬换行之后）且以块级记号开头时，落盘会被读成
 * 另一种块——段落变标题 / 列表 / 引用，列表项里长出子列表或引用。块 id 还在，块类型已经换了。
 * 标题自己有 `## ` 前缀挡着，代码 / 引用那类源文本块里 `#` 就是正文，都不拦。
 *
 * 单独成函数是为了让界面能说出原因：`替换选区` 拒收时只返回 null，会被当成"锚点失鲜"。
 */
export function 段首记号问题(state: EditorState, 锚: 锚, 新文: string): string | null {
  if (锚.from < 0 || 锚.from > state.doc.content.size) return null;
  if (!以块级记号开头(新文)) return null;
  const $from = state.doc.resolve(锚.from);
  const 名 = $from.parent.type.name;
  if (名 !== "mdParagraph" && 名 !== "mdItem") return null;
  const 行前 = state.doc.textBetween($from.start(), 锚.from, "\n");
  if (!/^[ \t]*$/.test(行前.slice(行前.lastIndexOf("\n") + 1))) return null;
  return "这段回稿以块级记号开头（#、-、>、1.、``` 等），落在段首会被读成另一种块，这次没有替换；请让模型换个说法，或改用整篇编辑";
}

/**
 * 选区切片里**每一段字都带着**的标记。回稿没提到的样式按这份继承：
 * 用户把整句上了红，让 AI 改措辞，不该连颜色一起洗掉；而只在半句上的加粗不是
 * "这段的样式"，不继承——继承它等于把样式扩到回稿的每个字上。
 */
function 共有标记(片: Fragment): Mark[] {
  let 共: Mark[] | null = null;
  片.forEach((n) => {
    if (!n.isText) return;
    const 这 = [...n.marks];
    const 旧 = 共;
    共 = 旧 === null ? 这 : 旧.filter((m) => 这.some((x) => x.eq(m)));
  });
  return 共 ?? [];
}

/** 回稿自带的标记优先；没提到的、而整段原本就有的，补上去 */
function 合标记(json: JSONContent[], 继承: Mark[]): JSONContent[] {
  if (!继承.length) return json;
  return json.map((n) => {
    const 已有 = new Set((n.marks ?? []).map((m) => m.type));
    const 补 = 继承.filter((m) => !已有.has(m.type.name)).map((m) => m.toJSON());
    return 补.length ? { ...n, marks: [...(n.marks ?? []), ...补] } : n;
  });
}

/** 纯文字落笔：父节点不收这些标记时（代码块的正文一个字都带不了 mark）的退路 */
function 落纯文本(state: EditorState, 锚: 锚, 新文: string, 选中新文: boolean): 替换果 {
  const tr = state.tr.insertText(新文, 锚.from, 锚.to);
  const 末 = 锚.from + 新文.length;
  tr.setSelection(
    选中新文 ? TextSelection.create(tr.doc, 锚.from, 末) : TextSelection.near(tr.doc.resolve(末)),
  );
  return { tr, 文: 新文 };
}

/**
 * 替换成回稿。**一笔事务**：撤销栈里是"一次改写"，不是逐字重放。
 * 不满足判据时返回 null，调用方必须把原因说出来——静默不换等于按钮没反应。
 *
 * 回稿按**行内 Markdown** 解析（`**粗**` / `==高亮==` / 颜色 span / 链接），
 * 与 `inline.ts` 是同一份词汇：预览里看到的样式就是落进正文的样式。
 */
export function 替换选区(
  state: EditorState,
  锚: 锚,
  新文: string,
  /** 把新文整段选中。底部对话框要继续对话时用它——不选中下一句就落到"哪一段"上了 */
  选中新文 = false,
): 替换果 | null {
  if (!能替换(state, 锚)) return null;
  if (!新文.trim() || /[\r\n]/.test(新文)) return null;
  if (段首记号问题(state, 锚, 新文)) return null;

  const json = 合标记(inlineToJson(新文), 共有标记(state.doc.slice(锚.from, 锚.to).content));
  const 父 = state.doc.resolve(锚.from).parent;
  const 标们 = json.flatMap((n) => (n.marks ?? []).map((m) => state.schema.markFromJSON(m)));
  // 父节点收不了这些标记（代码块 / 公式那类 `marks: ""` 的块）：按纯文本落，
  // 至少不把用户字吃掉。返回的 `文` 仍是模型写的原样，锚点才对得上。
  if (标们.length && !父.type.allowsMarks(标们)) {
    return 落纯文本(state, 锚, 新文, 选中新文);
  }
  const 片 = Fragment.fromJSON(state.schema, json);
  const 文 = json.map((n) => String(n.text ?? "")).join("");
  if (!片.size || !文.trim()) return null;
  const tr = state.tr.replaceWith(锚.from, 锚.to, 片);
  const 末 = 锚.from + 文.length;
  tr.setSelection(
    选中新文 ? TextSelection.create(tr.doc, 锚.from, 末) : TextSelection.near(tr.doc.resolve(末)),
  );
  return { tr, 文 };
}

/**
 * 删掉锚点覆盖的文字。**删除不是"替换成空串"**：`替换选区` 拒收空串，这条单独走一笔
 * 事务，界面上必须先拿到用户的确认。失鲜判据与替换共用同一份，锚点被改过就不删。
 * 只删文字、不删段落节点——与手动选中后按 Delete 留下一个空段的行为一致。
 */
export function 删除选区(state: EditorState, 锚: 锚): Transaction | null {
  if (!能替换(state, 锚)) return null;
  const tr = state.tr.delete(锚.from, 锚.to);
  // 光标落回删除起点：删完通常还要接着写，也不留下一个指向旧位置的选区
  tr.setSelection(TextSelection.near(tr.doc.resolve(锚.from)));
  return tr;
}

/**
 * 清空整篇正文：把编辑器里的所有块换成**一个空段落**。front-matter 不在编辑器里，
 * 由保存层原样保留；这不是"整篇改写"，块边界不会被模型重新生成。
 *
 * `快照` 是发起那一刻的文档：整篇删除比单段更不能猜——确认期间用户改过一个字，
 * 这一笔就作废，让他重新发起，而不是把新写的东西一起清掉。
 */
export function 清空正文(
  state: EditorState,
  /** 发起那一刻的文档。不传只给"新建空文档"这类无快照场景用 */
  快照?: EditorState["doc"],
): Transaction | null {
  if (快照 && !state.doc.eq(快照)) return null;
  // 这篇的 schema 不引 StarterKit：段落的节点名是 mdParagraph（见 schema.ts）
  const 段落 = state.schema.nodes.mdParagraph;
  if (!段落) return null;
  const 空段 = 段落.create();
  const tr = state.tr.replaceWith(0, state.doc.content.size, 空段);
  tr.setSelection(TextSelection.near(tr.doc.resolve(0)));
  return tr;
}
