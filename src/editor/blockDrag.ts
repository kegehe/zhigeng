/**
 * 行首手柄的拖拽判定。换位本身在 `moveBlockWithSelection`；这里只回答
 * 「这根指针现在算点击、放下，还是放弃」。
 *
 * 与目录树、表格框选同一套出口（docs/03 §拖拽手势）：
 * - 越过 5px 才算拖，否则是点击（打开类型菜单）
 * - `pointerup` 用松手这一刻量到的落点，不用移动过程里上一拍记下的
 * - `pointercancel` 放弃，不落子
 * - 只认按下那一根指针
 */

export type 手柄手势 = {
  指针: number;
  起点: number;
  原点Y: number;
  拖过: boolean;
};

export type 松手结果 =
  | { 种类: "点击" }
  | { 种类: "放下"; from: number; to: number }
  | { 种类: "放弃" };

const 拖阈值 = 5;

export function 起手势(指针: number, 起点: number, 原点Y: number): 手柄手势 {
  return { 指针, 起点, 原点Y, 拖过: false };
}

/** 别的指针不推进这根手势。竖直挪动超过 5px 才算拖——手柄很窄，横向抖动仍是点击。 */
export function 跟手(手势: 手柄手势, 指针: number, clientY: number): 手柄手势 {
  if (指针 !== 手势.指针 || 手势.拖过) return 手势;
  if (Math.abs(clientY - 手势.原点Y) < 拖阈值) return 手势;
  return { ...手势, 拖过: true };
}

/**
 * 松手。没拖过是点击。拖过则只认调用方此刻量到的落点：传 `null` 就是放弃，
 * 不会退回去用移动过程中画过的那条线。
 */
export function 松手势(手势: 手柄手势, 此刻落点: number | null): 松手结果 {
  if (!手势.拖过) return { 种类: "点击" };
  if (此刻落点 === null) return { 种类: "放弃" };
  return { 种类: "放下", from: 手势.起点, to: 此刻落点 };
}

/** `pointercancel`：触摸或笔被系统抢走时只有取消、没有抬起。放弃，不落子。 */
export function 取消手势(): 松手结果 {
  return { 种类: "放弃" };
}
