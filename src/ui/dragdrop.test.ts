import { describe, expect, it } from "vitest";
import { 判落点, 算动作, 重排, type 行 } from "./dragdrop";

/**
 * 拖拽的全部难点都在边角：缝隙算给哪一层、目录行的中间带才算"移进去"、
 * 目录在档 2 里不许换父。这些都得在没有 DOM 的地方钉住。
 */
const 高 = 40;

const 目录行 = (路径: string): 行 => {
  const 段 = 路径.split("/");
  const 名 = 段.pop() ?? 路径;
  return { 键: `d:${路径}`, 父: 段.join("/"), 名, 是目录: true, 自身: 路径 };
};

const 笔记行 = (rel: string): 行 => {
  const 段 = rel.split("/");
  const 名 = 段.pop() ?? rel;
  return { 键: `n:${rel}`, 父: 段.join("/"), 名, 是目录: false, 自身: rel };
};

/** 库里现有的层：拖之前 notes 是甲乙丙，inbox 只有丁 */
const 现有: Record<string, string[]> = {
  "": ["notes", "inbox"],
  notes: ["甲.md", "乙.md", "丙.md"],
  inbox: ["丁.md"],
  "notes/工作": ["一.md"],
};
/** notes 与库根被用户排过；工作/归档那两层没有自己的 [[order]] 条目 */
const 存过的 = new Set(["", "notes"]);
const 读层 = (父: string) => ({ 序列: 现有[父] ?? [], 存过: 存过的.has(父) });

describe("缝隙归谁", () => {
  it("落在某行上沿 = 插到它前面", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 落 = 判落点(被拖, 笔记行("notes/丙.md"), null, 5, 高);
    expect(落).toEqual({ kind: "gap", 父: "notes", 前: "丙.md" });
  });

  it("落在某行下沿 = 插到它后面，也就是下一行前面", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 落 = 判落点(被拖, 笔记行("notes/乙.md"), 笔记行("notes/丙.md"), 38, 高);
    expect(落).toEqual({ kind: "gap", 父: "notes", 前: "丙.md" });
  });

  it("落在最后一行下沿 = 这一层末尾", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 落 = 判落点(被拖, 笔记行("notes/丙.md"), null, 39, 高);
    expect(落).toEqual({ kind: "gap", 父: "notes", 前: null });
  });

  it("目录行与它的第一个孩子之间那条缝，算进那个目录里", () => {
    const 被拖 = 笔记行("inbox/丁.md");
    const 落 = 判落点(被拖, 目录行("notes"), 笔记行("notes/甲.md"), 39, 高);
    expect(落).toEqual({ kind: "gap", 父: "notes", 前: "甲.md" });
  });
});

describe("目录行的中间带才是移进去", () => {
  it("笔记落在目录行正中 = 移进那个目录，且排在最前面", () => {
    const 被拖 = 笔记行("inbox/丁.md");
    const 落 = 判落点(被拖, 目录行("notes"), 笔记行("notes/甲.md"), 20, 高);
    expect(落).toEqual({ kind: "into", 目录: "notes" });
    // inbox 从没被自定义过，所以只写目标层：源层不该被一次"拖走一篇"顺手固化成名单
    expect(算动作(被拖, 落, 读层)).toEqual({
      类型: "移动",
      新路径: "notes/丁.md",
      层: [{ parent: "notes", names: ["丁.md", "甲.md", "乙.md", "丙.md"] }],
    });
  });

  it("源层排过序时才跟着改：它得少掉那一篇，否则名单里留着幽灵", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 作 = 算动作(被拖, { kind: "into", 目录: "inbox" }, 读层);
    expect(作 && 作.类型 === "移动" && 作.层).toEqual([
      { parent: "notes", names: ["乙.md", "丙.md"] },
      { parent: "inbox", names: ["甲.md", "丁.md"] },
    ]);
  });

  it("笔记落在自己所在目录的行上 = 不是移进去，是按上沿/下沿算同级或跨层", () => {
    const 被拖 = 笔记行("notes/甲.md");
    // 上沿：插到 notes 这个目录之前，也就是把这篇挪到库根
    expect(判落点(被拖, 目录行("notes"), 笔记行("notes/乙.md"), 2, 高)).toEqual({
      kind: "gap",
      父: "",
      前: "notes",
    });
    // 中间带：既然"移进自己所在的目录"没有意义，就退回按上下沿算。甲本来就排在乙前面，
    // 所以这一落最终什么也不写（下面那行断言）
    const 中 = 判落点(被拖, 目录行("notes"), 笔记行("notes/乙.md"), 20, 高);
    expect(中).toEqual({ kind: "gap", 父: "notes", 前: "乙.md" });
    expect(算动作(被拖, 中, 读层)).toBeNull();
  });

  it("目录不能移进别的目录（那是下一档的事），也不能换父", () => {
    const 被拖 = 目录行("notes/工作");
    expect(判落点(被拖, 目录行("inbox"), null, 20, 高)).toBeNull();
    expect(判落点(被拖, 笔记行("inbox/丁.md"), null, 5, 高)).toBeNull();
    // 同级里可以重排
    expect(判落点(被拖, 目录行("notes/生活"), null, 5, 高)).toEqual({
      kind: "gap",
      父: "notes",
      前: "生活",
    });
  });
});

describe("算动作", () => {
  it("同级重排只写一层", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 作 = 算动作(被拖, { kind: "gap", 父: "notes", 前: "丙.md" }, 读层);
    expect(作).toEqual({
      类型: "重排",
      层: { parent: "notes", names: ["乙.md", "甲.md", "丙.md"] },
    });
  });

  it("位置没变就不产生动作：一次无事的拖拽不该落盘", () => {
    const 被拖 = 笔记行("notes/甲.md");
    // 甲本来就紧排在乙前面
    expect(算动作(被拖, { kind: "gap", 父: "notes", 前: "乙.md" }, 读层)).toBeNull();
    // 落到自己那一行上（App 会先排除，这里再钉一层）
    expect(判落点(被拖, 笔记行("notes/甲.md"), 笔记行("notes/乙.md"), 5, 高)).toBeNull();
  });

  it("跨层那一跳同时改两层：源层少掉它，目标层多出它", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 作 = 算动作(被拖, { kind: "gap", 父: "notes/工作", 前: "一.md" }, 读层);
    expect(作).toEqual({
      类型: "移动",
      新路径: "notes/工作/甲.md",
      层: [
        { parent: "notes", names: ["乙.md", "丙.md"] },
        { parent: "notes/工作", names: ["甲.md", "一.md"] },
      ],
    });
  });

  it("挪到库根就是不带目录前缀的路径", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 作 = 算动作(被拖, { kind: "gap", 父: "", 前: "inbox" }, 读层);
    expect(作 && 作.类型 === "移动" && 作.新路径).toBe("甲.md");
  });

  it("空层也接得住：目标层原来没人", () => {
    const 被拖 = 笔记行("notes/甲.md");
    const 作 = 算动作(被拖, { kind: "into", 目录: "archive" }, 读层);
    expect(作 && 作.类型 === "移动" && 作.层).toEqual([
      { parent: "notes", names: ["乙.md", "丙.md"] },
      { parent: "archive", names: ["甲.md"] },
    ]);
  });

  it("落点为 null 就没有动作", () => {
    expect(算动作(笔记行("notes/甲.md"), null, 读层)).toBeNull();
  });
});

describe("重排", () => {
  it("摘掉再插回指定位置前", () => {
    expect(重排(["甲", "乙", "丙"], "丙", "甲")).toEqual(["丙", "甲", "乙"]);
    expect(重排(["甲", "乙", "丙"], "甲", null)).toEqual(["乙", "丙", "甲"]);
  });

  it("目标名字不在这一层（并发下别人改过）就落到末尾而不是丢条目", () => {
    expect(重排(["甲", "乙"], "甲", "不在了")).toEqual(["乙", "甲"]);
  });

  it("被拖的本就在末尾且要求插到末尾 = 序列不变", () => {
    expect(重排(["甲", "乙"], "乙", null)).toEqual(["甲", "乙"]);
  });
});
