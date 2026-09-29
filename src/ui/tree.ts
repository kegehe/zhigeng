import type { ListNotes, SiblingOrder } from "../ipc/types";

/**
 * 侧栏目录树：从 `list_notes` 的 `rel` 路径推出来，**不另开一条 IPC 拿树**。
 *
 * 为什么在前端拼而不是 Rust 侧返回一棵树：库里那份真相就是目录结构（[02] §Vault 目录结构，
 * 归档状态 = 所在目录），`rel` 已经是全部所需信息。多一个后端形状就多一处会与盘上事实
 * 分叉的地方，而这里没有"只有后端知道"的东西。
 *
 * 顶层三条是**有语义的默认序**（[02]：`notes/` 正式、`inbox/` 待整理、`archive/` 归档），
 * 用户自己建的目录排在后面按名字走。库根上直接躺着的 `.md` 不塞进假目录——
 * `is_indexable_rel` 认它，界面就得显示它，藏起来等于让用户以为文件没了。
 *
 * 传入 `顺序`（`.note/tree.toml` 里那些层）时，**用户排过的条目优先于以上全部默认规则**：
 * 同层里排过的按排的顺序、可以跨目录/笔记的界，没排过的沿用默认规则跟在后面。
 * 默认序降级为"没拖过时长什么样"，而不是"不许拖成什么样"。
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

/** 目录段落的中间结构：先攒成 map，再一次性转成 Branch（避免边插边排序） */
type 节点 = { 子目录: Map<string, 节点>; 笔记: 行[]; 篇数: number };

const 名 = (rel: string) => rel.replace(/\\/g, "/").split("/").pop() ?? rel;

/** 父路径统一成正斜杠、无首尾斜杠。库根是空串 */
const 归一父 = (p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** 某一行（目录路径 / 笔记 rel）落在哪一层。库根上的条目父路径是空串 */
export const parentOf = (p: string) => {
  const 段 = 归一父(p).split("/");
  段.pop();
  return 段.join("/");
};

/** 条目在自己那层里的名字：目录用路径末段（不是显示名，顶层那三条显示成中文） */
export const 层名 = (b: Branch) => (b.kind === "dir" ? 名(b.path) : 名(b.rel));

/** 父目录 → (条目名 → 第几个)。同一层存重了以**第一条**为准（与 Rust 侧合并重复条目的规矩一致） */
type 位次表 = Map<string, Map<string, number>>;

function 建位次表(顺序: readonly SiblingOrder[]): 位次表 {
  const 表: 位次表 = new Map();
  for (const 条 of 顺序) {
    const 键 = 归一父(条.parent);
    if (表.has(键)) continue;
    const 层 = new Map<string, number>();
    条.names.forEach((名, 位) => {
      if (!层.has(名)) 层.set(名, 位);
    });
    表.set(键, 层);
  }
  return 表;
}

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

function 转成树(
  当前: 节点,
  路径: string,
  深度: number,
  显示名: (路径: string, 本名: string) => string,
  位次: 位次表
): Branch[] {
  const 目录 = [...当前.子目录.entries()].map<Branch>(([本名, 子]) => {
    const 全 = 路径 ? `${路径}/${本名}` : 本名;
    return {
      kind: "dir",
      name: 显示名(全, 本名),
      path: 全,
      depth: 深度,
      notes: 子.篇数,
      children: 转成树(子, 全, 深度 + 1, 显示名, 位次),
    };
  });
  const 笔记 = [...当前.笔记].map<Branch>((n) => ({
    kind: "note",
    rel: n.rel,
    title: n.title || 名(n.rel).replace(/\.md$/, ""),
    ms: n.updatedMs,
    depth: 深度,
  }));
  return [...目录, ...笔记].sort(同层比较(路径, 位次, 路径 === ""));
}

/**
 * 一层的比较器。三条规矩，按优先级：
 * 1. 用户排过的条目优先，且**可以跨"目录/笔记"那道界**——拖拽的意义就是让人说了算；
 *    排过的排在没排过的前面，两个都排过按位次。
 * 2. 都没排过时：目录在笔记前面（Notion / Obsidian 都是这个次序）。
 * 3. 同为目录按名字，同为笔记按更新时间倒序；顶层那三条 pinned 目录再往前插。
 */
function 同层比较(父: string, 位次: 位次表, 顶层: boolean) {
  const 层 = 位次.get(父);
  const 类 = (b: Branch) => (b.kind === "dir" ? 0 : 1);
  const 默认档 = (b: Branch) => {
    if (!顶层 || b.kind !== "dir") return 0;
    const 序 = PINNED.findIndex((p) => p.dir === b.path);
    return 序 < 0 ? PINNED.length : 序; // 用户自建目录不配插队
  };
  return (a: Branch, b: Branch): number => {
    const [甲, 乙] = [层?.get(层名(a)), 层?.get(层名(b))];
    if (甲 !== undefined || 乙 !== undefined) {
      if (甲 === undefined) return 1;
      if (乙 === undefined) return -1;
      return 甲 - 乙 || 序(层名(a), 层名(b));
    }
    if (类(a) !== 类(b)) return 类(a) - 类(b);
    if (默认档(a) !== 默认档(b)) return 默认档(a) - 默认档(b);
    if (a.kind === "dir" && b.kind === "dir") return 序(层名(a), 层名(b));
    if (a.kind === "note" && b.kind === "note") return b.ms - a.ms || 序(层名(a), 层名(b));
    return 0;
  };
}

/** 目录名按中文习惯排。非 ASCII 时 localeCompare 给不出稳定序，再退到码位 */
function 序(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN") || (a < b ? -1 : a > b ? 1 : 0);
}

const 顶层显示名 = (路径: string, 本名: string) =>
  路径 === 本名 ? PINNED.find((p) => p.dir === 本名)?.标签 ?? 本名 : 本名;

export function buildTree(行们: 行[], 顺序: readonly SiblingOrder[] = []): Branch[] {
  return 转成树(建节点(行们), "", 0, 顶层显示名, 建位次表(顺序));
}

/**
 * 把改动过的几层合并进现有顺序表：按父路径**整条替换**，空序列等于删掉那条
 * （与 Rust 侧 `tree_order::save` 同一条语义，两边不一致会让界面与盘上分叉）。
 */
export function 合并层(
  现状: readonly SiblingOrder[],
  改动: readonly SiblingOrder[]
): SiblingOrder[] {
  const 留 = 现状.filter((条) => !改动.some((n) => n.parent === 条.parent));
  return [...留, ...改动.filter((条) => 条.names.length > 0)];
}

/**
 * 某一层的现有顺序。拖一次要写的是**整层的全序列**（[tree_order.rs] 的口径），
 * 所以落点算出来之后得先读回整层现在长什么样。
 * 找不到那个父目录就返回空数组——那通常意味着这一层刚被拖空或还没建出来。
 */
export function 层内名字(树: Branch[], 父: string): string[] {
  const 段 = 归一父(父).split("/").filter(Boolean);
  let 当前 = 树;
  for (const s of 段) {
    const 下 = 当前.find((b): b is DirBranch => b.kind === "dir" && 层名(b) === s);
    if (!下) return [];
    当前 = 下.children;
  }
  return 当前.map(层名);
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
