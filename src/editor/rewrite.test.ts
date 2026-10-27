import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { createTestEditor } from "./testEditor";
import {
  准备改写,
  取选段,
  能替换,
  替换选区,
  随事务,
  预设,
  浮层位置,
  浮层宽,
  浮层自然高,
  选段上限,
} from "./rewrite";

function 块(content: string, gapBefore: string): EditBlock {
  return {
    kind: "paragraph",
    id: null,
    raw: `${content}\n`,
    gapBefore,
    content,
    level: null,
    checked: null,
    fields: [],
    children: [],
  };
}

function 一篇(...段: string[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: 段.map((s, i) => 块(s, i === 0 ? "" : "\n")),
  };
}

function 位置(editor: Editor, 字: string): number {
  let 位 = -1;
  editor.state.doc.descendants((node, pos) => {
    if (位 >= 0) return false;
    if (!node.isText || !node.text) return true;
    const i = node.text.indexOf(字);
    if (i < 0) return true;
    位 = pos + i;
    return false;
  });
  if (位 < 0) throw new Error(`夹具里找不到「${字}」`);
  return 位;
}

function 选中(editor: Editor, from: number, to: number) {
  const sel = TextSelection.create(editor.state.doc, from, to);
  editor.view.dispatch(editor.state.tr.setSelection(sel));
}

/** 取到一个一定成立的锚点。用例里先选中、再取——失败就直接把原因抛出来 */
function 锚Of(editor: Editor): { from: number; to: number; text: string } {
  const r = 取选段(editor.state);
  if (!r.ok) throw new Error(r.why);
  return r.锚;
}

describe("哪些选区能改写", () => {
  it("一段里的连续文字可以", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第二段");
    选中(editor, from, from + 3);
    const r = 取选段(editor.state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.锚.text).toBe("第二段");
      expect(r.锚.from).toBe(from);
      expect(r.锚.to).toBe(from + 3);
    }
    editor.destroy();
  });

  it("空选区先把话说清楚", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    选中(editor, 2, 2);
    expect(取选段(editor.state)).toEqual({ ok: false, why: "先选中一段文字" });
    editor.destroy();
  });

  it("整块选中没有「一段连续文字」的含义", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    const sel = NodeSelection.create(editor.state.doc, 0);
    editor.view.dispatch(editor.state.tr.setSelection(sel));
    const r = 取选段(editor.state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("整块选中");
    editor.destroy();
  });

  it("跨块的选区不接，且原因点名跨块", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第一段") + 1;
    const to = 位置(editor, "第二段") + 2;
    选中(editor, from, to);
    const r = 取选段(editor.state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("同一段");
    editor.destroy();
  });

  it("只选中空白等于没选", () => {
    const editor = createTestEditor(一篇("甲 乙"));
    const 空 = 位置(editor, " ");
    选中(editor, 空, 空 + 1);
    const r = 取选段(editor.state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("空白");
    editor.destroy();
  });

  it("超过上限的那一段请分几次改", () => {
    const 长 = "长".repeat(选段上限 + 1);
    const editor = createTestEditor(一篇(长));
    选中(editor, 1, 1 + 长.length);
    const r = 取选段(editor.state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("太长");
    editor.destroy();
  });
});

describe("等回稿期间文档被改动", () => {
  it("选区前头插入的字把锚点往后推，不算失鲜", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第二段");
    选中(editor, from, from + 3);
    const 锚 = 锚Of(editor);

    const tr = editor.state.tr.insertText("前置", 1);
    const 后 = editor.state.apply(tr);
    const 移 = 随事务(锚, tr);

    expect(移.from).toBe(from + 2);
    expect(移.to).toBe(from + 5);
    expect(移.text).toBe(锚.text);
    expect(能替换(后, 移)).toBe(true);
    // 不跟着走的旧位置已经指到别处了
    expect(能替换(后, 锚)).toBe(false);
    editor.destroy();
  });

  it("选中那段本身被改过就作废，回稿不许盖上去", () => {
    const editor = createTestEditor(一篇("第二段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    expect(能替换(editor.state, 锚)).toBe(true);

    // 把「第」改成「改」：位置还在，但字节已经不是那一段
    editor.view.dispatch(editor.state.tr.insertText("改", 1, 2));
    expect(能替换(editor.state, 锚)).toBe(false);
    expect(替换选区(editor.state, 锚, "新的一段")).toBeNull();
    editor.destroy();
  });
});

describe("替换是一笔编辑", () => {
  it("一次事务换完，Ctrl+Z 一步回到原文", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第二段");
    选中(editor, from, from + 5);
    const 锚 = 锚Of(editor);

    const tr = 替换选区(editor.state, 锚, "改过的一段");
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);

    const 正文 = editor.state.doc.textBetween(1, editor.state.doc.content.size, "\n");
    expect(正文).toContain("改过的一段");
    expect(正文).not.toContain("第二段文字");

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    const 回来 = editor.state.doc.textBetween(1, editor.state.doc.content.size, "\n");
    expect(回来).toContain("第二段文字");
    expect(回来).not.toContain("改过的一段");
    editor.destroy();
  });

  it("多行或空白的回稿不落进文档", () => {
    const editor = createTestEditor(一篇("第二段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    expect(替换选区(editor.state, 锚, "有\n字")).toBeNull();
    expect(替换选区(editor.state, 锚, "   ")).toBeNull();
    expect(能替换(editor.state, 锚)).toBe(true);
    editor.destroy();
  });
});

describe("改写浮层的落点", () => {
  // 判据只看锚点与视口的四个边，**不测浮层高度**：回稿一到它会从 ~320 长到 ~520，
  // 按打开时的高度做"放不放得下"的决定，等字回来就失效了。
  const 锚 = (top: number, bottom: number) => ({ left: 200, top, bottom });
  const 宿主 = (视口下: number) => ({ 宽: 1000, 高: 2000, 视口上: 0, 视口下 });

  it("下方放得下就挂在选区下沿，不压住选中的字", () => {
    const 放 = 浮层位置(锚(300, 320), 宿主(900));
    expect(放.top).toBe(328);
    expect(放.bottom).toBeUndefined();
    expect(放.maxHeight).toBe(浮层自然高);
  });

  it("下方不够就翻到气泡上方，并让开气泡", () => {
    const 放 = 浮层位置(锚(700, 720), 宿主(900));
    expect(放.top).toBeUndefined();
    // 上沿 = 选区顶 700 - 气泡 34 - 边距 8 = 658
    expect(放.bottom).toBe(2000 - 658);
    expect(放.maxHeight).toBe(浮层自然高);
  });

  it("两边都不够时取空间大的一侧，高度夹进那一侧", () => {
    const 放 = 浮层位置(锚(380, 400), 宿主(800));
    // 下方 800-8-408 = 384；上方 380-34-8-8 = 330
    expect(放.top).toBe(408);
    expect(放.maxHeight).toBe(384);
  });

  it("上方空间更大时翻上去，高度夹到上方", () => {
    const 放 = 浮层位置(锚(500, 520), 宿主(800));
    // 下方 264；上方 500-34-8-8 = 450
    expect(放.bottom).toBe(2000 - 458);
    expect(放.maxHeight).toBe(450);
  });

  it("连最小高都放不下时仍给一块能用的面板：往下伸，不翻上去", () => {
    const 放 = 浮层位置(锚(100, 200), { 宽: 1000, 高: 2000, 视口上: 0, 视口下: 300 });
    // 下方 300-8-208 = 84；上方 100-34-8-8 = 50——翻上去的溢出是负向的，浏览器不给滚
    expect(放.top).toBe(208);
    expect(放.maxHeight).toBe(160);
  });

  it("窄宿主里贴左边，不把浮层推到外面", () => {
    const 放 = 浮层位置(
      { left: 300, top: 100, bottom: 200 },
      { 宽: 320, 高: 900, 视口上: 0, 视口下: 800 },
    );
    expect(放.left).toBe(8);
  });

  it("靠右时留 8px 边距", () => {
    const 放 = 浮层位置({ left: 990, top: 100, bottom: 200 }, 宿主(800));
    expect(放.left).toBe(1000 - 浮层宽 - 8);
  });
});


describe("两个入口的第一道闸", () => {
  it("模型没配时先让人去配，不说选区的事", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    const from = 位置(editor, "第一段");
    选中(editor, from, from + 3);
    const r = 准备改写(false, editor.state);
    expect(r.ok).toBe(false);
    // 圈选得再对也没用：配置是前提，先说前提
    if (!r.ok) expect(r.why).toContain("设置");
    editor.destroy();
  });

  it("配好了但没选中文字，说下一步是选中一段", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    选中(editor, 2, 2);
    const r = 准备改写(true, editor.state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("先选中一段文字");
    editor.destroy();
  });

  it("配好了且选了一段连续文字，直接给出锚点", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第二段");
    选中(editor, from, from + 3);
    const r = 准备改写(true, editor.state);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.锚.text).toBe("第二段");
    editor.destroy();
  });
});

describe("预设", () => {
  it("每一条都有 id、标签与指令，id 不重", () => {
    const ids = 预设.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of 预设) {
      expect(p.id.trim()).not.toBe("");
      expect(p.标签.trim()).not.toBe("");
      expect(p.指令.trim()).not.toBe("");
    }
  });
});
