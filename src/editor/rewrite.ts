import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";

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
 * 光标所在的那一段。底部对话框**没有选区时按这一段处理**——空选区只回一句
 * "先选中一段"的话，对话框在不选字时就是个摆设。
 *
 * 判据与 `取选段` 共用同一组数：非文本块 / 空段 / 带换行 / 超上限都说原因。
 */
export function 取整段(state: EditorState): 取段 {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) {
    return { ok: false, why: "光标不在正文段落里：先点一下要改的那一段" };
  }
  const from = $from.start();
  const to = $from.end();
  const text = state.doc.textBetween(from, to, "\n");
  if (!text.trim()) return { ok: false, why: "这一段是空的：先写点字，或选中一段再改" };
  if (/[\r\n]/.test(text)) {
    return { ok: false, why: "这一段里有换行，一次只能改一段连续文字" };
  }
  const 字 = [...text].length;
  if (字 > 选段上限) {
    return {
      ok: false,
      why: `这一段太长（${字} 字，单次最多 ${选段上限} 字），先选中要改的那几句`,
    };
  }
  return { ok: true, 锚: { from, to, text } };
}

/** 这次要改哪里：有选区就是选区，没有就是光标所在的那一段 */
export type 目标 = { ok: true; 锚: 锚; 范围: "选区" | "本段" } | { ok: false; why: string };

export function 取目标(state: EditorState): 目标 {
  if (!state.selection.empty) {
    const r = 取选段(state);
    return r.ok ? { ok: true, 锚: r.锚, 范围: "选区" } : r;
  }
  const r = 取整段(state);
  return r.ok ? { ok: true, 锚: r.锚, 范围: "本段" } : r;
}

/**
 * 底部对话框的第一道闸：先问模型配没配，再问要改的地方成不成立。
 * 判据只写这一份——界面上再多一个入口，也不许各判一套。
 */
export function 准备目标(aiReady: boolean, state: EditorState): 目标 {
  if (!aiReady) {
    return { ok: false, why: "还没配模型：先打开设置，在「模型与 Key」里填好接口地址和对话模型" };
  }
  return 取目标(state);
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
 * 替换成回稿。**一笔事务**：撤销栈里是"一次改写"，不是逐字重放。
 * 不满足判据时返回 null，调用方必须把原因说出来——静默不换等于按钮没反应。
 */
export function 替换选区(
  state: EditorState,
  锚: 锚,
  新文: string,
  /** 把新文整段选中。底部对话框要继续对话时用它——不选中下一句就落到"哪一段"上了 */
  选中新文 = false,
): Transaction | null {
  if (!能替换(state, 锚)) return null;
  if (!新文.trim() || /[\r\n]/.test(新文)) return null;
  const tr = state.tr.insertText(新文, 锚.from, 锚.to);
  const 末 = 锚.from + 新文.length;
  tr.setSelection(
    选中新文
      ? TextSelection.create(tr.doc, 锚.from, 末)
      : // 光标落到新文字的末尾：改完通常还要接着写
        TextSelection.near(tr.doc.resolve(末)),
  );
  return tr;
}
