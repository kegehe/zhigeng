import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { docToMarkdown } from "./blocks";
import { 调色板 } from "./colors";
import { createTestEditor } from "./testEditor";
import {
  取选段,
  能替换,
  删除选区,
  段首记号问题,
  看选区,
  清空正文,
  替换选区,
  随事务,
  选区源,
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
    align: null,
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

function 篇块(...块们: EditBlock[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: 块们.map((b, i) => ({ ...b, gapBefore: i ? "\n" : "" })),
  };
}

function 项(content: string): EditBlock {
  return { ...块(content, ""), kind: "bullet", raw: `- ${content}\n` };
}

function 码(content: string): EditBlock {
  return { ...块(content, ""), kind: "code", raw: `\`\`\`\n${content}\n\`\`\`\n` };
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

    const 果 = 替换选区(editor.state, 锚, "改过的一段");
    expect(果).not.toBeNull();
    editor.view.dispatch(果!.tr);
    expect(果!.文).toBe("改过的一段");

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

describe("回稿在段首写块级记号", () => {
  it("段落段首的 # / - / > / 1. 之类会被读成另一种块：拒收，并点名原因", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    for (const 回稿 of [
      "# 新标题",
      "- 新列表项",
      "> 新引用",
      "1. 新有序项",
      " # 一个空格之后",
      " ".repeat(4) + "缩进码",
    ]) {
      expect(段首记号问题(editor.state, 锚, 回稿), 回稿).toContain("块级记号");
      expect(替换选区(editor.state, 锚, 回稿), 回稿).toBeNull();
    }
    // 一个字都没动：不是"先换再报错"
    expect(editor.state.doc.textContent).toBe("第一段文字");
    editor.destroy();
  });

  it("记号不在行首就不管：句中写 # 照常替换", () => {
    const editor = createTestEditor(一篇("前缀 第一段文字"));
    const from = 位置(editor, "第一段");
    选中(editor, from, from + 3);
    const 锚 = 锚Of(editor);
    expect(段首记号问题(editor.state, 锚, "# 新标题")).toBeNull();
    expect(替换选区(editor.state, 锚, "# 新标题")).not.toBeNull();
    editor.destroy();
  });

  it("列表项的段首也算：标题记号会让列表项里长出一个标题", () => {
    const editor = createTestEditor(篇块(项("第一项")));
    选中(editor, 1, 4);
    const 锚 = 锚Of(editor);
    expect(段首记号问题(editor.state, 锚, "# 新标题")).toContain("块级记号");
    expect(替换选区(editor.state, 锚, "# 新标题")).toBeNull();
    editor.destroy();
  });

  it("代码块里的 # 就是注释：不拦", () => {
    const editor = createTestEditor(篇块(码("# 注释")));
    const 长 = [..."# 注释"].length;
    选中(editor, 1, 1 + 长);
    const 锚 = 锚Of(editor);
    expect(段首记号问题(editor.state, 锚, "# 新注释")).toBeNull();
    expect(替换选区(editor.state, 锚, "# 新注释")).not.toBeNull();
    editor.destroy();
  });
});

describe("删除", () => {
  it("删除是一笔独立事务：只删锚定的文字，可撤销；空串替换仍被拒", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    expect(替换选区(editor.state, 锚, "")).toBeNull();

    const tr = 删除选区(editor.state, 锚);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.doc.textContent).toBe("第二段文字");

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字");
    editor.destroy();
  });

  it("锚点失鲜时删除也拒绝，不猜位置", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    // 改的是锚点内部：位移没变，但那几个字节已经不是原来那段了
    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    expect(删除选区(editor.state, 锚)).toBeNull();
    expect(editor.state.doc.textContent).toBe("第X一段文字");
    editor.destroy();
  });
});

describe("整篇清空", () => {
  it("只留一个空段落，front-matter 原样保留，一处撤销全回来", () => {
    const head = 一篇("第一段文字", "第二段文字");
    head.frontMatter = "---\nid: n-1\ntitle: 探针\n---\n";
    const editor = createTestEditor(head);
    const tr = 清空正文(editor.state, editor.state.doc);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("");
    // front-matter 不在编辑器里，清正文不该把它写没
    expect(docToMarkdown(editor.state.doc, head)).toBe(head.frontMatter + head.trailingGap);

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字");
    editor.destroy();
  });

  it("不看块类型：代码、表格、公式一起清掉，撤销也一起回来", () => {
    const head = JSON.parse(
      readFileSync("testdata/editdoc/03-代码表格与公式.json", "utf8"),
    ) as EditDoc;
    const editor = createTestEditor(head);
    const 原样 = editor.state.doc.textContent;
    expect(原样.length).toBeGreaterThan(0);

    const tr = 清空正文(editor.state, editor.state.doc);
    editor.view.dispatch(tr!);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("");

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(editor.state.doc.textContent).toBe(原样);
    editor.destroy();
  });

  it("确认期间文档被改过就拒绝，不把新写的一起清掉", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const 快照 = editor.state.doc;
    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    expect(清空正文(editor.state, 快照)).toBeNull();
    expect(editor.state.doc.textContent).toBe("第X一段文字第二段文字");
    editor.destroy();
  });
});

describe("对话框里的选区预览", () => {  it("没选字时没有预览——这一次按整篇处理", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    选中(editor, 2, 2);
    expect(看选区(editor.state)).toBeNull();
    editor.destroy();
  });

  it("选中一段连续文字：原文、字数都在，且能用", () => {
    const editor = createTestEditor(一篇("第一段文字"));
    const from = 位置(editor, "第一段");
    选中(editor, from, from + 3);
    expect(看选区(editor.state)).toEqual({
      text: "第一段",
      字数: 3,
      能用: true,
      why: null,
    });
    editor.destroy();
  });

  it("跨块选区照实显示原文，同时把原因带上", () => {
    const editor = createTestEditor(一篇("第一段文字", "第二段文字"));
    const from = 位置(editor, "第一段") + 1;
    const to = 位置(editor, "第二段") + 2;
    选中(editor, from, to);
    const 概 = 看选区(editor.state)!;
    expect(概.text).toContain("\n");
    expect(概.字数).toBeGreaterThan(0);
    expect(概.能用).toBe(false);
    expect(概.why).toContain("同一段");
    editor.destroy();
  });

  it("只选中空白也照实显示，但标明不能改", () => {
    const editor = createTestEditor(一篇("甲 乙"));
    const 空 = 位置(editor, " ");
    选中(editor, 空, 空 + 1);
    const 概 = 看选区(editor.state)!;
    expect(概.text).toBe(" ");
    expect(概.能用).toBe(false);
    expect(概.why).toContain("空白");
    editor.destroy();
  });
});
/** 一段里每一种标记各覆盖了多少个字 */
function 标记字数(编辑后: Editor, 名: string): number {
  let 数 = 0;
  编辑后.state.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 名)) 数 += [...(n.text ?? "")].length;
  });
  return 数;
}

describe("行内样式跟着选区走", () => {
  it("发给模型的是带 Markdown 标记的原文，不是被洗白的纯文字", () => {
    const editor = createTestEditor(一篇("**粗体**和颜色"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    // 失鲜判定仍用纯文字：屏幕上那一段就是这五个字
    expect(锚.text).toBe("粗体和颜色");
    expect(选区源(editor.state, 锚)).toBe("**粗体**和颜色");
    editor.destroy();
  });

  it("回稿里的样式落进正文，别名文字按去掉标记后的纯文字算", () => {
    const editor = createTestEditor(一篇("第二段文字"));
    选中(editor, 1, 6);
    const 锚 = 锚Of(editor);
    const 果 = 替换选区(editor.state, 锚, "**新**的字");
    expect(果).not.toBeNull();
    expect(果!.文).toBe("新的字");
    editor.view.dispatch(果!.tr);

    expect(editor.state.doc.firstChild!.textContent).toBe("新的字");
    expect(标记字数(editor, "bold")).toBe(1);
    // 新锚点按落进文档的纯文字算，落完仍然认得出这一段
    expect(能替换(editor.state, { from: 锚.from, to: 锚.from + 果!.文.length, text: 果!.文 })).toBe(
      true,
    );
    editor.destroy();
  });

  it("整段都带着的样式会被继承：改措辞不该把颜色洗掉", () => {
    const editor = createTestEditor(一篇("**整句**"));
    选中(editor, 1, 3);
    const 果 = 替换选区(editor.state, 锚Of(editor), "改写后")!;
    editor.view.dispatch(果.tr);
    expect(editor.state.doc.firstChild!.textContent).toBe("改写后");
    expect(标记字数(editor, "bold")).toBe(3);
    editor.destroy();
  });

  it("只有半句有的样式不继承：那不算「这一段的样式」", () => {
    const editor = createTestEditor(一篇("**粗**体"));
    选中(editor, 1, 3);
    const 果 = 替换选区(editor.state, 锚Of(editor), "新字")!;
    editor.view.dispatch(果.tr);
    expect(标记字数(editor, "bold")).toBe(0);
    editor.destroy();
  });

  it("回稿自己写的颜色优先于整段继承来的", () => {
    const 红 = 调色板.find((c) => c.id === "red")!.hex;
    const 蓝 = 调色板.find((c) => c.id === "blue")!.hex;
    const editor = createTestEditor(一篇(`<span style="color:${红}">红字</span>`));
    选中(editor, 1, 3);
    const 果 = 替换选区(
      editor.state,
      锚Of(editor),
      `<span style="color:${蓝}">蓝字</span>`,
    )!;
    editor.view.dispatch(果.tr);
    const 段 = editor.state.doc.firstChild!;
    expect(段.textContent).toBe("蓝字");
    const 色 = 段.firstChild!.marks.filter((m) => m.type.name === "textColor");
    expect(色).toHaveLength(1);
    expect(色[0]!.attrs["color"]).toBe(蓝);
    editor.destroy();
  });
});
