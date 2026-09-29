/**
 * 表格**矩形选区**的几何。只有几何，没有内容——
 *
 * 为什么不在这儿做"批量清空/填充"的字符串版：格子里带 mark（加粗、行内码、链接），
 * 拿 `string[][]` 走一遍就把 mark 洗掉了，而落盘那条路是 `docToMarkdown` 读节点。
 * 内容操作留在 `blocks.ts` 直接对节点做（清空 = 删该格内容，填充 = 复制左上格的内容），
 * 这里只负责回答"哪些格被选中了"。两边各存一份内容语义早晚分叉。
 *
 * 坐标一律是**表内相对**的 `(行, 列)`，与 `cellAt()` 给的同一套；行列都从 0 起、含两端。
 */

export type 格 = { 行: number; 列: number };

/** 已归一化的矩形：`r0 ≤ r1`、`c0 ≤ c1`，四个方向都含端点 */
export type 矩形 = { r0: number; c0: number; r1: number; c1: number };

export function 单格(甲: 格): 矩形 {
  return { r0: 甲.行, c0: 甲.列, r1: 甲.行, c1: 甲.列 };
}

/** 从锚点扩到另一点。拖选与 Shift 点选都归到这里 */
export function 归一(甲: 格, 乙: 格): 矩形 {
  return {
    r0: Math.min(甲.行, 乙.行),
    r1: Math.max(甲.行, 乙.行),
    c0: Math.min(甲.列, 乙.列),
    c1: Math.max(甲.列, 乙.列),
  };
}

export function 含(矩: 矩形, 格: 格): boolean {
  return 格.行 >= 矩.r0 && 格.行 <= 矩.r1 && 格.列 >= 矩.c0 && 格.列 <= 矩.c1;
}

export function 格数(矩: 矩形): number {
  return (矩.r1 - 矩.r0 + 1) * (矩.c1 - 矩.c0 + 1);
}

/**
 * 算不算"批量"。单格不算：那时光标就在格子里，`Backspace` 该删字符而不是清空整格，
 * 工具栏也该停在单格那一档（删这一行 / 本列对齐）。
 */
export function 多格(矩: 矩形 | null): 矩 is 矩形 {
  return !!矩 && 格数(矩) > 1;
}

export function 覆盖行(矩: 矩形): number[] {
  const 出: number[] = [];
  for (let r = 矩.r0; r <= 矩.r1; r++) 出.push(r);
  return 出;
}

export function 覆盖列(矩: 矩形): number[] {
  const 出: number[] = [];
  for (let c = 矩.c0; c <= 矩.c1; c++) 出.push(c);
  return 出;
}

/** 填充的来源格 = 矩形左上角。**不是光标所在格**：用户从右下往左上拖时，抄的仍是左上那格 */
export function 左上(矩: 矩形): 格 {
  return { 行: 矩.r0, 列: 矩.c0 };
}

/**
 * 把矩形夹回表格现有尺寸。
 *
 * 必须存在：删完行/列之后矩形还指着不存在的格，下一次批量就会拿越界坐标去取节点，
 * 轻则空转、重则事务落在错误的位置上改到别人的字节。
 */
export function 夹住(矩: 矩形, 行数: number, 列数: number): 矩形 | null {
  const r1 = Math.min(矩.r1, 行数 - 1);
  const c1 = Math.min(矩.c1, 列数 - 1);
  if (矩.r0 > r1 || 矩.c0 > c1) return null; // 整块选区已经不在表里了
  return { r0: 矩.r0, c0: 矩.c0, r1, c1 };
}
