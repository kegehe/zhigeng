import { describe, expect, it } from "vitest";
import {
  buildTree,
  flatten,
  dirsOf,
  层内名字,
  合并层,
  type Branch,
  type DirBranch,
} from "./tree";

/** 侧栏目录树是纯函数：给 rel 序列，出来的次序 / 深度 / 折叠行为都得钉住 */
const 篇 = (rel: string, updatedMs: number, title = "") => ({ rel, title, updatedMs });
const 标签 = (b: Branch) => (b.kind === "dir" ? `${b.name}(${b.notes})` : b.title);
/** 按路径找目录节点（递归：测试关心的是"这一层的篇数怎么算"，不是它在第几层） */
const 目录 = (分支们: Branch[], path: string): DirBranch | undefined => {
  for (const b of 分支们) {
    if (b.kind !== "dir") continue;
    if (b.path === path) return b;
    const 下 = 目录(b.children, path);
    if (下) return 下;
  }
  return undefined;
};
const 形状 = (分支们: Branch[]): string[] =>
  分支们.flatMap((b) => [
    "  ".repeat(b.depth) + 标签(b) + (b.kind === "note" ? `@${b.ms}` : ""),
    ...(b.kind === "dir" ? 形状(b.children) : []),
  ]);

describe("目录树的形状", () => {
  const 树 = buildTree([
    篇("2026-09-28-库根散记.md", 5),
    篇("notes/甲.md", 10),
    篇("notes/ai-native/检索策略.md", 20),
    篇("notes/ai-native/子层/深一层.md", 30),
    篇("inbox/standup.md", 40),
    篇("archive/旧事.md", 50),
    篇("reading/文章标题.md", 60),
  ]);

  it("顶层三条有语义的在前，用户目录在后，库根散文件不被藏起来", () => {
    expect(树.map(标签)).toEqual([
      "笔记(3)",
      "收件箱(1)",
      "归档(1)",
      "reading(1)",
      "2026-09-28-库根散记",
    ]);
  });

  it("深度按目录层级算，每一层里子目录排在笔记前面", () => {
    expect(形状(树)).toEqual([
      "笔记(3)",
      "  ai-native(2)",
      "    子层(1)",
      "      深一层@30",
      "    检索策略@20",
      "  甲@10",
      "收件箱(1)",
      "  standup@40",
      "归档(1)",
      "  旧事@50",
      "reading(1)",
      "  文章标题@60",
      "2026-09-28-库根散记@5",
    ]);
  });

  it("折叠行的篇数算的是整棵子树，不是直接子项", () => {
    const 笔记 = 目录(树, "notes")!;
    expect(笔记.notes).toBe(3);
    expect(目录(树, "notes/ai-native")!.notes).toBe(2);
    expect(目录(树, "notes/ai-native/子层")!.notes).toBe(1);
  });

  it("同一层里笔记按更新时间倒序，标题为空退回文件名", () => {
    const 树 = buildTree([篇("notes/早.md", 1, "早写的"), 篇("notes/晚.md", 9), 篇("notes/中.md", 5)]);
    const 笔记目录 = 树[0] as Extract<Branch, { kind: "dir" }>;
    expect(笔记目录.children.map((c) => (c.kind === "note" ? c.title : "?"))).toEqual([
      "晚",
      "中",
      "早写的",
    ]);
  });
});

describe("折叠与展平", () => {
  const 树 = buildTree([
    篇("notes/a/一.md", 1),
    篇("notes/a/二.md", 2),
    篇("notes/b/三.md", 3),
    篇("inbox/四.md", 4),
  ]);

  it("什么都不折叠时，每一层都出现", () => {
    expect(flatten(树, new Set()).map((b) => "  ".repeat(b.depth) + 标签(b))).toEqual([
      "笔记(3)",
      "  a(2)",
      "    二",
      "    一",
      "  b(1)",
      "    三",
      "收件箱(1)",
      "  四",
    ]);
  });

  it("折叠一个目录只留它自己那一行，折叠父目录连子目录一起收掉", () => {
    const 只收子 = flatten(树, new Set(["notes/a"])).map((b) => 标签(b));
    expect(只收子).toEqual(["笔记(3)", "a(2)", "b(1)", "三", "收件箱(1)", "四"]);
    expect(flatten(树, new Set(["notes"])).map((b) => 标签(b))).toEqual([
      "笔记(3)",
      "收件箱(1)",
      "四",
    ]);
  });

  it("深度是展平后渲染要用的缩进，折叠不改别人的深度", () => {
    const 行 = flatten(树, new Set(["notes/a"]));
    expect(行.map((b) => b.depth)).toEqual([0, 1, 1, 2, 0, 1]);
  });
});

describe("自定义顺序（.note/tree.toml 那一套）", () => {
  const 行们 = () => [
    篇("notes/甲.md", 10),
    篇("notes/乙.md", 20),
    篇("notes/丙.md", 30),
    篇("notes/工作/一.md", 40),
    篇("inbox/丁.md", 50),
  ];

  it("不传顺序时与默认规则一模一样（回归的底线）", () => {
    expect(形状(buildTree(行们()))).toEqual([
      "笔记(4)",
      "  工作(1)",
      "    一@40",
      "  丙@30",
      "  乙@20",
      "  甲@10",
      "收件箱(1)",
      "  丁@50",
    ]);
  });

  it("排过的按排的顺序，没排过的跟在后面", () => {
    const 树 = buildTree(行们(), [{ parent: "notes", names: ["甲.md", "丙.md"] }]);
    expect(层内名字(树, "notes")).toEqual(["甲.md", "丙.md", "工作", "乙.md"]);
  });

  it("排过的笔记可以越过没排过的目录——用户拖了就该压过默认那条界", () => {
    const 树 = buildTree(行们(), [{ parent: "notes", names: ["甲.md"] }]);
    expect(形状(树).slice(1, 5)).toEqual(["  甲@10", "  工作(1)", "    一@40", "  丙@30"]);
  });

  it("顶层拖过之后 pinned 三条退成默认序而不是铁序", () => {
    const 树 = buildTree(行们(), [{ parent: "", names: ["inbox", "notes"] }]);
    expect(树.map(标签)).toEqual(["收件箱(1)", "笔记(4)"]);
  });

  it("库里没有的名字留在文件里也不占位（改名拖剩的旧条目）", () => {
    const 树 = buildTree(行们(), [
      { parent: "notes", names: ["已删.md", "丙.md", "甲.md"] },
    ]);
    expect(层内名字(树, "notes")).toEqual(["丙.md", "甲.md", "工作", "乙.md"]);
  });

  it("反斜杠的 parent 与正斜杠认成同一层", () => {
    const 树 = buildTree([篇("notes/工作/一.md", 1), 篇("notes/工作/二.md", 2)], [
      { parent: "notes\\工作", names: ["二.md", "一.md"] },
    ]);
    expect(形状(树)).toEqual(["笔记(2)", "  工作(2)", "    二@2", "    一@1"]);
  });

  it("层内名字取不到那一层时给空数组，不炸", () => {
    const 树 = buildTree(行们());
    expect(层内名字(树, "不存在")).toEqual([]);
    expect(层内名字(树, "")).toEqual(["notes", "inbox"]);
  });

  it("同一层手改存重了，以第一条为准（与 Rust 侧合并重复的规矩一致）", () => {
    const 树 = buildTree(行们(), [
      { parent: "notes", names: ["丙.md"] },
      { parent: "notes", names: ["甲.md"] },
    ]);
    expect(层内名字(树, "notes")).toEqual(["丙.md", "工作", "乙.md", "甲.md"]);
  });

  it("合并层按父路径整条替换，空序列把那条删掉（与 Rust 侧同一条语义）", () => {
    const 现状 = [
      { parent: "notes", names: ["甲.md"] },
      { parent: "inbox", names: ["丁.md"] },
    ];
    expect(
      合并层(现状, [
        { parent: "notes", names: ["乙.md", "甲.md"] },
        { parent: "inbox", names: [] },
      ])
    ).toEqual([{ parent: "notes", names: ["乙.md", "甲.md"] }]);
  });
});

describe("dirsOf", () => {  it("某篇所在的整条目录链（用于把它的路径展开出来）", () => {
    expect(dirsOf("notes/ai-native/子层/深一层.md")).toEqual([
      "notes",
      "notes/ai-native",
      "notes/ai-native/子层",
    ]);
    expect(dirsOf("inbox/standup.md")).toEqual(["inbox"]);
    expect(dirsOf("库根.md")).toEqual([]);
  });

  it("反斜杠路径（Windows 侧漏网时）也拆得开", () => {
    expect(dirsOf("notes\\ai-native\\甲.md")).toEqual(["notes", "notes/ai-native"]);
    const 树 = buildTree([篇("notes\\ai-native\\甲.md", 1)]);
    expect(形状(树)).toEqual(["笔记(1)", "  ai-native(1)", "    甲@1"]);
  });
});
