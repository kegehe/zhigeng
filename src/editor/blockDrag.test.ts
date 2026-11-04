import { describe, expect, it } from "vitest";
import { 起手势, 取消手势, 跟手, 松手势 } from "./blockDrag";

describe("手柄拖拽：松手再量，取消不落子", () => {
  it("没越过 5px 是点击，不换位", () => {
    let 手势 = 起手势(1, 0, 100);
    手势 = 跟手(手势, 1, 104);
    expect(手势.拖过).toBe(false);
    expect(松手势(手势, 3)).toEqual({ 种类: "点击" });
  });

  it("松手用这一刻的落点，不用移动过程里画过的线", () => {
    let 手势 = 起手势(1, 0, 100);
    手势 = 跟手(手势, 1, 108);
    expect(手势.拖过).toBe(true);
    expect(松手势(手势, 4)).toEqual({ 种类: "放下", from: 0, to: 4 });
  });

  it("松手时量不到块就放弃，不拿上一拍凑数", () => {
    let 手势 = 起手势(1, 2, 40);
    手势 = 跟手(手势, 1, 80);
    expect(松手势(手势, null)).toEqual({ 种类: "放弃" });
  });

  it("别的指针不把这次手势推进成拖拽", () => {
    let 手势 = 起手势(1, 0, 100);
    手势 = 跟手(手势, 2, 200);
    expect(手势.拖过).toBe(false);
    expect(松手势(手势, 3)).toEqual({ 种类: "点击" });
  });

  it("pointercancel 是放弃，不带落点", () => {
    expect(取消手势()).toEqual({ 种类: "放弃" });
  });
});
