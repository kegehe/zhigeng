import { act, createElement, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";
import { docToMarkdown, type EditBlock, type EditDoc } from "./blocks";
import { BlockEditor } from "./BlockEditor";
import {
  全部替换,
  命中装饰上限,
  查找,
  查找键,
  查找快捷键,
  就近命中,
  折叠字母,
  替换一处,
  替换之后,
  选区种子,
  装查找,
} from "./findReplace";
import { createTestEditor } from "./testEditor";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 的 Range 没有 getBoundingClientRect。选区气泡量矩形时会踩到它，真机上这个方法是有的。
const 零矩形 = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {},
  }) as DOMRect;
Range.prototype.getBoundingClientRect = 零矩形;

function 块(过: Partial<EditBlock> & { content: string }): EditBlock {
  const { raw, ...其余 } = 过;
  return {
    kind: "paragraph",
    id: null,
    gapBefore: "",
    level: null,
    checked: null,
    align: null,
    fields: [],
    children: [],
    ...其余,
    raw: raw ?? 过.content + "\n",
  };
}

function 篇(blocks: EditBlock[]): EditDoc {
  return { frontMatter: "", trailingGap: "", blocks };
}

const 活的: Editor[] = [];
afterEach(() => {
  for (const editor of 活的) {
    const 壳 = editor.view.dom.parentElement;
    editor.destroy();
    if (壳 && 壳 !== document.body) 壳.remove();
  }
  活的.length = 0;
});

function 打开(doc: EditDoc): Editor {
  const editor = createTestEditor(doc);
  活的.push(editor);
  return editor;
}

function 文(editor: Editor, doc: EditDoc): string {
  return docToMarkdown(editor.state.doc, doc);
}

function 装饰(editor: Editor) {
  const plugin = 查找键.get(editor.state);
  const 画 = plugin?.props.decorations;
  if (!plugin || !画) return [];
  const set = 画.call(plugin, editor.state);
  return set instanceof DecorationSet ? set.find() : [];
}

function 挂上(editor: Editor, 态: NonNullable<ReturnType<typeof 查找键.getState>>) {
  editor.view.dispatch(装查找(editor.state.tr, 态));
}

describe("查找", () => {
  it("不跨出同一块文字", () => {
    const doc = 篇([块({ content: "甲" }), { ...块({ content: "乙" }), gapBefore: "\n" }]);
    const editor = 打开(doc);
    expect(查找(editor.state.doc, "甲乙", false)).toEqual([]);
    expect(查找(editor.state.doc, "甲", false)).toHaveLength(1);
    expect(查找(editor.state.doc, "乙", false)).toHaveLength(1);
  });

  it("命中互不重叠，前进这次的长度", () => {
    const editor = 打开(篇([块({ content: "aaaa" })]));
    const 两处 = 查找(editor.state.doc, "aa", true);
    expect(两处.map((h) => editor.state.doc.textBetween(h.from, h.to))).toEqual(["aa", "aa"]);
    const 短 = 打开(篇([块({ content: "aaa" })]));
    expect(查找(短.state.doc, "aa", true)).toHaveLength(1);
    expect(查找(editor.state.doc, "", false)).toEqual([]);
  });

  it("只折叠 A–Z，不把别的字母折短", () => {
    expect(折叠字母("AbCİ")).toBe("abcİ");
    const editor = 打开(篇([块({ content: "AbC" })]));
    expect(查找(editor.state.doc, "abc", false)).toHaveLength(1);
    expect(查找(editor.state.doc, "ab", false)).toHaveLength(1);
    expect(查找(editor.state.doc, "abc", true)).toEqual([]);
    expect(查找(editor.state.doc, "AbC", true)).toHaveLength(1);
    const 点 = 打开(篇([块({ content: "İ" })]));
    expect(查找(点.state.doc, "i", false)).toEqual([]);
    expect(查找(点.state.doc, "İ", false)).toHaveLength(1);
  });

  it("段首全角空格是正文里的字", () => {
    const editor = 打开(篇([块({ content: "\u3000甲" })]));
    expect(查找(editor.state.doc, "\u3000", false)).toHaveLength(1);
    expect(查找(editor.state.doc, "甲", false)).toHaveLength(1);
  });

  it("待办只找正文，方框不在字里", () => {
    const doc = 篇([
      块({ kind: "todo", content: "买菜", raw: "- [ ] 买菜\n", checked: false }),
    ]);
    const editor = 打开(doc);
    expect(editor.state.doc.textContent).toBe("买菜");
    expect(查找(editor.state.doc, "[ ]", false)).toEqual([]);
    expect(查找(editor.state.doc, "[x]", false)).toEqual([]);
    const 处 = 查找(editor.state.doc, "买菜", false);
    expect(处).toHaveLength(1);
    editor.view.dispatch(替换一处(editor.state, 处[0]!.from, 处[0]!.to, "白菜")!);
    expect(文(editor, doc)).toContain("- [ ] 白菜");
    expect(editor.state.doc.firstChild!.attrs.mdChecked).toBe(false);
  });

  it("due:: 在字段上，不在能改的字里", () => {
    const editor = 打开(
      篇([
        块({
          content: "开会",
          raw: "开会 due:: 2026-11-02\n",
          fields: [["due", "2026-11-02"]],
        }),
      ]),
    );
    expect(editor.state.doc.textContent).toBe("开会");
    expect(查找(editor.state.doc, "due", false)).toEqual([]);
    expect(查找(editor.state.doc, "2026", false)).toEqual([]);
    expect(查找(editor.state.doc, "开会", false)).toHaveLength(1);
  });

  it("引用找的是正文，> 前缀不在可编辑的字里", () => {
    const editor = 打开(
      篇([块({ kind: "quote", content: "", raw: "> 引用甲\n" })]),
    );
    expect(editor.state.doc.textContent).toBe("引用甲");
    expect(查找(editor.state.doc, "引用甲", false)).toHaveLength(1);
    expect(查找(editor.state.doc, ">", true)).toEqual([]);
  });

  it("代码块只找栏中间的代码", () => {
    const doc = 篇([
      块({ content: "甲", raw: "甲 \n" }),
      块({
        kind: "code",
        content: "",
        raw: "```js\nlet a = 1\n```\n",
        gapBefore: "\n",
      }),
    ]);
    const editor = 打开(doc);
    expect(editor.state.doc.textContent).toContain("let a = 1");
    expect(查找(editor.state.doc, "```", true)).toEqual([]);
    const 处 = 查找(editor.state.doc, "a", true);
    expect(处).toHaveLength(1);
    editor.view.dispatch(替换一处(editor.state, 处[0]!.from, 处[0]!.to, "b")!);
    const 出 = 文(editor, doc);
    expect(出.startsWith("甲 \n")).toBe(true);
    expect(出).toContain("```js");
    expect(出).toContain("let b = 1");
    expect(出).not.toContain("let a = 1");
  });

  it("表格格子各算各的", () => {
    const 表 = "| 甲 | 乙 |\n| --- | --- |\n| 甲 | 甲乙 |\n";
    const editor = 打开(
      篇([块({ kind: "table", content: "", raw: 表 })]),
    );
    expect(查找(editor.state.doc, "甲乙", false)).toHaveLength(1);
    const 甲 = 查找(editor.state.doc, "甲", false);
    const 整格 = 甲.filter((h) => {
      const $p = editor.state.doc.resolve(h.from);
      return $p.parent.textContent === "甲";
    });
    expect(整格).toHaveLength(2);
    for (const h of 整格) expect(editor.state.doc.textBetween(h.from, h.to)).toBe("甲");
    const 跨 = 打开(
      篇([块({ kind: "table", content: "", raw: "| 甲 | 乙 |\n| --- | --- |\n" })]),
    );
    expect(查找(跨.state.doc, "甲乙", false)).toEqual([]);
  });
});

describe("替换", () => {
  it("整段同一种样式就留下，跨过边界就不带", () => {
    const 只换甲 = 篇([块({ content: "**甲**乙", raw: "**甲**乙\n" })]);
    const 甲 = 打开(只换甲);
    const 处 = 查找(甲.state.doc, "甲", false)[0]!;
    甲.view.dispatch(替换一处(甲.state, 处.from, 处.to, "丙")!);
    expect(文(甲, 只换甲)).toBe("**丙**乙\n");

    const 整段 = 篇([块({ content: "**甲**乙", raw: "**甲**乙\n" })]);
    const 跨 = 打开(整段);
    const 全 = 查找(跨.state.doc, "甲乙", false)[0]!;
    跨.view.dispatch(替换一处(跨.state, 全.from, 全.to, "丙")!);
    expect(文(跨, 整段)).toBe("丙\n");

    const 局部 = 篇([块({ content: "**甲乙**", raw: "**甲乙**\n" })]);
    const 切 = 打开(局部);
    const 头 = 查找(切.state.doc, "甲", false)[0]!;
    切.view.dispatch(替换一处(切.state, 头.from, 头.to, "丙")!);
    expect(文(切, 局部)).toBe("**丙乙**\n");
  });

  it("有序记号留在原来的序号上", () => {
    const doc = 篇([块({ kind: "numbered", content: "甲", raw: "3. 甲\n" })]);
    const editor = 打开(doc);
    const 处 = 查找(editor.state.doc, "甲", false)[0]!;
    editor.view.dispatch(替换一处(editor.state, 处.from, 处.to, "乙")!);
    const 出 = 文(editor, doc);
    expect(出).toContain("3. 乙");
    expect(出).not.toContain("1. 乙");
  });

  it("替换串里有换行就不动；空替换是删掉", () => {
    const doc = 篇([块({ content: "甲乙" })]);
    const editor = 打开(doc);
    const 处 = 查找(editor.state.doc, "甲", false)[0]!;
    const 前 = editor.state.doc.textContent;
    expect(替换一处(editor.state, 处.from, 处.to, "丙\n丁")).toBeNull();
    expect(全部替换(editor.state, [处], "丙\r丁")).toBeNull();
    expect(editor.state.doc.textContent).toBe(前);
    editor.view.dispatch(替换一处(editor.state, 处.from, 处.to, "")!);
    expect(editor.state.doc.textContent).toBe("乙");
  });

  it("全部替换是一笔，新写的字不参加这一轮", () => {
    const doc = 篇([块({ content: "甲乙甲" })]);
    const editor = 打开(doc);
    const 原文 = 文(editor, doc);
    const 处 = 查找(editor.state.doc, "甲", false);
    const tr = 全部替换(editor.state, 处, "丙")!;
    expect(tr.steps.length).toBe(2);
    editor.view.dispatch(tr);
    expect(editor.state.doc.textContent).toBe("丙乙丙");
    expect(undo(editor.state, (t) => editor.view.dispatch(t))).toBe(true);
    expect(文(editor, doc)).toBe(原文);

    const 单 = 打开(篇([块({ content: "a" })]));
    const 一轮 = 全部替换(单.state, 查找(单.state.doc, "a", false), "ab")!;
    expect(一轮.steps.length).toBe(1);
    单.view.dispatch(一轮);
    expect(单.state.doc.textContent).toBe("ab");

    const 清 = 打开(篇([块({ content: "甲乙甲" })]));
    清.view.dispatch(全部替换(清.state, 查找(清.state.doc, "甲", false), "")!);
    expect(清.state.doc.textContent).toBe("乙");
  });

  it("换完往前走，跳过刚写进去的那段", () => {
    const editor = 打开(篇([块({ content: "aaaa" })]));
    const 处 = 查找(editor.state.doc, "aa", true);
    const 第一 = 处[0]!;
    const tr = 替换一处(editor.state, 第一.from, 第一.to, "b")!;
    const 命中 = 查找(tr.doc, "aa", true);
    expect(替换之后(命中, 第一.from + 1)).toBe(0);
    expect(命中).toHaveLength(1);
    expect(就近命中([], 0)).toBe(-1);
    expect(就近命中(处, 99)).toBe(0);
  });
});

describe("装饰与选区", () => {
  it("超过上限只画当前这一处，计数仍是全文的", () => {
    expect(命中装饰上限).toBe(100);
    const 百 = 打开(篇([块({ content: "a ".repeat(100) })]));
    const 百处 = 查找(百.state.doc, "a", true);
    expect(百处).toHaveLength(100);
    挂上(百, { 查询: "a", 区分大小写: true, 命中: 百处, 当前: 3 });
    expect(装饰(百)).toHaveLength(100);
    expect(百.view.dom.querySelectorAll(".find-hit").length).toBe(100);
    expect(百.view.dom.querySelectorAll(".find-hit.current").length).toBe(1);

    const 多 = 打开(篇([块({ content: "a ".repeat(101) })]));
    const 多处 = 查找(多.state.doc, "a", true);
    expect(多处).toHaveLength(101);
    挂上(多, { 查询: "a", 区分大小写: true, 命中: 多处, 当前: 4 });
    expect(装饰(多)).toHaveLength(1);
    expect(多.view.dom.querySelectorAll(".find-hit.current").length).toBe(1);
    expect(多.view.dom.querySelectorAll(".find-hit").length).toBe(1);
  });

  it("只挪选区不把这篇标成改过", () => {
    const editor = 打开(篇([块({ content: "甲乙甲" })]));
    const 处 = 查找(editor.state.doc, "甲", false);
    let 更新 = 0;
    const 记 = () => {
      更新 += 1;
    };
    editor.on("update", 记);
    const tr = 装查找(editor.state.tr, {
      查询: "甲",
      区分大小写: false,
      命中: 处,
      当前: 1,
    }).scrollIntoView();
    expect(tr.docChanged).toBe(false);
    editor.view.dispatch(tr);
    expect(更新).toBe(0);
    expect(editor.state.selection.from).toBe(处[1]!.from);
    editor.off("update", 记);
  });

  it("输入框拿着焦点时，跳到命中不把焦点抢走", () => {
    const editor = 打开(篇([块({ content: "甲乙甲" })]));
    const 输入 = document.createElement("input");
    document.body.append(输入);
    输入.focus();
    const 处 = 查找(editor.state.doc, "甲", false);
    editor.view.dispatch(
      装查找(editor.state.tr, { 查询: "甲", 区分大小写: false, 命中: 处, 当前: 0 }).scrollIntoView(),
    );
    expect(document.activeElement).toBe(输入);
    输入.remove();
  });

  it("选区在同一块里、且是不长的单行时才当查询", () => {
    const editor = 打开(篇([块({ content: "甲乙" }), { ...块({ content: "丙" }), gapBefore: "\n" }]));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 2)));
    expect(选区种子(editor.state)).toBe("甲");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 3)));
    expect(选区种子(editor.state)).toBe("甲乙");
    const 长 = "甲".repeat(201);
    const 长文 = 打开(篇([块({ content: 长 })]));
    长文.view.dispatch(长文.state.tr.setSelection(TextSelection.create(长文.state.doc, 1, 202)));
    expect(选区种子(长文.state)).toBeNull();
    const 码 = 打开(篇([块({ kind: "code", content: "", raw: "```\n甲\n乙\n```\n" })]));
    const 文头 = 码.state.doc.textContent.indexOf("甲");
    const 起 = 1 + 文头;
    码.view.dispatch(码.state.tr.setSelection(TextSelection.create(码.state.doc, 起, 起 + 3)));
    expect(码.state.doc.textBetween(起, 起 + 3)).toBe("甲\n乙");
    expect(选区种子(码.state)).toBeNull();
  });

  it("正文改字时高亮留在原来那一处，不绕回篇首", () => {
    const editor = 打开(篇([块({ content: "甲乙甲" })]));
    const 处 = 查找(editor.state.doc, "甲", false);
    挂上(editor, { 查询: "甲", 区分大小写: false, 命中: 处, 当前: 1 });
    editor.view.dispatch(editor.state.tr.insertText("x", 2));
    const 后 = 查找键.getState(editor.state);
    expect(后?.命中).toHaveLength(2);
    expect(后?.当前).toBe(1);
    expect(editor.state.doc.textBetween(后!.命中[1]!.from, 后!.命中[1]!.to)).toBe("甲");
  });
});

describe("查找快捷键", () => {
  const 基 = {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    在查找栏: false,
    在别的输入: false,
  };

  it("Shift、Alt、组字、别的输入都不抢", () => {
    expect(查找快捷键({ ...基, key: "f", shiftKey: true })).toBeNull();
    expect(查找快捷键({ ...基, key: "h", altKey: true })).toBeNull();
    expect(查找快捷键({ ...基, key: "f", isComposing: true })).toBeNull();
    expect(查找快捷键({ ...基, key: "f", keyCode: 229 })).toBeNull();
    expect(查找快捷键({ ...基, key: "f", 在别的输入: true })).toBeNull();
    expect(查找快捷键({ ...基, key: "f", ctrlKey: false })).toBeNull();
  });

  it("查找栏里是选中查询和展开替换，正文里是打开", () => {
    expect(查找快捷键({ ...基, key: "f" })).toBe("查找");
    expect(查找快捷键({ ...基, key: "h" })).toBe("替换");
    expect(查找快捷键({ ...基, key: "F", ctrlKey: false, metaKey: true })).toBe("查找");
    expect(查找快捷键({ ...基, key: "f", 在查找栏: true })).toBe("选中查询");
    expect(查找快捷键({ ...基, key: "h", 在查找栏: true })).toBe("展开替换");
  });
});

describe("查找栏", () => {
  const 挂着: { 拆: () => void }[] = [];
  afterEach(() => {
    for (const o of 挂着) o.拆();
    挂着.length = 0;
  });

  async function 挂(doc: EditDoc, editable: boolean) {
    const 根 = document.createElement("div");
    document.body.append(根);
    const 树 = createRoot(根);
    const 改了: number[] = [];
    const 提示: string[] = [];
    let editor: Editor | null = null;
    const editApi = { current: null } as RefObject<(() => string) | null>;
    await act(async () => {
      树.render(
        createElement(BlockEditor, {
          doc,
          editable,
          onEdit: () => {
            改了.push(1);
          },
          onEditStart: () => {},
          onNotice: (文本: string) => {
            提示.push(文本);
          },
          editApi,
          onEditorChange: (e: Editor | null) => {
            editor = e;
          },
        }),
      );
    });
    const 记 = {
      拆: () => {
        act(() => 树.unmount());
        根.remove();
      },
    };
    挂着.push(记);
    return { 根, 改了, 提示, 取编辑器: () => editor };
  }

  function 按(目标: EventTarget, key: string, 修饰: Partial<KeyboardEventInit> = {}) {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...修饰 });
    目标.dispatchEvent(ev);
    return ev;
  }

  function 填(el: HTMLInputElement | HTMLTextAreaElement, 值: string) {
    const 原型 = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const 设 = Object.getOwnPropertyDescriptor(原型, "value")!.set!;
    设.call(el, 值);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("Ctrl+F 打开，跳转不标未保存，全部替换是一笔", async () => {
    const doc = 篇([块({ content: "甲乙甲" })]);
    const { 根, 改了, 提示, 取编辑器 } = await 挂(doc, true);
    const editor = 取编辑器();
    expect(editor).not.toBeNull();
    await act(async () => {
      editor!.commands.setTextSelection({ from: 1, to: 2 });
      按(editor!.view.dom, "f", { ctrlKey: true });
    });
    const 查询 = 根.querySelector('input[aria-label="查找"]') as HTMLInputElement | null;
    expect(查询?.value).toBe("甲");
    expect(根.querySelector(".find-count")?.textContent).toBe("1/2");
    expect(根.querySelectorAll(".find-hit").length).toBe(2);
    expect(改了).toHaveLength(0);

    await act(async () => {
      按(查询!, "Enter");
    });
    expect(根.querySelector(".find-count")?.textContent).toBe("2/2");
    expect(改了).toHaveLength(0);
    expect(document.activeElement).toBe(查询);

    await act(async () => {
      按(查询!, "h", { ctrlKey: true });
    });
    const 替换 = 根.querySelector('[aria-label="替换为"]') as HTMLTextAreaElement;
    expect(替换).not.toBeNull();
    await act(async () => {
      填(替换, "丙");
    });
    const 全部 = [...根.querySelectorAll("button")].find((b) => b.textContent === "全部替换")!;
    await act(async () => {
      全部.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(取编辑器()!.state.doc.textContent).toBe("丙乙丙");
    expect(提示).toContain("已替换 2 处");
    expect(改了).toHaveLength(1);
    await act(async () => {
      expect(undo(取编辑器()!.state, (t) => 取编辑器()!.view.dispatch(t))).toBe(true);
    });
    expect(docToMarkdown(取编辑器()!.state.doc, doc)).toBe("甲乙甲\n");
  });

  it("下一处不重新全选查找词；按钮上的 Enter 不连跳；Esc 把焦点交回正文", async () => {
    const { 根, 取编辑器 } = await 挂(篇([块({ content: "甲乙甲" })]), true);
    const editor = 取编辑器()!;
    await act(async () => {
      按(editor.view.dom, "f", { ctrlKey: true, repeat: true });
    });
    expect(根.querySelector(".find-bar")).toBeNull();
    await act(async () => {
      按(editor.view.dom, "f", { ctrlKey: true });
    });
    const 查询 = 根.querySelector('input[aria-label="查找"]') as HTMLInputElement;
    await act(async () => {
      填(查询, "甲");
    });
    查询.setSelectionRange(1, 1);
    await act(async () => {
      按(查询, "Enter");
    });
    expect(根.querySelector(".find-count")?.textContent).toBe("2/2");
    expect(查询.selectionStart).toBe(1);
    expect(查询.selectionEnd).toBe(1);

    const 下一 = 根.querySelector('button[aria-label="下一处"]') as HTMLButtonElement;
    await act(async () => {
      按(下一, "Enter");
    });
    expect(根.querySelector(".find-count")?.textContent).toBe("2/2");

    await act(async () => {
      按(查询, "Escape");
    });
    expect(editor.view.hasFocus()).toBe(true);
    expect(根.querySelector(".find-bar")).toBeNull();
  });

  it("组字结束才搜索；替换串里的换行会提示", async () => {
    const { 根, 提示, 取编辑器 } = await 挂(篇([块({ content: "甲乙" })]), true);
    const editor = 取编辑器()!;
    await act(async () => {
      按(editor.view.dom, "f", { ctrlKey: true });
    });
    const 查询 = 根.querySelector('input[aria-label="查找"]') as HTMLInputElement;
    await act(async () => {
      查询.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      填(查询, "甲");
    });
    expect(根.querySelector(".find-hit")).toBeNull();
    expect(根.querySelector(".find-count")?.textContent).toBe("");
    await act(async () => {
      查询.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect(根.querySelectorAll(".find-hit").length).toBe(1);

    await act(async () => {
      按(查询, "h", { ctrlKey: true });
    });
    const 替换 = 根.querySelector('[aria-label="替换为"]') as HTMLTextAreaElement;
    await act(async () => {
      填(替换, "丙\n丁");
    });
    await act(async () => {
      按(替换, "Enter");
    });
    expect(提示.at(-1)).toBe("替换内容里不能有换行");
    expect(editor.state.doc.textContent).toBe("甲乙");
  });

  it("浏览态可以找，不能换", async () => {
    const { 根, 提示, 取编辑器 } = await 挂(篇([块({ content: "甲" })]), false);
    const editor = 取编辑器()!;
    await act(async () => {
      按(editor.view.dom, "h", { ctrlKey: true });
    });
    const 替换 = 根.querySelector('[aria-label="替换为"]') as HTMLTextAreaElement;
    await act(async () => {
      填(根.querySelector('input[aria-label="查找"]') as HTMLInputElement, "甲");
      填(替换, "乙");
      按(替换, "Enter");
    });
    expect(提示.at(-1)).toBe("现在是浏览，不能替换");
    expect(editor.state.doc.textContent).toBe("甲");
    expect(editor.isEditable).toBe(false);
    const 替换钮 = [...根.querySelectorAll("button")].find((b) => b.textContent === "替换");
    expect(替换钮?.hasAttribute("disabled")).toBe(true);
  });

  it("别的输入框里的 Ctrl+F 不打开本文查找", async () => {
    const { 根 } = await 挂(篇([块({ content: "甲" })]), true);
    const 旁 = document.createElement("input");
    document.body.append(旁);
    旁.focus();
    await act(async () => {
      按(旁, "f", { ctrlKey: true });
    });
    expect(根.querySelector(".find-bar")).toBeNull();
    旁.remove();
  });
});
