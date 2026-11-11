import type { TrashRow } from "../ipc/types";

/**
 * 回收站里一条的身份。**不能只用 `rel`**：同一篇可以删两次（删了又建同名再删），
 * 两次各自是一份完整的回收件，靠 `batch` 才分得开。键里用 `\u0000` 分隔，
 * 路径里不可能出现这个字符，所以 `a` + `b/c` 与 `a/b` + `c` 不会被拼成同一个键。
 */
export function 回收站键(t: Pick<TrashRow, "batch" | "rel">): string {
  return `${t.batch}\u0000${t.rel}`;
}

/**
 * 永久删除是**两步**：第一次点只是把这一行翻成确认态，再点同一条才执行。
 * 点别的条目会把确认挪过去——一个悬着的"确认删除"落错行，比没有确认更危险。
 */
export function 下一步永久删除(
  确认中: string | null,
  目标: string,
): { 确认中: string | null; 执行: boolean } {
  return 确认中 === 目标
    ? { 确认中: null, 执行: true }
    : { 确认中: 目标, 执行: false };
}

/**
 * 面板显示的删除时刻。**不能用文件 mtime**：`rename` 会保留它，读到的是
 * "最后编辑"——删一篇上周写好的笔记会显示成"上周删除"。旧批次名解析不出
 * 时间时，后端已经把它退回 mtime，这里只是兜住空值。
 */
export function 删除时刻(t: Pick<TrashRow, "deletedMs" | "updatedMs">): number {
  return t.deletedMs || t.updatedMs;
}

/**
 * 删掉一条之后该选中谁：先取原位置的下一条，没有就取上一条；都空了就 null。
 * 删完还停在原地看一片空白，用户会以为整页被清空了。
 */
export function 删后选中(list: TrashRow[], 删掉: string): TrashRow | null {
  const i = list.findIndex((t) => 回收站键(t) === 删掉);
  if (i < 0) return list[0] ?? null;
  return list[i + 1] ?? list[i - 1] ?? null;
}

/** 预览最多送到界面多少字。再长就不是"确认删的是哪一版"，是拿 DOM 当文件查看器 */
export const 预览上限 = 64 * 1024;

/**
 * 预览正文与"是不是截断了"。截断时**别把代理对切成两半**——半个字符在界面上
 * 是一个替换符，看起来像文件坏了。
 */
export function 预览正文(src: string): { text: string; truncated: boolean } {
  if (src.length <= 预览上限) return { text: src, truncated: false };
  let text = src.slice(0, 预览上限);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text, truncated: true };
}
