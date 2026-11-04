import { Extension } from "@tiptap/core";
import { Mark, type Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * 在当前这篇里查找、替换。
 *
 * 只扫光标能放进去的正文（文本块里的字）。列表记号、待办方框、`due::`、块锚点、
 * 图注、代码围栏都不在这份字里，所以也不会被换掉。一次匹配不跨出同一块文字。
 */

export type 命中 = { from: number; to: number };

/** 超过这个数就只画当前这一处。几千个行内装饰才是长文档上贵的那部分。 */
export const 命中装饰上限 = 100;

export type 查找状态 = {
  查询: string;
  /** true：大小写必须一致。false：只把 A–Z 折成 a–z */
  区分大小写: boolean;
  命中: 命中[];
  /** 没有命中时是 -1 */
  当前: number;
};

export const 查找键 = new PluginKey<查找状态 | null>("mdFind");

/** 只折叠 A–Z。整串 `toLowerCase()` 会让有的字符变长，命中位置就错了。 */
export function 折叠字母(s: string): string {
  let 出 = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    出 += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i]!;
  }
  return 出;
}

export function 含换行(s: string): boolean {
  return /[\r\n]/.test(s);
}

/**
 * 光标落在哪一处附近。包住这个位置的优先；否则取它后面的第一处；都没有就回到开头。
 * 给「查询变了」用。用户正在正文里打字时不要用它——那会把高亮甩回篇首。
 */
export function 就近命中(命中: 命中[], 位置: number): number {
  if (!命中.length) return -1;
  const 含 = 命中.findIndex((h) => h.from <= 位置 && 位置 < h.to);
  if (含 >= 0) return 含;
  const 后 = 命中.findIndex((h) => h.from >= 位置);
  return 后 >= 0 ? 后 : 0;
}

/** 替换完往前走：取插进去的那段之后的第一处，没有就绕回开头。 */
export function 替换之后(命中: 命中[], 终点: number): number {
  if (!命中.length) return -1;
  const 后 = 命中.findIndex((h) => h.from >= 终点);
  return 后 >= 0 ? 后 : 0;
}

function 跟上(命中: 命中[], 旧: number, 位置: number): number {
  if (!命中.length) return -1;
  const 含 = 命中.findIndex((h) => h.from <= 位置 && 位置 < h.to);
  if (含 >= 0) return 含;
  if (旧 >= 0 && 旧 < 命中.length) return 旧;
  const 后 = 命中.findIndex((h) => h.from >= 位置);
  return 后 >= 0 ? 后 : 命中.length - 1;
}

export function 查找(doc: PmNode, 查询: string, 区分大小写: boolean): 命中[] {
  if (!查询) return [];
  const 针 = 区分大小写 ? 查询 : 折叠字母(查询);
  const 出: 命中[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const 文 = node.textContent;
    // 本编辑器的行内只有文本，下标才能直接换成文档位置。对不上就跳过，免得标到别的字上。
    if (node.content.size !== 文.length) return false;
    const 堆 = 区分大小写 ? 文 : 折叠字母(文);
    let 从 = 0;
    while (从 <= 堆.length - 针.length) {
      const i = 堆.indexOf(针, 从);
      if (i < 0) break;
      出.push({ from: pos + 1 + i, to: pos + 1 + i + 针.length });
      从 = i + 针.length;
    }
    return false;
  });
  return 出;
}

/** 整段命中同一种行内样式才保留；跨过边界就换成不带样式的字。 */
function 整段样式(doc: PmNode, from: number, to: number): readonly Mark[] {
  const 各组: Array<readonly Mark[]> = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) 各组.push(node.marks);
  });
  const 首 = 各组[0];
  if (!首?.length || 各组.some((m) => !Mark.sameSet(首, m))) return [];
  return 首;
}

function 写入(tr: Transaction, from: number, to: number, 文: string) {
  if (!文) {
    tr.delete(from, to);
    return;
  }
  const 样式 = 整段样式(tr.doc, from, to);
  const 节点 = 样式.length ? tr.doc.type.schema.text(文, 样式) : tr.doc.type.schema.text(文);
  tr.replaceWith(from, to, 节点);
}

/** 换掉一处。替换串里有换行就什么都不做（调用方负责提示）。 */
export function 替换一处(
  state: EditorState,
  from: number,
  to: number,
  文: string,
): Transaction | null {
  if (含换行(文) || from >= to) return null;
  const tr = state.tr;
  写入(tr, from, to, 文);
  return tr;
}

/**
 * 用替换前的位置，从文档末尾往前换，合成一笔事务。
 * 新写进去的字不参加这一轮，所以「a」换成「aa」不会停不下来。
 */
export function 全部替换(state: EditorState, 命中: 命中[], 文: string): Transaction | null {
  if (含换行(文) || !命中.length) return null;
  const tr = state.tr;
  for (let i = 命中.length - 1; i >= 0; i--) {
    const h = 命中[i]!;
    写入(tr, h.from, h.to, 文);
  }
  return tr;
}

/** 选区在同一块里、且是不长的单行时，用它当查询。 */
export function 选区种子(state: EditorState): string | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  if (sel.$from.parent !== sel.$to.parent) return null;
  const 文 = state.doc.textBetween(sel.from, sel.to, "\n");
  if (!文 || 文.includes("\n") || 文.length > 200) return null;
  return 文;
}

export function 装查找(tr: Transaction, 态: 查找状态 | null): Transaction {
  tr.setMeta(查找键, 态);
  if (态 && 态.当前 >= 0) {
    const h = 态.命中[态.当前];
    if (h) tr.setSelection(TextSelection.create(tr.doc, h.from, h.to));
  }
  return tr;
}

/**
 * `Ctrl+F` / `Ctrl+H` 该谁管。带 Shift 的不算：`Ctrl+Shift+H` 已经是高亮。
 * 别的输入框（侧栏搜索、设置）也不抢。
 */
export function 查找快捷键(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
  在查找栏: boolean;
  在别的输入: boolean;
}): "查找" | "替换" | "选中查询" | "展开替换" | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.shiftKey || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  if (e.在别的输入) return null;
  const k = e.key.toLowerCase();
  if (k !== "f" && k !== "h") return null;
  if (e.在查找栏) return k === "f" ? "选中查询" : "展开替换";
  return k === "h" ? "替换" : "查找";
}

function 画命中(state: EditorState): DecorationSet | null {
  const 态 = 查找键.getState(state);
  if (!态?.命中.length) return null;
  const 画全部 = 态.命中.length <= 命中装饰上限;
  const 出: Decoration[] = [];
  if (画全部) {
    态.命中.forEach((h, i) => {
      if (h.from >= h.to) return;
      出.push(
        Decoration.inline(h.from, h.to, {
          class: i === 态.当前 ? "find-hit current" : "find-hit",
        }),
      );
    });
  } else if (态.当前 >= 0 && 态.当前 < 态.命中.length) {
    const h = 态.命中[态.当前]!;
    if (h.from < h.to) 出.push(Decoration.inline(h.from, h.to, { class: "find-hit current" }));
  }
  return 出.length ? DecorationSet.create(state.doc, 出) : null;
}

export const 查找扩展 = Extension.create({
  name: "findReplace",
  addProseMirrorPlugins() {
    return [
      new Plugin<查找状态 | null>({
        key: 查找键,
        state: {
          init: () => null,
          apply(tr, 旧) {
            const 指定 = tr.getMeta(查找键) as 查找状态 | null | undefined;
            if (指定 !== undefined) return 指定;
            if (!旧 || !tr.docChanged) return 旧;
            const 命中 = 查找(tr.doc, 旧.查询, 旧.区分大小写);
            return { ...旧, 命中, 当前: 跟上(命中, 旧.当前, tr.selection.from) };
          },
        },
        props: {
          decorations: 画命中,
        },
      }),
    ];
  },
});
