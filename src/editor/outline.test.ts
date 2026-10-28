import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { createTestEditor } from "./testEditor";
import { activeHeadingOf, outlineKey, outlineOf } from "./outline";
import { OutlinePanel } from "./OutlinePanel";

/**
 * 大纲栏的两层都钉在这里：纯函数层（抽取/活动节判定）直接断言，
 * 组件层挂一个真编辑器，钉"渲染了哪些条目 + 点一条光标真的跳过去"。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function 块(kind: EditBlock["kind"], content: string, level: number | null = null): EditBlock {
  const 前 = kind === "heading" ? "#".repeat(level ?? 1) + " " : "";
  return {
    kind,
    id: null,
    raw: 前 + content + "\n",
    gapBefore: "",
    content,
    level,
    checked: null,
    fields: [],
    children: [],
  };
}

function 篇(...段: EditBlock[]): EditDoc {
  return { frontMatter: "", trailingGap: "", blocks: 段 };
}

const 活的: { 拆: () => void; 拆过: boolean }[] = [];
afterEach(() => {
  for (const o of 活的) if (!o.拆过) o.拆();
  活的.length = 0;
});

describe("outlineOf", () => {
  it("只收前三级的标题，文字剥掉行内标记以外的部分（textContent）", () => {
    const doc = createTestEditor(
      篇(
        块("heading", "开篇", 1),
        块("paragraph", "一段正文"),
        块("heading", "二级细节", 2),
        块("heading", "三级更细", 3),
        块("heading", "四级不进大纲", 4),
        块("heading", "收尾", 1),
      ),
    );
    const 列 = outlineOf(doc.state.doc);
    expect(列.map((i) => [i.level, i.text])).toEqual([
      [1, "开篇"],
      [2, "二级细节"],
      [3, "三级更细"],
      [1, "收尾"],
    ]);
    // pos 单调递增，且第一条正好是第一个块的位置（0）
    expect(列.map((i) => i.pos)).toEqual(列.map((i) => i.pos).sort((a, b) => a - b));
    expect(列[0]?.pos).toBe(0);
  });

  it("没有标题的文档抽出来是空表（面板据此整只不渲染）", () => {
    const doc = createTestEditor(篇(块("paragraph", "只有正文"), 块("bullet", "一条列表", null)));
    expect(outlineOf(doc.state.doc)).toEqual([]);
  });
});

describe("activeHeadingOf", () => {
  const 列 = [
    { pos: 0, level: 1, text: "甲" },
    { pos: 10, level: 2, text: "乙" },
    { pos: 20, level: 1, text: "丙" },
  ];

  it("光标在任何标题之前：一节都不亮", () => {
    expect(activeHeadingOf(列, 0)).toBe(-1);
  });

  it("光标落在某节中间：亮那一节", () => {
    expect(activeHeadingOf(列, 15)).toBe(1);
  });

  it("光标压在标题行上：亮的就是这一行（PM 的文本选区 from ≥ pos+1）", () => {
    expect(activeHeadingOf(列, 11)).toBe(1);
  });

  it("光标越过最后一节：亮最后一节", () => {
    expect(activeHeadingOf(列, 999)).toBe(2);
  });
});

describe("outlineKey", () => {
  it("同一条目表签名一致；pos 平移但标题没变时签名会变（条目要跟着平移）", () => {
    const a = [{ pos: 0, level: 1, text: "甲" }];
    const b = [{ pos: 0, level: 1, text: "甲" }];
    const c = [{ pos: 4, level: 1, text: "甲" }];
    expect(outlineKey(a)).toBe(outlineKey(b));
    expect(outlineKey(a)).not.toBe(outlineKey(c));
  });
});

describe("OutlinePanel（组件）", () => {
  it("渲染条目并按层级缩进；点一条把光标与视口送到那个标题", async () => {
    const doc = createTestEditor(
      篇(块("heading", "第一节", 1), 块("paragraph", "正文"), 块("heading", "第二节", 2)),
    );
    const 根 = document.createElement("div");
    document.body.appendChild(根);
    const 树 = createRoot(根);
    await act(async () => {
      树.render(createElement(OutlinePanel, { editor: doc }));
    });
    const 记 = { 拆过: false, 拆: () => {} } as {
      拆: () => void;
      拆过: boolean;
    };
    记.拆 = () => {
      act(() => 树.unmount());
      根.remove();
      记.拆过 = true;
    };
    活的.push(记);

    // 栏宽是布局契约：w-50（200px，--spacing×50）必须挂在根元素上——
    // 丢了这个类，栏会被最长标题撑开，正文列宽跟着抖
    const 栏 = 根.querySelector<HTMLElement>(".outline-panel");
    expect(栏?.className).toContain("w-50");
    expect(栏?.getAttribute("aria-label")).toBe("大纲");

    const 条目 = [...根.querySelectorAll<HTMLButtonElement>(".outline-item")];
    expect(条目.length).toBe(2);
    expect(条目[0]?.textContent).toBe("第一节");
    // 二级标题的缩进：padding-inline-start = space-2 + space-4 × (level-1)
    expect(条目[1]?.style.paddingInlineStart).toContain("var(--space-4) * 1");

    // 点第二条：光标落进那个标题块（near 从块前边界往块内走一步）
    await act(async () => {
      条目[1]?.click();
    });
    const { $from } = doc.state.selection;
    expect($from.parent.type.name).toBe("mdHeading");
    expect($from.parent.textContent).toBe("第二节");
    // 当前节跟着亮
    expect(条目[1]?.classList.contains("on")).toBe(true);
    expect(条目[0]?.classList.contains("on")).toBe(false);
  });

  it("没有标题时整只不渲染", async () => {
    const doc = createTestEditor(篇(块("paragraph", "光秃秃一段")));
    const 根 = document.createElement("div");
    document.body.appendChild(根);
    const 树 = createRoot(根);
    await act(async () => {
      树.render(createElement(OutlinePanel, { editor: doc }));
    });
    const 记 = { 拆过: false, 拆: () => {} } as {
      拆: () => void;
      拆过: boolean;
    };
    记.拆 = () => {
      act(() => 树.unmount());
      根.remove();
      记.拆过 = true;
    };
    活的.push(记);
    expect(根.querySelector(".outline-panel")).toBeNull();
  });
});
