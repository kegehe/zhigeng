import { undo } from "@tiptap/pm/history";
import { describe, expect, it } from "vitest";

import type { DocEditOp, DocEditPlan } from "../ipc/types";
import { applyBlockType, docToMarkdown, type EditBlock, type EditDoc } from "./blocks";
import { 块类型, 块文本, 收集整篇, 应用整篇编辑, 计划预览 } from "./docEdit";
import { createTestEditor } from "./testEditor";

function 块(
  content: string,
  id: string,
  kind = "paragraph",
  extra: Partial<EditBlock> = {},
): EditBlock {
  return {
    kind,
    id,
    raw: extra.raw ?? content + "\n",
    gapBefore: "",
    content,
    level: kind === "heading" ? 1 : null,
    checked: null,
    align: null,
    fields: [],
    children: [],
    ...extra,
  };
}

function 篇(...blocks: EditBlock[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: blocks.map((b, i) => ({ ...b, gapBefore: i ? "\n" : "" })),
  };
}

function 计划(...edits: DocEditOp[]): DocEditPlan {
  return {
    edits,
    note: null,
    inTokens: 0,
    outTokens: 0,
    ms: 0,
    model: "测试",
    blocks: 0,
  };
}

describe("收集整篇", () => {
  it("每块带上 id / 类型 / 内容；代码块给完整围栏源码", () => {
    const editor = createTestEditor(
      篇(
        块("标题", "b-1", "heading", { raw: "# 标题\n", level: 1 }),
        块("第一段", "b-2"),
        块("console.log(1);", "b-3", "code", { raw: "```js\nconsole.log(1);\n```\n" }),
      ),
    );
    const 收 = 收集整篇(editor.state);
    expect(收.ok).toBe(true);
    if (收.ok) {
      expect(收.blocks.map((b) => b.id)).toEqual(["b-1", "b-2", "b-3"]);
      expect(收.blocks[0]!.kind).toBe("heading1");
      expect(收.blocks[1]!.text).toBe("第一段");
      expect(收.blocks[2]!.kind).toBe("code");
      expect(收.blocks[2]!.text).toContain("```js");
      expect(收.原文.get("b-2")!.text).toBe("第一段");
    }
    editor.destroy();
  });

  it("没有块 id 的块用快照序号键参与；空落脚段不进清单", () => {
    const editor = createTestEditor(
      篇(块("第一段", "b-1"), 块("新块", ""), 块("", "")),
    );
    const 收 = 收集整篇(editor.state);
    expect(收.ok).toBe(true);
    if (!收.ok) return;
    // 真块 id 原样保留；没有 id 的有字块拿 i-<顶层序号>，空落脚段跳过
    expect(收.blocks.map((b) => b.id)).toEqual(["b-1", "i-2"]);
    expect(收.blocks[1]!.text).toBe("新块");

    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "i-2", text: "改过的新块" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(editor.state.doc.textContent).toContain("改过的新块");
    // 有真 id 的块没被碰
    expect(editor.state.doc.firstChild!.attrs.mdId).toBe("b-1");
    editor.destroy();
  });

  it("整篇都没有块 id 也能整篇编辑", () => {
    const editor = createTestEditor(篇(块("新块一", ""), 块("新块二", "")));
    const 收 = 收集整篇(editor.state);
    expect(收.ok).toBe(true);
    if (!收.ok) return;
    expect(收.blocks.map((b) => b.id)).toEqual(["i-1", "i-2"]);

    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "i-1", text: "改过的第一块" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(editor.state.doc.textContent).toBe("改过的第一块新块二");
    editor.destroy();
  });

  it("空文档也能收成一份空清单，从文首写整篇", () => {
    const editor = createTestEditor(篇());
    const 收 = 收集整篇(editor.state);
    expect(收.ok).toBe(true);
    if (!收.ok) return;
    expect(收.blocks).toEqual([]);
    expect(收.空篇).toBe(true);

    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "insert_after", after: null, kind: "heading1", text: "备份纪律" },
        { op: "insert_after", after: null, kind: "paragraph", text: "唯一副本不算备份。" },
        { op: "insert_after", after: null, kind: "bullet", text: "至少两个物理介质" },
        { op: "insert_after", after: null, kind: "bullet", text: "定期做恢复演练" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    // 多条 after:null 必须**按计划顺序**落地：写整篇靠的就是这一个顺序
    expect(editor.state.doc.firstChild!.type.name).toBe("mdHeading");
    expect(editor.state.doc.child(1).textContent).toBe("唯一副本不算备份。");
    expect(editor.state.doc.child(2).textContent).toBe("至少两个物理介质");
    expect(editor.state.doc.child(3).textContent).toBe("定期做恢复演练");
    // 末尾留一个空落脚段，不落字节
    const md = docToMarkdown(editor.state.doc, 篇());
    expect(md.indexOf("# 备份纪律")).toBeLessThan(md.indexOf("唯一副本不算备份。"));
    expect(md.indexOf("唯一副本不算备份。")).toBeLessThan(md.indexOf("- 至少两个物理介质"));
    editor.destroy();
  });
});

describe("应用整篇编辑", () => {
  it("替换保块 id 与块类型；未涉及的块原样复用；一处撤销全回来", () => {
    const head = 篇(
      块("旧标题", "b-1", "heading", { raw: "# 旧标题\n", level: 1 }),
      块("旧段落", "b-2"),
      块("尾段", "b-3"),
    );
    const editor = createTestEditor(head);
    const 快照 = editor.state.doc;
    const 原首块 = editor.state.doc.firstChild!;
    const 果 = 应用整篇编辑(
      editor.state,
      快照,
      计划({ op: "replace", id: "b-2", text: "**新**段落" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);

    expect(editor.state.doc.textContent).toContain("新段落");
    expect(editor.state.doc.textContent).toContain("尾段");
    // 标题没被碰：还是原来那个节点；段落保住了 id
    expect(editor.state.doc.firstChild).toBe(原首块);
    const 段 = editor.state.doc.child(1);
    expect(段.attrs.mdId).toBe("b-2");
    expect(段.type.name).toBe("mdParagraph");

    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(editor.state.doc.textContent).toContain("旧段落");
    editor.destroy();
  });

  it("删除 + 在指定块后插入；新块没有 id，代码块带围栏", () => {
    const head = 篇(块("标题", "b-1", "heading", { raw: "# 标题\n", level: 1 }), 块("正文", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "delete", id: "b-1" },
        { op: "replace", id: "b-2", text: "改过的正文" },
        { op: "insert_after", after: "b-2", kind: "paragraph", text: "新的一段" },
        { op: "insert_after", after: "b-2", kind: "code", text: "console.log(2);" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(果.应用数).toBe(4);
    expect(editor.state.doc.textContent).not.toContain("标题");
    expect(editor.state.doc.textContent).toContain("改过的正文");
    expect(editor.state.doc.textContent).toContain("新的一段");
    // 删除 b-1 后，改过的 b-2 落到第一块；插入的新块没有 id
    expect(editor.state.doc.child(0).attrs.mdId).toBe("b-2");
    expect(editor.state.doc.child(1).attrs.mdId).toBe(null);
    expect(editor.state.doc.textContent).toContain("console.log(2);");
    editor.destroy();
  });

  it("文件本来就以空行开头：原首块那段 gap 原样保留", () => {
    const head = 篇(块("第一段", "b-1"));
    head.blocks[0]!.gapBefore = "\n";
    const editor = createTestEditor(head);
    // 上一条只清"删除后新首块继承来的 gap"；原首块自己的前导空行是文件的字节，不许动
    expect(docToMarkdown(editor.state.doc, head)).toBe("\n第一段\n");
    editor.destroy();
  });

  it("删掉第一块：下一块继承的 gap 不许变成文件开头的空行", () => {
    const head = 篇(块("第一段", "b-1"), 块("第二段", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "delete", id: "b-1" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    // 第二块的 gap 原本是"与前任之间的一整行"；前任没了，它不能变成文件开头的一个空行
    expect(docToMarkdown(editor.state.doc, head)).toBe("第二段\n");
    editor.destroy();
  });

  it("列表项替换保留列表类型；front-matter 原样保留", () => {
    const head = 篇(块("旧项", "b-1", "bullet", { raw: "- 旧项\n" }), 块("尾段", "b-2"));
    head.frontMatter = "---\nid: n-1\n---\n";
    // 有 front-matter 时第一块的 gap 是 "\n"（`---` 后面那个空行），内核就是这么给的
    head.blocks[0]!.gapBefore = "\n";
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", text: "新项" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 项 = editor.state.doc.firstChild!;
    expect(项.type.name).toBe("mdItem");
    expect(项.attrs.mdKind).toBe("bullet");
    expect(项.attrs.mdId).toBe("b-1");
    expect(docToMarkdown(editor.state.doc, head)).toBe(
      "---\nid: n-1\n---\n\n- 新项 ^b-1\n\n尾段\n",
    );
    editor.destroy();
  });

  it("同类型替换有序列表时保留它自己的记号（3. / 2) 不落回 1.）", () => {
    const head = 篇(
      块("第三项", "b-1", "numbered", { raw: "3. 第三项\n" }),
      块("第二项", "b-2", "numbered", { raw: "2) 第二项\n" }),
    );
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "replace", id: "b-1", text: "新的第三项" },
        { op: "replace", id: "b-2", text: "新的第二项" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 文 = docToMarkdown(editor.state.doc, head);
    expect(文).toContain("3. 新的第三项");
    expect(文).toContain("2) 新的第二项");
    editor.destroy();
  });

  it("源码块同类型替换也能落笔：callout 不因 kind 白名单被拒", () => {
    const head = 篇(
      块("> [!note] 标题\n> 正文", "b-1", "callout", {
        raw: "> [!note] 标题\n> 正文\n",
        content: "标题\n正文",
      }),
    );
    const editor = createTestEditor(head);
    const 收 = 收集整篇(editor.state);
    expect(收.ok && 收.blocks[0]!.kind).toBe("callout");
    // 模型把原 kind 一起写回来也不该被当成"改成不认识的块"
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", kind: "callout", text: "> [!note] 新标题\n> 新正文" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 文 = docToMarkdown(editor.state.doc, head);
    expect(文).toContain("新正文");
    expect(文).toContain("^b-1");
    editor.destroy();
  });

  it("insert_after 的文字块含换行整份拒绝（与后端同一道闸）", () => {
    const editor = createTestEditor(篇(块("正文", "b-1")));
    expect(
      应用整篇编辑(
        editor.state,
        editor.state.doc,
        计划({ op: "insert_after", after: "b-1", kind: "paragraph", text: "两\n行" }),
      ),
    ).toMatchObject({ ok: false });
    editor.destroy();
  });

  it("replace 带 kind 能改块类型：段落变标题、列表变段落，id 仍跟着走", () => {
    const head = 篇(
      块("旧段落", "b-1"),
      块("旧列表", "b-2", "bullet", { raw: "- 旧列表\n" }),
    );
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "replace", id: "b-1", kind: "heading2", text: "新标题" },
        { op: "replace", id: "b-2", kind: "paragraph", text: "普通段落" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);

    const 首 = editor.state.doc.child(0);
    expect(首.type.name).toBe("mdHeading");
    expect(首.attrs.mdLevel).toBe(2);
    expect(首.attrs.mdId).toBe("b-1");
    const 次 = editor.state.doc.child(1);
    expect(次.type.name).toBe("mdParagraph");
    expect(次.attrs.mdKind).toBe("paragraph");
    expect(次.attrs.mdId).toBe("b-2");
    expect(docToMarkdown(editor.state.doc, head)).toContain("## 新标题");
    editor.destroy();
  });

  it("replace 带 kind 能转成引用 / 代码；不认识的类型整份拒绝", () => {
    const head = 篇(块("正文", "b-1"), 块("另一段", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "replace", id: "b-1", kind: "quote", text: "引用一句" },
        { op: "replace", id: "b-2", kind: "code", text: "console.log(1);" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(块类型(editor.state.doc.child(0))).toBe("quote");
    expect(块类型(editor.state.doc.child(1))).toBe("code");
    expect(docToMarkdown(editor.state.doc, head)).toContain("> 引用一句");
    expect(docToMarkdown(editor.state.doc, head)).toContain("console.log(1);");

    const 错 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", kind: "video", text: "x" }),
    );
    expect(错).toMatchObject({ ok: false });
    editor.destroy();
  });

  it("把一块拆成多块：delete 原块 + 对原 id 连续 insert_after", () => {
    const editor = createTestEditor(篇(块("一段流水账", "b-1"), 块("尾段", "b-2")));
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "delete", id: "b-1" },
        { op: "insert_after", after: "b-1", kind: "heading2", text: "要点" },
        { op: "insert_after", after: "b-1", kind: "bullet", text: "第一点" },
        { op: "insert_after", after: "b-1", kind: "bullet", text: "第二点" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(editor.state.doc.textContent).toBe("要点第一点第二点尾段");
    expect(块类型(editor.state.doc.child(0))).toBe("heading2");
    expect(块类型(editor.state.doc.child(1))).toBe("bullet");
    expect(块类型(editor.state.doc.child(2))).toBe("bullet");
    editor.destroy();
  });

  it("代码块按完整围栏源码替换，保 id", () => {
    const head = 篇(块("console.log(1);", "b-1", "code", { raw: "```js\nconsole.log(1);\n```\n" }));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", text: "```ts\nconsole.log(2);\n```" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 代码块 = editor.state.doc.firstChild!;
    expect(代码块.attrs.mdId).toBe("b-1");
    expect(代码块.textContent).toContain("console.log(2);");
    expect(docToMarkdown(editor.state.doc, head)).toContain("```ts");
    editor.destroy();
  });

  it("分隔线不给 replace：那会看着改了、实际还是 ---", () => {
    const editor = createTestEditor(篇(块("---", "b-1", "divider", { raw: "---\n" })));
    expect(
      应用整篇编辑(
        editor.state,
        editor.state.doc,
        计划({ op: "replace", id: "b-1", text: "改成正文" }),
      ),
    ).toMatchObject({ ok: false });
    editor.destroy();
  });

  it("表格可以插入；不是 Markdown 表格就整份拒绝", () => {
    const editor = createTestEditor(篇(块("正文", "b-1")));
    const 好 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({
        op: "insert_after",
        after: "b-1",
        kind: "table",
        text: "| A |\n| - |\n| 1 |",
      }),
    );
    expect(好.ok).toBe(true);
    if (!好.ok) return;
    editor.view.dispatch(好.tr);
    expect(块类型(editor.state.doc.child(1))).toBe("table");
    expect(editor.state.doc.textContent).toContain("A");

    const 错 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "insert_after", after: "b-1", kind: "table", text: "不是表格" }),
    );
    expect(错).toMatchObject({ ok: false });
    editor.destroy();
  });

  it("删掉最后一块时光标落在剩下的最后一块，不跳回文首", () => {
    const editor = createTestEditor(篇(块("一", "b-1"), 块("二", "b-2"), 块("三", "b-3")));
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "delete", id: "b-3" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(editor.state.selection.$from.parent.textContent).toBe("二");
    editor.destroy();
  });

  it("快照过期 / 不存在的 id / 表格替换 / 同块两次 / 文字含换行 都整份拒绝", () => {
    const head = 篇(
      块("第一段", "b-1"),
      块("| A |\n| - |\n| 1 |", "b-2", "table", {
        raw: "| A |\n| - |\n| 1 |\n",
        content: "",
      }),
    );
    const editor = createTestEditor(head);
    const 快照 = editor.state.doc;

    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    expect(应用整篇编辑(editor.state, 快照, 计划({ op: "replace", id: "b-1", text: "新" }))).toMatchObject({
      ok: false,
    });
    // 撤销这次插入，后面的用例从原文档继续
    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);

    expect(应用整篇编辑(editor.state, editor.state.doc, 计划({ op: "replace", id: "b-9", text: "新" }))).toMatchObject({
      ok: false,
    });
    expect(
      应用整篇编辑(editor.state, editor.state.doc, 计划({ op: "replace", id: "b-2", text: "新" })),
    ).toMatchObject({ ok: false });
    expect(
      应用整篇编辑(
        editor.state,
        editor.state.doc,
        计划(
          { op: "replace", id: "b-1", text: "新" },
          { op: "delete", id: "b-1" },
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      应用整篇编辑(editor.state, editor.state.doc, 计划({ op: "replace", id: "b-1", text: "两\n行" })),
    ).toMatchObject({ ok: false });

    expect(块类型(editor.state.doc.firstChild!)).toBe("paragraph");
    expect(块文本(editor.state.doc.firstChild!)).toBe("第一段");
    editor.destroy();
  });

  it("预览条目说清替换/删除/插入", () => {
    const head = 篇(块("旧标题", "b-1", "heading", { raw: "# 旧标题\n", level: 1 }), 块("正文", "b-2"));
    const editor = createTestEditor(head);
    const 预览 = 计划预览(
      计划(
        { op: "replace", id: "b-1", text: "新标题" },
        { op: "delete", id: "b-2" },
        { op: "insert_after", after: null, kind: "paragraph", text: "开头" },
      ),
      editor.state.doc,
    );
    expect(预览[0]!.标签).toContain("替换");
    expect(预览[0]!.旧).toBe("旧标题");
    expect(预览[0]!.新).toBe("新标题");
    expect(预览[1]!.标签).toContain("删除");
    expect(预览[2]!.标签).toContain("文首");
    editor.destroy();
  });
});

describe("排版副作用", () => {
  it("替换一块保留作者自己的空行；换块类型也不动排版", () => {
    const head: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { ...块("第一段", "b-1"), gapBefore: "" },
        { ...块("第二段", "b-2"), gapBefore: "\n\n" },
        { ...块("第三段", "b-3"), gapBefore: "\n" },
      ],
    };
    const 同 = createTestEditor(head);
    const 原 = docToMarkdown(同.state.doc, head);
    const 换 = 应用整篇编辑(
      同.state,
      同.state.doc,
      计划({ op: "replace", id: "b-2", text: "新的第二段" }),
    );
    expect(换.ok).toBe(true);
    if (!换.ok) return;
    同.view.dispatch(换.tr);
    // 块 id 也照旧落在行尾
    expect(docToMarkdown(同.state.doc, head)).toBe(原.replace("第二段", "新的第二段 ^b-2"));
    同.destroy();

    const 改类 = createTestEditor(head);
    const 换类 = 应用整篇编辑(
      改类.state,
      改类.state.doc,
      计划({ op: "replace", id: "b-2", kind: "heading2", text: "新的第二段" }),
    );
    expect(换类.ok).toBe(true);
    if (!换类.ok) return;
    改类.view.dispatch(换类.tr);
    expect(docToMarkdown(改类.state.doc, head)).toBe(
      原.replace("第二段", "## 新的第二段 ^b-2"),
    );
    改类.destroy();
  });

  it("中段插入源码块，正文里不凭空多一个空段落", () => {
    const head = 篇(块("第一段", "b-1"), 块("尾段", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "insert_after", after: "b-1", kind: "code", text: "x=1" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 名: string[] = [];
    editor.state.doc.forEach((n) => 名.push(`${n.type.name}:${n.textContent}`));
    expect(名).toEqual(["mdParagraph:第一段", "mdOpaque:x=1", "mdParagraph:尾段"]);
    expect(docToMarkdown(editor.state.doc, head)).toBe("第一段\n\n```\nx=1\n```\n\n尾段\n");
    editor.destroy();
  });

  it("文末插入表格仍补一个不落盘的落脚点", () => {
    const head = 篇(块("第一段", "b-1"), 块("尾段", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({
        op: "insert_after",
        after: "b-2",
        kind: "table",
        text: "| A |\n| - |\n| 1 |",
      }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    expect(editor.state.doc.childCount).toBe(4);
    const 尾 = editor.state.doc.lastChild!;
    expect(尾.type.name).toBe("mdParagraph");
    expect(尾.textContent).toBe("");
    expect(docToMarkdown(editor.state.doc, head)).toBe(
      "第一段\n\n尾段\n\n| A |\n| --- |\n| 1 |\n",
    );
    editor.destroy();
  });

  it("带块锚点的块不能直接换成分隔线 / 表格：那会把锚点写丢或写进正文", () => {
    const editor = createTestEditor(篇(块("正文", "b-1")));
    for (const kind of ["divider", "table"] as const) {
      const 果 = 应用整篇编辑(
        editor.state,
        editor.state.doc,
        计划({
          op: "replace",
          id: "b-1",
          kind,
          text: kind === "table" ? "| A |\n| - |\n| 1 |" : "---",
        }),
      );
      expect(果, kind).toMatchObject({ ok: false });
      if (!果.ok) expect(果.why).toContain("锚点");
    }
    // 没有锚点的块照常能换：新块本来就不带 `^b-`
    const 空锚 = createTestEditor(篇(块("正文", "")));
    const 成 = 应用整篇编辑(
      空锚.state,
      空锚.state.doc,
      计划({ op: "replace", id: "i-1", kind: "divider", text: "---" }),
    );
    expect(成.ok).toBe(true);
    if (!成.ok) return;
    空锚.view.dispatch(成.tr);
    expect(块类型(空锚.state.doc.firstChild!)).toBe("divider");
    expect(空锚.state.doc.firstChild!.attrs.mdId).toBe(null);
    expect(docToMarkdown(空锚.state.doc, 篇(块("正文", "")))).toBe("---\n");
    空锚.destroy();
    editor.destroy();
  });

  it("文首插一段：原第一块不会被读成续行", () => {
    const head = 篇(块("第一段", "b-1"), 块("第二段", "b-2"));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "insert_after", after: null, kind: "paragraph", text: "新开头" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    // 原第一块的 gap 是 ""（文件第一块本来就不带空行），插到它前面之后必须补一整行，
    // 否则 `新开头\n第一段` 重新解析就是同一段
    expect(docToMarkdown(editor.state.doc, head)).toBe("新开头\n\n第一段\n\n第二段\n");
    editor.destroy();
  });

  it("列表项改成正文：补回空行，两块不会并成一块", () => {
    const head: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        块("第一项", "b-1", "bullet", { raw: "- 第一项\n" }),
        块("第二项", "b-2", "bullet", { raw: "- 第二项\n" }),
      ],
    };
    const 整篇 = createTestEditor(head);
    const 果 = 应用整篇编辑(
      整篇.state,
      整篇.state.doc,
      计划({ op: "replace", id: "b-2", kind: "paragraph", text: "改过的第二项" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    整篇.view.dispatch(果.tr);
    expect(docToMarkdown(整篇.state.doc, head)).toBe("- 第一项\n\n改过的第二项 ^b-2\n");
    整篇.destroy();

    // 工具栏 / 输入规则 / 本地样式快路径共用 `applyBlockType`，同一条边界也要成立
    const 本地 = createTestEditor(head);
    const tr = applyBlockType(本地.state, 本地.state.doc.child(0).nodeSize, "paragraph");
    expect(tr).not.toBeNull();
    if (!tr) return;
    本地.view.dispatch(tr);
    expect(docToMarkdown(本地.state.doc, head)).toBe("- 第一项\n\n第二项 ^b-2\n");
    本地.destroy();
  });

  it("合法紧排（标题紧接段落）没碰过的块不多补空行", () => {
    const head: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { ...块("标题", "b-1", "heading", { raw: "# 标题\n", level: 1 }), gapBefore: "" },
        { ...块("段落", "b-2"), gapBefore: "" },
      ],
    };
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", text: "新标题" }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    // 标题本来就能打断上一段；这里的 gap 不动，字节改动只发生在被替换的那一块
    expect(docToMarkdown(editor.state.doc, head)).toBe("# 新标题 ^b-1\n段落\n");
    editor.destroy();
  });

  it("代码块按模型看到的文本（带块锚那行）原样回传，仍保留围栏账本", () => {
    const head: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        块("```js\nconsole.log(1);\n```", "b-1", "code", {
          raw: "```js\nconsole.log(1);\n```\n^b-1\n",
        }),
      ],
    };
    const editor = createTestEditor(head);
    const 见 = 块文本(editor.state.doc.firstChild!);
    expect(见).toBe("```js\nconsole.log(1);\n```\n^b-1");
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "replace", id: "b-1", text: 见 }),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 新 = editor.state.doc.firstChild!;
    // 还原成围栏账本（而不是把围栏写进正文的源文本块），字节也还是原样
    expect(新.attrs.mdFenceOpen).toBe("```js");
    expect(新.attrs.mdFenceClose).toBe("```");
    expect(docToMarkdown(editor.state.doc, head)).toBe("```js\nconsole.log(1);\n```\n^b-1\n");
    editor.destroy();
  });

  it("末块换成表格后再往后插一块：中间不留可见空段", () => {
    const head = 篇(块("第一段", "b-1"), 块("第二段", ""));
    const editor = createTestEditor(head);
    const 果 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划(
        { op: "replace", id: "i-2", kind: "table", text: "| A |\n| - |\n| 1 |" },
        { op: "insert_after", after: "i-2", kind: "paragraph", text: "表后的话" },
      ),
    );
    expect(果.ok).toBe(true);
    if (!果.ok) return;
    editor.view.dispatch(果.tr);
    const 名: string[] = [];
    editor.state.doc.forEach((n) => 名.push(`${n.type.name}:${n.textContent}`));
    expect(名).toEqual(["mdParagraph:第一段", "mdTable:A1", "mdParagraph:表后的话"]);
    expect(docToMarkdown(editor.state.doc, head)).toBe(
      "第一段\n\n| A |\n| --- |\n| 1 |\n\n表后的话\n",
    );
    editor.destroy();
  });

  it("段落文字以块级记号开头：拒绝，不让它落盘后变另一种块", () => {
    const editor = createTestEditor(篇(块("正文", "b-1")));
    for (const text of ["# 其实是标题", "- 列表项", "> 引用", "1. 有序项", "---"]) {
      const 果 = 应用整篇编辑(
        editor.state,
        editor.state.doc,
        计划({ op: "replace", id: "b-1", text }),
      );
      expect(果, text).toMatchObject({ ok: false });
      if (!果.ok) expect(果.why).toContain("块级记号");
    }
    const 插 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "insert_after", after: null, kind: "paragraph", text: "- 列表项" }),
    );
    expect(插).toMatchObject({ ok: false });
    // 换成对应的 kind 就能写：这里要的是拒绝"段落里塞块语法"，不是拒绝这些字
    const 对 = 应用整篇编辑(
      editor.state,
      editor.state.doc,
      计划({ op: "insert_after", after: null, kind: "bullet", text: "列表项" }),
    );
    expect(对.ok).toBe(true);
    editor.destroy();
  });
});
