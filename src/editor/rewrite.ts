import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";

/**
 * 选区改写的判据。**与界面分成两半**：这里全是纯函数，气泡按钮、浮层、替换那一下
 * 共用同一份判断——三处各判一次，早晚有一处放进来一个"跨块的选区"。
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
    return { ok: false, why: "整块选中改不了——先选中块里的文字" };
  }
  const { $from, $to } = selection;
  if (!$from.sameParent($to)) {
    return { ok: false, why: "一次只能改一段里的文字（选区跨了块）" };
  }
  if (!$from.parent.isTextblock) {
    return { ok: false, why: "这一块不是普通文字，选区改写改不了" };
  }
  // 叶子节点（硬换行）在 textBetween 里默认是一个 "\n"
  const text = state.doc.textBetween(selection.from, selection.to, "\n");
  if (/[\r\n]/.test(text)) {
    return { ok: false, why: "选区里有换行——先选一段连续的文字" };
  }
  if (!text.trim()) return { ok: false, why: "选中的都是空白" };
  const 字 = [...text].length;
  if (字 > 选段上限) {
    return {
      ok: false,
      why: `选中的文字太长（${字} 字，上限 ${选段上限} 字）——先分几次改`,
    };
  }
  return { ok: true, 锚: { from: selection.from, to: selection.to, text } };
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
): Transaction | null {
  if (!能替换(state, 锚)) return null;
  if (!新文.trim() || /[\r\n]/.test(新文)) return null;
  const tr = state.tr.insertText(新文, 锚.from, 锚.to);
  // 光标落到新文字的末尾：改完通常还要接着写
  tr.setSelection(TextSelection.near(tr.doc.resolve(锚.from + 新文.length)));
  return tr;
}

/**
 * 浮层里那四个预设。`id` 是审计里的稳定标签（改文案不改账），`指令` 是真正发给模型的
 * 那一句。四条都要求"只回这一段"，与系统提示同一条纪律。
 */
export type 预设项 = { id: string; 标签: string; 指令: string };

export const 预设: [预设项, ...预设项[]] = [
  {
    id: "polish",
    标签: "润色",
    指令: "润色这段文字：保持原意与信息量，让表达更通顺、更有条理。只回改写后的这一段。",
  },
  {
    id: "shorten",
    标签: "精简",
    指令: "精简这段文字：保留原意与关键事实，删掉重复和赘余，压得更短。只回改写后的这一段。",
  },
  {
    id: "expand",
    标签: "扩写",
    指令:
      "扩写这段文字：补充必要的细节与过渡，但仍保持为一整段连续文字，不要分点、不要换行。只回改写后的这一段。",
  },
  {
    id: "casual",
    标签: "口语",
    指令:
      "把这段文字改得更口语、更自然，像在跟人说话；不要堆语气词。只回改写后的这一段。",
  },
];
