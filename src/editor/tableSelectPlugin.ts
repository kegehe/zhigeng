import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { 含, 多格, type 格, type 矩形 } from "./tableSelect";

/**
 * 表格矩形选区的**状态与装饰**。
 *
 * 三条实现口径，都是被这个仓库的既有纪律逼出来的：
 *
 * 1. **不新建 `Selection` 子类，也不动 `isolating`**。`isolating` 是块级无损回写的地基
 *    （选区与拖拽不许跨出块边界），关掉它等于拿整篇的字节换一个选区。而工具栏、
 *    `cellAt()`、`回到格()` 全在读 `selection.$from`——换一个 Selection 形状会把它们逐个打断。
 *    所以光标始终老老实实待在锚点格里，矩形是**旁边一份独立状态**。
 * 2. **矩形放插件 state，不放 React state**：装饰要按它算，而装饰只能从 PM 插件里发。
 *    放 React 就会出现"屏幕上有框、命令读不到"的两份真相。
 * 3. **只发 meta 事务，永不改文档**。`BlockEditor` 的脏标记挂在 `onUpdate`（只在
 *    `docChanged` 时触发）上，选区一旦发事务就会把"只是拖了一下鼠标"变成"待保存"，
 *    800ms 后白写一次盘——`FocusIndicator` / `OpaqueFace` 同条纪律。
 */

/**
 * 选区：锚点格 + 可能存在的矩形。
 *
 * **单格时 `矩` 是 null**，只留锚点。否则光标停在哪个格子，那个格子就凭空多一圈框——
 * 用户看到的是"这格被选中了"，而它只是有光标。锚点仍要记，因为 Shift 点选与拖拽
 * 都是从它开始扩的。
 */
export type 选区 = { 表: number; 锚: 格; 矩: 矩形 | null };

const key = new PluginKey<选区 | null>("mdTableSelect");

/** 当前选区（含锚点）。工具栏与键位都从这里读 */
export function 选区of(state: EditorState): 选区 | null {
  return key.getState(state) ?? null;
}

/** 矩形（纯几何，给批量命令用）。没框或多格判不过就是 null */
export function 矩形of(state: EditorState): 矩形 | null {
  const 选 = 选区of(state);
  return 选 && 多格(选.矩) ? 选.矩 : null;
}

/**
 * 改选区的那笔事务。`表` 是这张表的文档起点——装饰与"离开这张表就清掉"都靠它。
 * 给 `矩` 就同时把锚点定在矩形左上角（拖拽与 Shift 点选都传归一后的矩形）。
 */
export function 改选区(state: EditorState, 表: number, 矩: 矩形 | null): Transaction {
  const tr = state.tr;
  tr.setMeta(
    key,
    矩 ? { 表, 锚: { 行: 矩.r0, 列: 矩.c0 }, 矩 } : null
  );
  // 选区不该进撤销栈：按 Ctrl+Z 撤回的是内容，不是"我刚才框了哪几格"
  tr.setMeta("addToHistory", false);
  return tr;
}

/** 只定锚点（点进一个格子）：清掉矩形，下次 Shift 点选从这个格子开始扩 */
export function 定锚点(state: EditorState, 表: number, 锚: 格): Transaction {
  const tr = state.tr;
  tr.setMeta(key, { 表, 锚, 矩: null });
  tr.setMeta("addToHistory", false);
  return tr;
}

/**
 * 有矩形选区时按 `(state, 表起点, 矩形)` 做批量动作，否则给 null。
 * 键位与工具栏共用这一道判据——两处各判一次"到底算不算多格"，早晚一处把单格当成批量清掉。
 */
export function 批量(
  state: EditorState,
  做: (s: EditorState, 表: number, 矩: 矩形) => Transaction | null
): Transaction | null {
  const 选 = 选区of(state);
  const 矩 = 选 && 多格(选.矩) ? 选.矩 : null;
  return 选 && 矩 ? 做(state, 选.表, 矩) : null;
}

/** 光标现在在哪张表里（不在表里给 null） */
function 当前表(state: EditorState): number | null {
  const { $from } = state.selection;
  if ($from.depth < 3 || $from.node(3).type.name !== "mdTableCell") return null;
  const 起点 = $from.before(1);
  return state.doc.nodeAt(起点)?.type.name === "mdTable" ? 起点 : null;
}

export const TableSelect = Extension.create({
  name: "tableSelect",
  addProseMirrorPlugins() {
    return [
      new Plugin<选区 | null>({
        key,
        state: {
          init: () => null,
          apply(tr, 旧, _前, 后) {
            const 新 = tr.getMeta(key);
            if (新 !== undefined) return 新;
            // 文档一动，坐标就不作数了（批量动作自己也是这么把选区交掉的）
            if (tr.docChanged) return null;
            if (!旧) return 旧;
            // 光标跳到别的表 / 跳出表格，选区就结束——留着框会让人以为还在选
            return 当前表(后) === 旧.表 ? 旧 : null;
          },
        },
        props: {
          decorations(state) {
            const 选 = key.getState(state);
            const 矩 = 选 && 多格(选.矩) ? 选.矩 : null;
            if (!选 || !矩) return null;
            const 表 = state.doc.nodeAt(选.表);
            if (!表 || 表.type.name !== "mdTable") return null;
            const 出: Decoration[] = [];
            表.forEach((行, 行偏, 行号) => {
              if (行号 < 矩.r0 || 行号 > 矩.r1) return;
              const 行起点 = 选.表 + 1 + 行偏;
              行.forEach((格点, 格偏, 格号) => {
                if (!含(矩, { 行: 行号, 列: 格号 })) return;
                const 起 = 行起点 + 1 + 格偏;
                出.push(Decoration.node(起, 起 + 格点.nodeSize, { "data-md-sel": "" }));
              });
            });
            return DecorationSet.create(state.doc, 出);
          },
        },
      }),
    ];
  },
});
