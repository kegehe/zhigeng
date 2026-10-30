import { describe, expect, it } from "vitest";
import {
  目录菜单,
  笔记菜单,
  空白菜单,
  菜单坐标,
  是语义顶层,
  type 菜单项,
} from "./tree-menu";
import type { DirBranch } from "./tree";

const 目 = (path: string, depth = 0): DirBranch => ({
  kind: "dir",
  name: path,
  path,
  depth,
  notes: 0,
  children: [],
});

/** 只看动作的名字，提示单独断言——多半条测试里字不重要，**有没有那一项**才重要 */
const 键 = (项: 菜单项[]) => 项.flatMap((i) => (i.类 === "动作" ? [i.键] : []));

describe("目录菜单", () => {
  it("语义顶层三条能建东西，但不给改名/删除（哪怕是空的）", () => {
    for (const 路径 of ["notes", "inbox", "archive", "Notes"]) {
      const 项 = 目录菜单(目(路径, 0), true);
      expect(键(项)).toEqual(["建子目录", "建笔记"]);
    }
  });

  it("空目录给改名与删除，删除是危险项", () => {
    const 项 = 目录菜单(目("notes/草稿", 1), true);
    expect(键(项)).toEqual(["建子目录", "建笔记", "改名目录", "删空目录"]);
    expect(项.at(-1)).toMatchObject({ 键: "删空目录", 危险: true });
  });

  it("非空目录不给改删，只说一句为什么", () => {
    const 项 = 目录菜单(目("notes/草稿", 1), false);
    expect(键(项)).toEqual(["建子目录", "建笔记"]);
    expect(项.at(-1)).toMatchObject({ 类: "提示" });
  });

  it("还在问后端（空=null）时两样都不给——不猜", () => {
    expect(键(目录菜单(目("notes/草稿", 1), null))).toEqual(["建子目录", "建笔记"]);
  });
});

describe("笔记菜单", () => {
  it("普通笔记给打开/改名/归档/回收，回收是危险项且在最后", () => {
    const 项 = 笔记菜单("notes/甲.md");
    expect(键(项)).toEqual(["打开", "改名笔记", "归档", "回收"]);
    expect(项.at(-1)).toMatchObject({ 键: "回收", 危险: true });
  });

  it("已经在归档里的笔记，那一项变成取消归档", () => {
    const 项 = 笔记菜单("archive/旧事.md");
    expect(键(项)).toContain("取消归档");
    expect(键(项)).not.toContain("归档");
    expect(项.find((i) => i.类 === "动作" && i.键 === "取消归档")).toMatchObject({
      字样: "取消归档",
    });
  });

  it("反斜杠路径也认得出归档", () => {
    expect(键(笔记菜单("archive\\旧事.md"))).toContain("取消归档");
  });
});

describe("空白处的菜单", () => {
  it("只给两条建东西的入口", () => {
    expect(键(空白菜单())).toEqual(["顶层建笔记", "顶层建目录"]);
  });
});

describe("菜单坐标", () => {
  const 视口 = { 宽: 1200, 高: 800 };

  it("摆得下就落在指针上", () => {
    expect(菜单坐标({ x: 100, y: 200 }, 视口)).toEqual({ left: 100, top: 200 });
  });

  it("贴着右下角时往回收，不出一截在窗口外", () => {
    expect(菜单坐标({ x: 1190, y: 790 }, 视口, { 宽: 176, 高: 240 })).toEqual({
      left: 1024,
      top: 560,
    });
  });

  it("窗口比菜单还小时停在左上角而不是负数", () => {
    expect(菜单坐标({ x: 10, y: 10 }, { 宽: 100, 高: 100 }, { 宽: 176, 高: 240 })).toEqual({
      left: 0,
      top: 0,
    });
  });
});

describe("是语义顶层", () => {
  it("只认库根那三条，子目录同名不算", () => {
    expect(是语义顶层(目("notes", 0))).toBe(true);
    expect(是语义顶层(目("notes/notes", 1))).toBe(false);
  });
});
