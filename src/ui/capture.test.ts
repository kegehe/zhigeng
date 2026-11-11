import { describe, expect, it } from "vitest";
import { 回执属于本笔 } from "./capture";

// 这一组钉的场景：`note://capture-indexed` 的负载是 `{ rel, ok }`，**必须带 rel**。
// 只发路径列表时，两笔速记挨得太近会把上一笔的回执算到这一笔头上。
describe("速记索引回执属于哪一笔", () => {
  it("路径对上 = 本笔", () => {
    expect(回执属于本笔("inbox/甲.md", "inbox/甲.md")).toBe(true);
  });

  it("路径对不上 = 上一笔，不能算到这一笔头上", () => {
    expect(回执属于本笔("inbox/乙.md", "inbox/甲.md")).toBe(false);
  });

  it("命令还没返回、路径未知：先收下，等返回后按 res.rel 认领", () => {
    // 这时无法判断是谁的，但只有一笔在飞；先存着比直接丢掉安全
    expect(回执属于本笔("", "inbox/甲.md")).toBe(true);
  });

  it("空串回执在没有待定路径时收下，已知路径时对不上", () => {
    // rel 理论上不会为空；真拿到空串时不要把它当成"任何一篇"
    expect(回执属于本笔("inbox/甲.md", "")).toBe(false);
    expect(回执属于本笔("", "")).toBe(true);
  });
});
