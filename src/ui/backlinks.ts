import type { LinkRow } from "../ipc/types";

/** 反链面板一行的判定。 */
export type 面板判定 = {
  /** 这一行能不能当"打开那一篇笔记"来点 */
  可打开: boolean;
  /** 红色那一档：说的是"目标不在了" */
  标红: boolean;
  /** 行尾那句状态话；null = 不占位 */
  尾注: string | null;
  /** 对方是文件不是笔记。组件靠它决定第二行写路径还是写块内文字，不在 JSX 里重算 */
  是资产: boolean;
  /** 悬空的笔记写法能就地补一篇；新建时用的标题就是 `target` */
  可新建: boolean;
};

/**
 * 把后端算好的事实说成界面上的话。**判"在不在"这件事不在这里**——资产链接的存在性由
 * `note_core::assets::exists` 查盘算出（docs/02 §资产引用格式），在这儿再判一次前缀
 * 就是第二份判据，两份判据早晚分叉。
 *
 * 三条要紧的：
 * 1. **资产行不许点开成一篇笔记**。它没有 `to_note`，而现在 `rel` 装的正是那个文件的
 *    路径——照旧只判 `!rel` 就会给一行二进制挂上"打开笔记"的动作。
 * 2. `[[notes/乙.md]]` 的 `kind` 也是 `asset`（写法里有点），但它 `toNote` 为真，
 *    该照常点开。所以这一档跟着"对方是不是笔记"走，不跟着 kind 走。
 * 3. 附件丢了说"文件丢了"，不说"链空了"：用户写下的不是一个笔记名，那句谎他一眼能看穿。
 */
export function 面板判定(
  l: Pick<LinkRow, "kind" | "rel" | "broken" | "toNote" | "target">,
): 面板判定 {
  const 是资产 = l.kind === "asset" && !l.toNote;
  const 可打开 = !l.broken && !!l.rel && l.toNote;
  /**
   * 悬空的笔记写法可以就地补一篇：`target` 就是用户写下的原文，交给 `note_create`
   * 当标题；索引落地时 `resolve_broken_to` 按标题把这条接回来。
   *
   * **资产不算**：它没有"对方的笔记名"可拿去建，建出来只会是一篇叫 `photo.png`
   * 的空笔记。这和"资产行不许点开成一篇笔记"是同一条口径。
   */
  const 可新建 = l.broken && !l.toNote && !是资产 && l.target.trim().length > 0;
  if (是资产) {
    return { 可打开, 标红: l.broken, 尾注: l.broken ? "文件丢了" : "附件在库内", 是资产, 可新建 };
  }
  return { 可打开, 标红: l.broken, 尾注: l.broken ? "链空了" : null, 是资产, 可新建 };
}
