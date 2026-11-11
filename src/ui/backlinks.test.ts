import { describe, expect, it } from "vitest";
import { 面板判定 } from "./backlinks";

/**
 * 这一张表钉的是"屏幕上说的与落盘的是不是同一句话"。
 * 后端 `assets::exists` 判存在性，这里判措辞与可点性——两边都不许自己再算一遍，
 * 所以用例的输入就是后端给的那几个字段，不预先算好期望值。
 */
const 行 = (
  kind: string,
  rel: string,
  broken: boolean,
  toNote = kind !== "asset",
  target = "",
) => 面板判定({ kind, rel, broken, toNote, target });

describe("反链面板一行的判定", () => {
  it("笔记行：能开、不标红、不占状态位", () => {
    expect(行("ref", "notes/乙.md", false)).toEqual({
      可打开: true,
      标红: false,
      尾注: null,
      是资产: false,
      可新建: false,
    });
  });

  it("悬空的笔记写法：标红、说\"链空了\"、行本身不许点", () => {
    expect(行("ref", "", true, false, "悬空写法")).toEqual({
      可打开: false,
      标红: true,
      尾注: "链空了",
      是资产: false,
      可新建: true,
    });
  });

  it("悬空的笔记写法能就地补一篇：拿用户写下的原文当新建标题", () => {
    // 后端 note_create 用这个标题写 front-matter；索引落地时 resolve_broken_to
    // 按标题把这条接回来。标题一变，链就接不上，所以这里给的是原文而不是清理过的版本。
    expect(行("ref", "", true, false, "notes/乙").可新建).toBe(true);
    // 写法是空的就没有能拿去建的名字（extract_links 本身会丢掉这种，这里只守边界）
    expect(行("ref", "", true, false, "   ").可新建).toBe(false);
  });

  it("悬空的资产写法不给新建：建出来会是一篇叫 `photo.png` 的空笔记", () => {
    const 判 = 行("asset", "", true, false, "photo.png");
    expect(判.标红).toBe(true);
    expect(判.可新建).toBe(false);
  });

  it("盘上真有这张图：不标红、说它在库内、**不许点开成一篇笔记**", () => {
    // rel 这时装的是 `attachments/aa/<sha>.png`。只判 `!rel` 就会给一行二进制挂上
    // "打开笔记"的动作——那是比"链空了"更难看的一次事故（点了没反应，或者开出一篇空笔记）。
    expect(行("asset", "attachments/aa/aaa.png", false)).toEqual({
      可打开: false,
      标红: false,
      尾注: "附件在库内",
      是资产: true,
      可新建: false,
    });
  });

  it("图被外部删掉：说\"文件丢了\"，不说\"链空了\"", () => {
    // 用户写下的不是一个笔记名。那句谎他一眼能看穿，也会去怪编辑器把链弄坏了。
    const 一 = 行("asset", "", true);
    expect(一.标红).toBe(true);
    expect(一.可打开).toBe(false);
    expect(一.尾注).toBe("文件丢了");
  });

  it("指得到笔记的带点写法（`[[notes/乙.md]]`）仍按笔记那一档走", () => {
    // `link_kind` 只看写法里有没有点，所以这种行的 kind 是 asset。后端对它**不查盘**
    // （它的真值是笔记表里那一篇），`toNote` 为真，于是这里照常给可点、也不说"附件"。
    expect(行("asset", "notes/乙.md", false, true)).toEqual({
      可打开: true,
      标红: false,
      尾注: null,
      是资产: false,
      可新建: false,
    });
  });

  it("没有对方就没有可打开的：rel 为空时不答应点", () => {
    expect(
      面板判定({ kind: "ref", rel: "", broken: false, toNote: true, target: "" }).可打开,
    ).toBe(false);
  });
});
