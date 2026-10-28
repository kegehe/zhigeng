import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * 大纲栏（布局三）的**纯函数层**：从活文档里抽标题、算"当前在哪一节"。
 *
 * 单独一个文件而不是塞进组件里，理由与 `src/ui/dragdrop.ts` 同一条——
 * 不碰 DOM 也不碰 React 才测得到：标题抽取、活动节判定都是文档结构上的纯计算，
 * jsdom 里造一个真编辑器（`testEditor.ts` 那条路）就能端到端钉住。
 */

export type OutlineItem = {
  /** 标题块在文档里的起点位置（`doc.forEach` 的 offset，即块前边界） */
  pos: number;
  /** 标题层级 1–3（大纲只收前三级，与 .prose-note h1–h3 的字阶对应） */
  level: number;
  /** 标题文字（textContent，行内标记剥掉——大纲要的是"这一节叫什么"） */
  text: string;
};

/**
 * 抽一篇的大纲。只认 `mdHeading` 且 `mdLevel ≤ 3`：四到六级在正文里是细节，
 * 摆进 200px 的栏里只会剩下一排省略号，导航价值撑不起它占的宽度。
 *
 * 用 `doc.forEach` 只走**顶层**块：标题本来就该在顶层（md-kernel 的容器模型里
 * 引用/表格才是"不透明块"），往深处走反而会把列表里 `#` 开头的段落误收进来。
 */
export function outlineOf(doc: PMNode, maxLevel = 3): OutlineItem[] {
  const 出: OutlineItem[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== "mdHeading") return;
    const level = Math.min(6, Math.max(1, Number(node.attrs.mdLevel ?? 1)));
    if (level > maxLevel) return;
    出.push({ pos: offset, level, text: node.textContent });
  });
  return 出;
}

/**
 * 光标落在哪一节：`from` 之前最近的一个标题。任何标题之前（文档开头）是 -1，
 * 界面上表现为一节都不亮——比"永远亮第一节"诚实：那一节确实还没读到。
 *
 * `pos < from` 而不是 `<=`：光标正好压在标题行上时，那一行自己就是"当前节"
 * （PM 的文本选区 from ≥ pos+1，天然满足）。
 */
export function activeHeadingOf(items: readonly OutlineItem[], from: number): number {
  let 序 = -1;
  for (let i = 0; i < items.length; i++) {
    const 条 = items[i];
    if (条 && 条.pos < from) 序 = i;
    else break;
  }
  return 序;
}

/** 条目签名：只拿它判"大纲变没变"，变了才 setState（订阅在打字路径上，判据同 Toolbar 的矩形同步） */
export function outlineKey(items: readonly OutlineItem[]): string {
  return items.map((i) => `${i.pos}:${i.level}:${i.text}`).join("|");
}
