import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { blockTypePatch, 块类型of, type BlockTypeId } from "./blocks";
import { 矩形of } from "./tableSelectPlugin";

/**
 * 格式刷：把源选区的格式抄到目标选区。
 *
 * **只刷可往返的那部分**——行内 marks（加粗 / 斜体 / 删除线 / 行内码 / 高亮 / 字色 / 底色）
 * 与块类型（正文 / 标题 1–6 / 无序 / 有序 / 待办）。字号、居中、缩进、表格对齐不在其列：
 * 它们要么没有 Markdown 语法，要么是结构属性，刷过去就是"点了会丢"（[02] D35 / D27）。
 * 代码 / 引用 / 表格 / 图片这类整块也不能转类型，遇到时只跳过并说一句，不静默吞掉。
 *
 * 三条实现口径：
 *
 * 1. **源取第一个有实际文字的字符**，不是"选区里所有格式的交集"：交集在混合格式上
 *    几乎总是空，用户选一段带加粗的正文就什么也刷不过去。块类型 likewise 只取第一个
 *    文字所在的顶层块——与 Word 的格式刷一致。
 * 2. **先摘后加**：目标身上所有可刷标记先摘掉，再按源加回去，结果才与源一致，而不是
 *    在目标原有的斜体上再叠一层加粗。链接不在这份名单里，目标自己的 href 必须留着。
 * 3. **行内与块类型合成一笔事务**，`Ctrl+Z` 一步回来；只在真正有改动时才发，
 *    目标本来就一样时 `tr.doc.eq(old)` 会把它拦掉，不白标一次脏。
 */

export const 可刷标记 = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "textColor",
  "bgColor",
] as const;

export type 可刷标记名 = (typeof 可刷标记)[number];

export type 标记快照 = {
  type: 可刷标记名;
  attrs: Record<string, unknown>;
};

export type 格式快照 = {
  marks: 标记快照[];
  /** 源文字所在顶层块的类型；源在表格格子里时是 null（表格不能转块类型） */
  block: BlockTypeId | null;
  source: { from: number; to: number };
};

export type 格式刷态 = { 快照: 格式快照; 锁定: boolean } | null;

const 格式刷键 = new PluginKey<格式刷态>("mdFormatPainter");

function 是可刷标记(名: string): 名 is 可刷标记名 {
  return (可刷标记 as readonly string[]).includes(名);
}

/** 当前是否处于格式刷待命 */
export function 格式刷状态of(state: EditorState): 格式刷态 {
  return 格式刷键.getState(state) ?? null;
}

/**
 * 源选区能不能开刷。
 *
 * 表格格子里选文字可以（行内格式照刷，块类型为 null）；代码 / 引用块不行——它们
 * `marks: ""`，没有可复制的行内格式，块类型也转不了。整块选中（NodeSelection）与
 * 表格矩形选区同样不在这一档里：前者没有"几个字"的格式，后者要的是整片格子。
 */
export function 能开格式刷(state: EditorState): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  if (矩形of(state)) return false;
  const $ = state.doc.resolve(selection.from);
  if ($.depth < 1) return false;
  const 块 = $.node(1);
  return 块.type.name !== "mdOpaque" && 块.type.name !== "mdImage";
}

/** 从当前选区取一份格式快照；取不到（源不可刷）时返回 null */
export function 取格式(state: EditorState): 格式快照 | null {
  if (!能开格式刷(state)) return null;
  const { from, to } = state.selection;
  // 用容器而不是两个 `let`：赋值发生在 nodesBetween 的回调里，TypeScript 的控制流
  // 分析看不到那笔赋值，回调之后再读会被判成恒 null
  const 取到: { 源?: PmNode; 块?: PmNode } = {};
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (取到.源) return false;
    if (!node.isText || !node.text || !node.text.trim()) return true;
    const $p = state.doc.resolve(pos);
    const 块 = $p.depth >= 1 ? $p.node(1) : null;
    // 选区分到了代码 / 引用块里的字：那里面没有可刷的格式，继续找下一段真正可刷的文字
    if (块 && (块.type.name === "mdOpaque" || 块.type.name === "mdImage")) return true;
    取到.源 = node;
    if (块) 取到.块 = 块;
    return false;
  });
  if (!取到.源 || !取到.块) return null;
  const marks: 标记快照[] = [];
  for (const mark of 取到.源.marks) {
    if (!是可刷标记(mark.type.name)) continue;
    marks.push({ type: mark.type.name, attrs: { ...mark.attrs } });
  }
  return { marks, block: 块类型of(取到.块), source: { from, to } };
}

export type 刷格式果 = {
  /** 没有真实改动就是 null：调用方不许发空事务 */
  tr: Transaction | null;
  /** 被跳过、整块没刷的目标块数（代码 / 引用 / 图片，以及转了块类型的表格） */
  跳过: number;
};

/**
 * 把快照刷到 `[from, to)`。
 *
 * `blockTypePatch` 返回 null 有两种：目标已经是这个类型（不是跳过），或者这块不能转
 * （代码 / 表格 / 图片，算跳过）。两种必须分开，否则界面会把"本来就不用改"报成"没刷上"。
 */
export function 刷格式(
  state: EditorState,
  快照: 格式快照,
  from: number,
  to: number,
): 刷格式果 {
  if (from >= to) return { tr: null, 跳过: 0 };
  const tr = state.tr;

  for (const 名 of 可刷标记) {
    const 型 = state.schema.marks[名];
    if (型) tr.removeMark(from, to, 型);
  }
  for (const mark of 快照.marks) {
    const 型 = state.schema.marks[mark.type];
    if (型) tr.addMark(from, to, 型.create(mark.attrs));
  }

  const 跳过 = new Set<number>();
  state.doc.forEach((node, offset) => {
    if (offset + node.nodeSize <= from || offset >= to) return;
    const 型 = node.type.name;
    // 整块不能带行内 mark：代码 / 引用（marks: ""）与图片（原子块）
    if (型 === "mdOpaque" || 型 === "mdImage") {
      跳过.add(offset);
      return;
    }
    if (!快照.block) return;
    // 表格的块类型不给转，但格子里的字仍能刷行内格式——只跳过"块"这一半
    if (型 === "mdTable") {
      跳过.add(offset);
      return;
    }
    const patch = blockTypePatch(node, 快照.block);
    if (!patch) return;
    const 新 = state.schema.nodes[patch.typeName];
    if (!新) {
      跳过.add(offset);
      return;
    }
    tr.setNodeMarkup(offset, 新, { ...node.attrs, ...patch.attrs });
  });

  // 先摘后加在"目标本来就是这个格式"时也会留下 step，但产出与旧文档全等；
  // 只在这一下做一次全等比较，不把它放进击键路径
  return { tr: tr.doc.eq(state.doc) ? null : tr, 跳过: 跳过.size };
}

function 关格式刷视图(view: EditorView): void {
  if (!格式刷状态of(view.state)) return;
  const tr = view.state.tr.setMeta(格式刷键, null).setMeta("addToHistory", false);
  view.dispatch(tr);
}

/** 用当前选区作源，进入格式刷待命。`锁定` = 双击那一档：刷完不收起 */
export function 开格式刷(editor: Editor, 锁定 = false): boolean {
  const 快照 = 取格式(editor.state);
  if (!快照) return false;
  const tr = editor.state.tr
    .setMeta(格式刷键, { 快照, 锁定 })
    .setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}

export function 关格式刷(editor: Editor): void {
  关格式刷视图(editor.view);
}

function 报(view: EditorView, 文本: string): void {
  view.dom.dispatchEvent(new CustomEvent("md-notice", { detail: 文本, bubbles: true }));
}

export type 应用格式刷果 = { 刷了: boolean; 跳过: number };

/**
 * 把待命中的格式刷应用到当前选区。
 *
 * **源选区自己（或它的子区间）不刷**：用户点了格式刷之后又点回源文字，不该发一笔
 * "先摘后加"的事务把笔记白标成未保存。空选区也不刷——那说明用户只是在挪光标。
 */
export function 应用格式刷视图(view: EditorView): 应用格式刷果 {
  if (view.isDestroyed) return { 刷了: false, 跳过: 0 };
  const 态 = 格式刷状态of(view.state);
  if (!态) return { 刷了: false, 跳过: 0 };
  const { from, to, empty } = view.state.selection;
  if (empty || from >= to) return { 刷了: false, 跳过: 0 };
  if (view.state.selection instanceof NodeSelection) return { 刷了: false, 跳过: 0 };
  if (矩形of(view.state)) return { 刷了: false, 跳过: 0 };
  const 源 = 态.快照.source;
  if (from >= 源.from && to <= 源.to) return { 刷了: false, 跳过: 0 };

  const 果 = 刷格式(view.state, 态.快照, from, to);
  if (!果.tr) {
    if (!态.锁定) 关格式刷视图(view);
    if (果.跳过) 报(view, "目标里只有代码 / 表格这类不能刷的块，什么都没动");
    return { 刷了: false, 跳过: 果.跳过 };
  }

  // 一笔事务：行内 marks 与块类型一起落，Ctrl+Z 一步回来。单次那一档顺手把待命清掉，
  // 锁定那一档把同一份快照留在插件 state 里（源范围会随事务映射，见 apply）
  view.dispatch(果.tr.setMeta(格式刷键, 态.锁定 ? 态 : null));
  if (果.跳过) 报(view, `已刷到目标；有 ${果.跳过} 处整块没动（代码 / 引用 / 表格 / 图片）`);
  return { 刷了: true, 跳过: 果.跳过 };
}

/** 界面 / 测试用的入口：从编辑器实例读当前选区 */
export function 应用格式刷(editor: Editor): 应用格式刷果 {
  return 应用格式刷视图(editor.view);
}

export const FormatPainter = Extension.create({
  name: "formatPainter",
  addProseMirrorPlugins() {
    return [
      new Plugin<格式刷态>({
        key: 格式刷键,
        state: {
          init: () => null,
          apply(tr, 旧) {
            const 新 = tr.getMeta(格式刷键) as 格式刷态 | undefined;
            if (新 !== undefined) {
              /**
               * 锁定档刷完还要接着用：源范围必须跟着这次事务映射，否则在源前面刷过几次
               * 之后，源位置就漂到别处，下一笔目标会被"源区间不刷"那条误伤。
               */
              if (新 && 旧 && tr.docChanged) {
                const from = tr.mapping.map(旧.快照.source.from, -1);
                const to = tr.mapping.map(旧.快照.source.to, 1);
                return { ...新, 快照: { ...新.快照, source: { from, to } } };
              }
              return 新;
            }
            // 文档一动，待命就结束：用户开始打字 / 撤销时不该还挂着一把格式刷
            if (tr.docChanged) return null;
            return 旧;
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Escape" || !格式刷状态of(view.state)) return false;
            关格式刷视图(view);
            return true;
          },
        },
        view: (view) => {
          const 同步 = () => {
            if (格式刷状态of(view.state)) view.dom.dataset["mdPaint"] = "";
            else delete view.dom.dataset["mdPaint"];
          };
          /**
           * **等拖选结束再刷**。在 `selectionUpdate` 上直接刷会在鼠标拖到一半时就把
           * 前几个字刷掉，然后单次档已经收起——用户要的是一整段。
           */
          let 排 = false;
          const 应用 = () => {
            排 = false;
            if (!格式刷状态of(view.state)) return;
            应用格式刷视图(view);
          };
          const 手势结束 = () => {
            if (排) return;
            排 = true;
            queueMicrotask(应用);
          };
          const 取消 = () => {
            if (格式刷状态of(view.state)) 关格式刷视图(view);
          };
          view.dom.addEventListener("mouseup", 手势结束);
          view.dom.addEventListener("keyup", 手势结束);
          // 焦点离开正文（点了侧栏 / 别处）就收起：留着十字光标会让人以为还在待命
          view.dom.addEventListener("blur", 取消);
          同步();
          return {
            update: 同步,
            destroy: () => {
              view.dom.removeEventListener("mouseup", 手势结束);
              view.dom.removeEventListener("keyup", 手势结束);
              view.dom.removeEventListener("blur", 取消);
              delete view.dom.dataset["mdPaint"];
            },
          };
        },
      }),
    ];
  },
});
