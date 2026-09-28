import type { ListNotes } from "../ipc/types";

/**
 * 侧栏目录树：从 `list_notes` 的 `rel` 路径推出来，**不另开一条 IPC**。
 *
 * 为什么在前端拼而不是 Rust 侧返回一棵树：库里那份真相就是目录结构（[02] §Vault 目录结构，
 * 归档状态 = 所在目录），`rel` 已经是全部所需信息。多一个后端形状就多一处会与盘上事实
 * 分叉的地方，而这里没有"只有后端知道"的东西。
 *
 * 顶层三条是**有语义的固定序**（[02]：`notes/` 正式、`inbox/` 待整理、`archive/` 归档），
 * 用户自己建的目录排在后面按名字走。库根上直接躺着的 `.md` 不塞进假目录——
 * `is_indexable_rel` 认它，界面就得显示它，藏起来等于让用户以为文件没了。
 */

/** 与 crates/note-core/src/vault.rs 的常量对齐；改那边要改这里 */
const PINNED: { dir: string; 标签: string }[] = [
  { dir: "notes", 标签: "笔记" },
  { dir: "inbox", 标签: "收件箱" },
  { dir: "archive", 标签: "归档" },
];

export type NoteBranch = {
  kind: "note";
  rel: string;
  title: string;
  ms: number;
  depth: number;
};

export type DirBranch = {
  kind: "dir";
  /** 显示名：顶层三条走中文标签，其余是目录本名 */
  name: string;
  /** 从库根算起的路径，折叠态按它记（不受显示名影响） */
  path: string;
  depth: number;
  /** 这底下（含更深层）一共有多少篇——折叠时要在行尾显示 */
  notes: number;
  children: Branch[];
};

export type Branch = DirBranch | NoteBranch;

type 行 = Pick<ListNotes["notes"][number], "rel" | "title" | "updatedMs">;

/** 目录段的中间结构：先攒成 map，再一次性转成 Branch（避免边插边排序） */
type 节点 = { 子目录: Map<string, 节点>; 笔记: 行[]; 篇数: number };

const 名 = (rel: string) => rel.replace(/\\/g, "/").split("/").pop() ?? rel;

function 建节点(行们: 行[]): 节点 {
  const 顶层: 节点 = { 子目录: new Map(), 笔记: [], 篇数: 0 };
  for (const 行 of 行们) {
    const 段 = 行.rel.replace(/\\/g, "/").split("/");
    段.pop(); // 最后一段是文件名
    const 祖先: 节点[] = [];
    let 当前 = 顶层;
    for (const s of 段) {
      let 下 = 当前.子目录.get(s);
      if (!下) {
        下 = { 子目录: new Map(), 笔记: [], 篇数: 0 };
        当前.子目录.set(s, 下);
      }
      祖先.push(下);
      当前 = 下;
    }
    当前.笔记.push(行);
    // 篇数往每一层祖先累加：折叠时行尾那个数字算的是整棵子树
    for (const n of 祖先) n.篇数++;
  }
  return 顶层;
}

function 转成树(当前: 节点, 路径: string, 深度: number, 显示名: (路径: string, 本名: string) => string): Branch[] {
  const 目录 = [...当前.子目录.entries()]
    .sort(([a], [b]) => 序(a, b))
    .map<Branch>(([本名, 子]) => {
      const 全 = 路径 ? `${路径}/${本名}` : 本名;
      return {
        kind: "dir",
        name: 显示名(全, 本名),
        path: 全,
        depth: 深度,
        notes: 子.篇数,
        children: 转成树(子, 全, 深度 + 1, 显示名),
      };
    });
  const 笔记 = [...当前.笔记]
    .sort((a, b) => b.updatedMs - a.updatedMs || 序(名(a.rel), 名(b.rel)))
    .map<Branch>((n) => ({
      kind: "note",
      rel: n.rel,
      title: n.title || 名(n.rel).replace(/\.md$/, ""),
      ms: n.updatedMs,
      depth: 深度,
    }));
  return [...目录, ...笔记];
}

/** 目录名按中文习惯排；同一层里目录永远在笔记前面（Notion / Obsidian 都是这个次序） */
function 序(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN") || (a < b ? -1 : a > b ? 1 : 0);
}

const 顶层显示名 = (路径: string, 本名: string) =>
  路径 === 本名 ? PINNED.find((p) => p.dir === 本名)?.标签 ?? 本名 : 本名;

export function buildTree(行们: 行[]): Branch[] {
  const 全部 = 转成树(建节点(行们), "", 0, 顶层显示名);
  // 顶层：三条有语义的在前，其余目录按名，散文件按更新时间
  const 位次 = (b: Branch) => {
    if (b.kind !== "dir") return PINNED.length;
    const 序 = PINNED.findIndex((p) => p.dir === b.path);
    return 序 < 0 ? PINNED.length : 序; // 用户自建目录不配插队，也不许排到最前
  };
  return [...全部].sort((a, b) => {
    const [甲, 乙] = [位次(a), 位次(b)];
    if (甲 !== 乙) return 甲 - 乙;
    if (a.kind === "dir" && b.kind === "dir") return a.path === b.path ? 0 : 序(a.name, b.name);
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (a.kind === "note" && b.kind === "note") return b.ms - a.ms;
    return 0;
  });
}

/**
 * 按折叠态展平。折叠的目录只留自己那一行（行尾带整棵子树的篇数）。
 *
 * 展平而不是递归渲染 JSX：侧栏一次要画到 300 篇（`list_notes` 的上限），
 * 一层递归组件树换来的是每次折叠都要重建整片 React 子树。
 */
export function flatten(树: Branch[], 折叠: ReadonlySet<string>): Branch[] {
  const 出: Branch[] = [];
  const 走 = (分支们: Branch[]) => {
    for (const b of 分支们) {
      出.push(b);
      if (b.kind === "dir" && !折叠.has(b.path)) 走(b.children);
    }
  };
  走(树);
  return 出;
}

/** 某篇所在的整条目录链，用于"新建/打开之后把它那条路径展开出来" */
export function dirsOf(rel: string): string[] {
  const 段 = rel.replace(/\\/g, "/").split("/");
  段.pop();
  const 出: string[] = [];
  let 路径 = "";
  for (const s of 段) {
    路径 = 路径 ? `${路径}/${s}` : s;
    出.push(路径);
  }
  return 出;
}
