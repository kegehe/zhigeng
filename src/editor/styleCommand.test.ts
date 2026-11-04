import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import type { EditBlock, EditDoc } from "../ipc/types";
import { 调色板 } from "./colors";
import { createTestEditor } from "./testEditor";
import { 取选段, type 锚 } from "./rewrite";
import { 应用样式命令, 识别样式命令, type 样式命令 } from "./styleCommand";

/**
 * 本地样式快路径的**识别与落笔**。
 *
 * 识别这边最要紧的是"认不出就是认不出"：带内容要求的句子被本地截走，用户会以为
 * 模型没听完整；而落笔这边最要紧的是"没改动就不发事务"——空事务会把笔记白标一次脏。
 */

function 块(
  content: string,
  rest: Partial<EditBlock> = {},
): EditBlock {
  return {
    kind: "paragraph",
    id: null,
    raw: `${content}\n`,
    gapBefore: "",
    content,
    level: null,
    checked: null,
    align: null,
    fields: [],
    children: [],
    ...rest,
  };
}

function 篇(...段: EditBlock[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: 段.map((b, i) => ({ ...b, gapBefore: b.gapBefore || (i ? "\n" : "") })),
  };
}

function 找(editor: Editor, 字: string): number {
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
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

function 锚Of(editor: Editor): 锚 {
  const r = 取选段(editor.state);
  if (!r.ok) throw new Error(r.why);
  return r.锚;
}

function 执行(editor: Editor, 令: string) {
  const 命 = 识别样式命令(令);
  expect(命, `「${令}」应该被认出来`).not.toBeNull();
  return 应用样式命令(editor.state, 锚Of(editor), 命!);
}

const 色hex = (id: string) => 调色板.find((c) => c.id === id)!.hex;
const 红 = 色hex("red");
const 橙 = 色hex("amber");
const 蓝 = 色hex("blue");
const 绿 = 色hex("green");
const 紫 = 色hex("purple");

describe("识别样式命令", () => {
  it("整句就是一个样式动作时才认", () => {
    const 认得: [string, 样式命令][] = [
      ["加粗", { 类: "标记", 标: "bold", 开: true, 名: "加粗" }],
      ["帮我加粗一下", { 类: "标记", 标: "bold", 开: true, 名: "加粗" }],
      ["斜体", { 类: "标记", 标: "italic", 开: true, 名: "斜体" }],
      ["删除线", { 类: "标记", 标: "strike", 开: true, 名: "删除线" }],
      ["行内代码", { 类: "标记", 标: "code", 开: true, 名: "行内代码" }],
      ["高亮", { 类: "标记", 标: "highlight", 开: true, 名: "高亮" }],
      ["上标", { 类: "标记", 标: "sup", 开: true, 名: "上标" }],
      ["下标", { 类: "标记", 标: "sub", 开: true, 名: "下标" }],
      ["去掉加粗", { 类: "标记", 标: "bold", 开: false, 名: "加粗" }],
      ["取消高亮", { 类: "标记", 标: "highlight", 开: false, 名: "高亮" }],
      ["取消上标", { 类: "标记", 标: "sup", 开: false, 名: "上标" }],
      ["把这段改成红色", { 类: "颜色", 标: "textColor", 色: 红, 名: "红" }],
      ["用蓝色", { 类: "颜色", 标: "textColor", 色: 蓝, 名: "蓝" }],
      ["文字颜色改成绿色", { 类: "颜色", 标: "textColor", 色: 绿, 名: "绿" }],
      ["背景色改成黄色", { 类: "颜色", 标: "bgColor", 色: `${橙}33`, 名: "橙" }],
      ["底色换成紫色", { 类: "颜色", 标: "bgColor", 色: `${紫}33`, 名: "紫" }],
      ["橙色", { 类: "颜色", 标: "textColor", 色: 橙, 名: "橙" }],
      ["改成红色可以吗", { 类: "颜色", 标: "textColor", 色: 红, 名: "红" }],
      ["去掉文字颜色", { 类: "颜色", 标: "textColor", 色: null, 名: "文字色" }],
      ["取消背景色", { 类: "颜色", 标: "bgColor", 色: null, 名: "底色" }],
      ["清除所有格式", { 类: "清除" }],
      ["清除格式", { 类: "清除" }],
      ["改成二级标题", { 类: "块", 型: "heading2", 名: "标题 2" }],
      ["标题3", { 类: "块", 型: "heading3", 名: "标题 3" }],
      ["h4", { 类: "块", 型: "heading4", 名: "标题 4" }],
      ["换成正文", { 类: "块", 型: "paragraph", 名: "正文" }],
      ["变成无序列表", { 类: "块", 型: "bullet", 名: "无序列表" }],
      ["改成有序列表", { 类: "块", 型: "numbered", 名: "有序列表" }],
      ["改成待办事项", { 类: "块", 型: "todo", 名: "待办" }],
      ["变成引用", { 类: "引用" }],
    ];
    for (const [令, 望] of 认得) {
      expect(识别样式命令(令), 令).toEqual(望);
    }
  });

  it("带内容要求、只是一部分像样式的句子一律交回模型", () => {
    for (const 令 of [
      "",
      "润色",
      "解释这段话",
      "写一篇短文",
      "表格",
      "加粗和变红",
      "把这段加粗一点顺便正式些",
      "改成三级标题并加粗",
      "不要太长",
      "设置为红色吗？",
    ]) {
      expect(识别样式命令(令), 令).toBeNull();
    }
  });
});

describe("行内样式只动选中的那几个字", () => {
  it("加粗是一笔可撤销事务，选区外一个字不变", () => {
    const editor = createTestEditor(篇(块("第一段文字"), 块("第二段文字")));
    const from = 找(editor, "第二段");
    选中(editor, from, from + 3);
    const 果 = 执行(editor, "加粗");
    expect(果.tr).not.toBeNull();
    expect(果.说明).toContain("3 字");
    editor.view.dispatch(果.tr!);

    const 粗 = editor.state.schema.marks.bold!.create();
    expect(editor.state.doc.rangeHasMark(from, from + 3, 粗)).toBe(true);
    expect(editor.state.doc.rangeHasMark(from + 3, from + 4, 粗)).toBe(false);
    expect(editor.state.doc.child(0).textContent).toBe("第一段文字");

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(editor.state.doc.rangeHasMark(from, from + 3, 粗)).toBe(false);
    editor.destroy();
  });

  it("已经是加粗 / 本来没有加粗：不发事务，并说实话", () => {
    const editor = createTestEditor(篇(块("第一段文字")));
    选中(editor, 1, 3);

    const 一 = 执行(editor, "加粗");
    editor.view.dispatch(一.tr!);
    const 二 = 执行(editor, "加粗");
    expect(二.tr).toBeNull();
    expect(二.说明).toContain("已经是");

    const 三 = 执行(editor, "取消加粗");
    editor.view.dispatch(三.tr!);
    const 四 = 执行(editor, "取消加粗");
    expect(四.tr).toBeNull();
    expect(四.说明).toContain("本来就没有");
    editor.destroy();
  });

  it("颜色写成调色板里的真色值；同色再来一次不落空事务", () => {
    const editor = createTestEditor(篇(块("第一段文字")));
    选中(editor, 1, 3);

    const 一 = 执行(editor, "改成红色");
    editor.view.dispatch(一.tr!);
    const 字 = editor.state.doc.nodeAt(1)!;
    expect(字.marks.find((m) => m.type.name === "textColor")?.attrs.color).toBe(红);

    const 二 = 执行(editor, "改成红色");
    expect(二.tr).toBeNull();
    expect(二.说明).toContain("已经是这个");
    editor.destroy();
  });

  it("清除格式去掉行内样式、把块收回正文，但【留着链接】", () => {
    const editor = createTestEditor(篇(块("第一段文字")));
    选中(editor, 1, 5);
    const 标 = editor.state.schema.marks;
    editor.view.dispatch(editor.state.tr.addMark(1, 5, 标.bold!.create()));
    editor.view.dispatch(editor.state.tr.addMark(1, 5, 标.textColor!.create({ color: 红 })));
    editor.view.dispatch(editor.state.tr.addMark(1, 5, 标.sup!.create()));
    editor.view.dispatch(
      editor.state.tr.addMark(1, 5, 标.link!.create({ href: "https://example.com" })),
    );

    const 果 = 执行(editor, "清除所有格式");
    expect(果.tr).not.toBeNull();
    expect(果.说明).toContain("链接保留");
    editor.view.dispatch(果.tr!);

    expect(editor.state.doc.rangeHasMark(1, 5, 标.bold!.create())).toBe(false);
    expect(editor.state.doc.rangeHasMark(1, 5, 标.textColor!.create({ color: 红 }))).toBe(false);
    expect(editor.state.doc.rangeHasMark(1, 5, 标.sup!.create())).toBe(false);
    expect(editor.state.doc.rangeHasMark(1, 5, 标.link!.create({ href: "https://example.com" }))).toBe(
      true,
    );
    editor.destroy();
  });

  it("清除格式也把标题收回正文；本来就干净就不发事务", () => {
    const 头 = 块("小节", {
      kind: "heading",
      raw: "## 小节\n",
      level: 2,
    });
    const 编 = createTestEditor(篇(头));
    选中(编, 1, 3);
    const 果 = 执行(编, "清除格式");
    expect(果.tr).not.toBeNull();
    编.view.dispatch(果.tr!);
    expect(编.state.doc.firstChild!.type.name).toBe("mdParagraph");
    expect(编.state.doc.firstChild!.attrs.mdLevel).toBeNull();
    编.destroy();

    const 素 = createTestEditor(篇(块("第一段文字")));
    选中(素, 1, 3);
    const 空 = 执行(素, "清除格式");
    expect(空.tr).toBeNull();
    expect(空.说明).toContain("没有可清除");
    素.destroy();
  });
});

describe("块类型动的是光标所在的整块", () => {
  it("只选中了半句，换的也是整块；同类型再来一次不落空事务", () => {
    const editor = createTestEditor(篇(块("第一段文字"), 块("第二段文字")));
    const from = 找(editor, "第二段");
    选中(editor, from, from + 3);

    const 果 = 执行(editor, "改成二级标题");
    expect(果.tr).not.toBeNull();
    expect(果.说明).toContain("标题 2");
    editor.view.dispatch(果.tr!);

    expect(editor.state.doc.child(0).type.name).toBe("mdParagraph");
    const 节 = editor.state.doc.child(1);
    expect(节.type.name).toBe("mdHeading");
    expect(节.attrs.mdLevel).toBe(2);
    expect(节.textContent).toBe("第二段文字");

    const 空 = 执行(editor, "改成标题二");
    expect(空.tr).toBeNull();
    expect(空.说明).toContain("已经是");
    editor.destroy();
  });

  it("代码块与表格不硬转，明说先改成普通正文", () => {
    const 码 = createTestEditor(
      篇(
        块("let a = 1;", {
          kind: "code",
          raw: "```\nlet a = 1;\n```\n",
          content: "let a = 1;",
        }),
      ),
    );
    const 码位 = 找(码, "let");
    选中(码, 码位, 码位 + 3);
    const 码果 = 执行(码, "改成二级标题");
    expect(码果.tr).toBeNull();
    expect(码果.说明).toContain("普通正文");
    码.destroy();

    const 表 = createTestEditor(
      篇(
        块("", {
          kind: "table",
          raw: "| 列 A | 列 B |\n|---|---|\n| 1 | 2 |\n",
          content: "",
        }),
      ),
    );
    const 甲 = 找(表, "列 A");
    选中(表, 甲, 甲 + 2);
    const 表果 = 执行(表, "改成二级标题");
    expect(表果.tr).toBeNull();
    expect(表果.说明).toContain("表格");
    表.destroy();
  });

  it("代码块里说加粗：说清源码块加不了行内样式，不谎称「已经是加粗」", () => {
    const editor = createTestEditor(
      篇(
        块("let a = 1;", {
          kind: "code",
          raw: "```\nlet a = 1;\n```\n",
          content: "let a = 1;",
        }),
      ),
    );
    const 位 = 找(editor, "let");
    选中(editor, 位, 位 + 3);
    const 果 = 执行(editor, "加粗");
    expect(果.tr).toBeNull();
    expect(果.说明).toContain("源码块");
    expect(果.说明).not.toContain("已经是");
    editor.destroy();
  });
});

describe("变成引用", () => {
  it("块 ID、原字节与间距都留着，正文只前面多一个 `> `", () => {
    const 段 = 块("正文一段", { id: "b-7", raw: "正文一段\n" });
    const editor = createTestEditor(篇(段));
    选中(editor, 1, 5);

    const 果 = 执行(editor, "变成引用");
    expect(果.tr).not.toBeNull();
    editor.view.dispatch(果.tr!);

    const 块新 = editor.state.doc.firstChild!;
    expect(块新.type.name).toBe("mdOpaque");
    expect(块新.attrs.mdKind).toBe("quote");
    expect(块新.attrs.mdId).toBe("b-7");
    expect(块新.attrs.mdRaw).toBe("正文一段\n");
    expect(块新.attrs.mdGap).toBe("");
    expect(块新.attrs.mdSig).toBe("");
    expect(块新.textContent).toBe("正文一段 ^b-7");
    expect(块新.attrs.mdQuoteMarks).toBe("> ");
    // 落笔后整块选中：引用以渲染后的样子出现，不会先翻回源文本
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    editor.destroy();
  });

  it("嵌套列表项与带行内字段的段不硬转，原因点名要先处理什么", () => {
    const 层 = createTestEditor(篇(块("子项", { kind: "bullet", raw: "- 子项\n", content: "子项" })));
    const 原 = 层.state.doc.nodeAt(0)!;
    层.view.dispatch(层.state.tr.setNodeMarkup(0, undefined, { ...原.attrs, mdDepth: 1 }));
    选中(层, 1, 3);
    const 层果 = 执行(层, "变成引用");
    expect(层果.tr).toBeNull();
    expect(层果.说明).toContain("嵌套列表项");
    层.destroy();

    const 段 = 块("正文一段", { fields: [["due", "2026-11-02"]] });
    const 田 = createTestEditor(篇(段));
    选中(田, 1, 5);
    const 田果 = 执行(田, "变成引用");
    expect(田果.tr).toBeNull();
    expect(田果.说明).toContain("行内字段");
    田.destroy();
  });
});
