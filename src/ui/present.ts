import type { EditDoc } from "../ipc/types";

/**
 * 演示时要不要在正文前补一个篇名。
 *
 * 很多笔记自己就以一级标题开头，再补一次等于同一句话在屏幕上出现两遍——
 * 那是排版事故，不是"更清楚"。只有第一块不是标题时才补。
 */
export function 要补篇名(doc: EditDoc | null): boolean {
  return !!doc && doc.blocks[0]?.kind !== "heading";
}
