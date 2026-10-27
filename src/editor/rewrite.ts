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
 * 两个入口（选区气泡、常驻工具栏）共用的第一道闸：先问模型配没配，再问这段文字改不改得。
 * 判据只写这一份——两处各判一次，早晚一处放进来一个跨块选区。
 */
export type 起手 = { ok: true; 锚: 锚 } | { ok: false; why: string };

export function 准备改写(aiReady: boolean, state: EditorState): 起手 {
  if (!aiReady) {
    return { ok: false, why: "还没配模型：先打开设置，在「模型与 Key」里填好接口地址和对话模型" };
  }
  return 取选段(state);
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
 * 改写浮层的落点（全部相对 `.editor-wrap` 的坐标）。
 *
 * 三条判据，按顺序：**先看下方够不够，再翻到气泡上方，两边都不够就取空间大的那一侧并把
 * 高度夹进去**。这样不管窗口多矮，浮层的输入框与底部动作行都在屏幕里——超出的部分在
 * 浮层内部滚（底那一行是 sticky 的，见 `base.css` 的 `.rewrite-actions`）。
 *
 * **不测浮层的高度**：回稿一到它会从 ~320px 长到 ~520px，按打开时的高度做决定会失效。
 * 这里只用锚点与视口四个边，算出来的 `maxHeight` 把"长高"关在这一侧的空间里。
 *
 * 宽度与 `base.css` 里 `.rewrite` 的 384px 同数，左右各留 8px。
 */
export const 浮层宽 = 384;
/** 自然高度：头部 + 预设 + 输入 + 原文 + 回稿 + 动作行 + 脚注。只用来判断"这一侧够不够" */
export const 浮层自然高 = 520;
/** 气泡的占位：气泡顶在选区顶上方这么多，翻到上方时要让开它。
    这个数同时也是 `BlockEditor` 里气泡自身的偏移——只有一份。 */
export const 气泡高 = 34;
const 浮层边距 = 8;
/** 兜底最小高：两边都窄到连它都放不下时，宁可让浮层伸到视口下面（正向溢出能滚过去），
    也不翻上去——翻上去的溢出是负向的，浏览器不给滚。 */
const 浮层最小高 = 160;

export type 浮层放 = {
  left: number;
  /** 挂在选区下沿时的上沿；与 `bottom` 二选一 */
  top?: number;
  /** 翻到气泡上方时的下沿；与 `top` 二选一 */
  bottom?: number;
  /** 这一侧最多给多高——超出就在浮层内部滚 */
  maxHeight: number;
};

export function 浮层位置(
  锚: { left: number; top: number; bottom: number },
  宿主: { 宽: number; 高: number; 视口上: number; 视口下: number },
): 浮层放 {
  const left = Math.max(
    浮层边距,
    // 先按选区中心对齐，再夹进宿主：窄宿主（宿主宽 < 浮层宽 + 两侧边距）里直接贴左边
    Math.min(锚.left - 浮层宽 / 2, 宿主.宽 - 浮层宽 - 浮层边距),
  );
  const 下沿 = 锚.bottom + 浮层边距;
  const 下方空间 = Math.max(0, 宿主.视口下 - 浮层边距 - 下沿);
  const 上沿 = 锚.top - 气泡高 - 浮层边距;
  const 上方空间 = Math.max(0, 上沿 - 浮层边距 - 宿主.视口上);

  if (下方空间 >= 浮层自然高) return { left, top: 下沿, maxHeight: 浮层自然高 };
  if (上方空间 >= 浮层自然高) return { left, bottom: 宿主.高 - 上沿, maxHeight: 浮层自然高 };
  // 两边都不够（矮窗 / 选区长过一屏）：取空间大的那一侧，把高度夹到那一侧里
  if (Math.max(下方空间, 上方空间) >= 浮层最小高) {
    return 下方空间 >= 上方空间
      ? { left, top: 下沿, maxHeight: 下方空间 }
      : { left, bottom: 宿主.高 - 上沿, maxHeight: 上方空间 };
  }
  // 连最小高都放不下：留一个能用的面板，让它往视口下面伸（文档能滚过去）
  return { left, top: 下沿, maxHeight: 浮层最小高 };
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
