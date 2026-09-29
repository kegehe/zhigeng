/**
 * 命令面板的匹配。纯函数，因为"打什么字出来什么序"这种事只能钉在测试里，
 * 不能靠"看着挺顺"。
 *
 * 三条口径：
 * - **中文按连续子串，英文缩写按子序列**。中文里 `检索` 命中 `检索策略` 靠的是子串；
 *   而 `ss` 要能命中 `搜索要快` 那种拼音首字母写法不是我们的目标（那是另一套字典），
 *   子序列主要为拉丁文与路径服务（`ainat 检索` 这种混打）。
 * - **label 的分数永远压过 hint**。搜"回收"要出"回收站"，不是先跳出一堆路径里带"回收"的笔记。
 * - **空查询保持原序**，不排序。调用方给的是"笔记按更新时间倒序 + 动作按常用序"，
 *   那本身就是答案；在这里再排一次等于把意图改掉。
 */

/** 一条可搜的东西。`hint` 允许显式 undefined：调用方常常是"有路径就显示"三元出来的 */
export type Matchable = { label: string; hint?: string | undefined };

const 归一 = (s: string) => s.trim().toLowerCase();

/** 越小越好；null = 不匹配 */
function 打分(查询: string, 文本: string): number | null {
  if (!查询) return 0;
  const t = 归一(文本);
  if (!t) return null;
  if (t === 查询) return 0;
  if (t.startsWith(查询)) return 10;
  const 连续 = t.indexOf(查询);
  if (连续 >= 0) return 50 + 连续 * 2;
  // 子序列：逐字往后找，间隔越大越差
  let i = 0;
  let 隔 = 0;
  for (const c of t) {
    if (c === 查询[i]) {
      i++;
      if (i === 查询.length) break;
    } else if (i > 0) 隔++;
  }
  return i === 查询.length ? 500 + 隔 : null;
}

/** 一条命令项。`run` 由调用方闭包住界面动作，本模块不碰任何状态 */
export type PaletteItem = Matchable & {
  id: string;
  group: string;
  run: () => void;
};

export function 匹配<T extends Matchable>(查询: string, 候选: T[], 上限 = 20): T[] {
  const q = 归一(查询);
  if (!q) return 候选.slice(0, 上限);
  const 带分 = 候选.flatMap((c) => {
    const 甲 = 打分(q, c.label);
    const 乙 = c.hint ? 打分(q, c.hint) : null;
    const 分 = 甲 === null && 乙 === null ? null : Math.min(甲 ?? 1e9, 1000 + (乙 ?? 1e9));
    return 分 === null ? [] : [{ c, 分 }];
  });
  // 同分保持原序（flatMap 的次序就是候选次序），所以这里必须用稳定排序的默认行为
  return 带分.sort((a, b) => a.分 - b.分).slice(0, 上限).map((x) => x.c);
}

/**
 * 打字没找到才给「新建笔记『X』」那一条——**有任意命中就不给**。
 *
 * 从前这里查的是"有没有**全等**的标题"，于是打前缀时（"性能复测" 对上 "性能复测样本（临时）"）
 * 结果里明明列着那篇，新建还是冒出来，并且 `unshift` 到第 0 行——**回车默认落到的正是那个
 * 会往库里写文件的动作**（探针真机撞出来：一次 ↓+Enter 建出了一篇重复笔记）。判据应该是
 * "有没有任何命中"，一条都没有才谈得上"那就是要建"；这时它是列表里唯一的一条。
 */
export function 补新建(
  列: PaletteItem[],
  查询: string,
  新建?: (标题: string) => void,
): PaletteItem[] {
  const 题 = 查询.trim();
  if (!新建 || !题 || 列.length) return 列;
  return [{ id: "新建", group: "新建", label: `新建笔记「${题}」`, run: () => 新建(题) }];
}
