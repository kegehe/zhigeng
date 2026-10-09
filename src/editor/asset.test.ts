import { describe, expect, it } from "vitest";
import { 是库内资产, 新引用, 拼资产引用, 拆资产引用 } from "./asset";

/**
 * 资产引用的拆与拼。**判的不是画得好不好，而是拆完再拼必须逐字节等于原样**——
 * 图片块是原子块，那一行引用就是它的全部字节，差一个空格就是改用户的文件。
 *
 * 与 `fence.test.ts` 同一个角色：显示形（缩略图）与序列化共用这一份实现，
 * 所以这里的每一条往返都同时是"屏幕上那张图"与"文件里那一行"的一致性。
 */

const 回 = (源: string) => {
  const 拆 = 拆资产引用(源);
  expect(拆, 源).not.toBeNull();
  return 拼资产引用(拆!);
};

describe("资产引用的拆与拼", () => {
  it("各种合法形状：拆完拼回去逐字节相同", () => {
    for (const 源 of [
      "![[attachments/a3/x.png]]",
      "![[attachments/a3/x.png|今年冬天]]",
      "![[attachments/a3/x.png|]]", // 写了竖线就是用户打的字
      "![[/attachments/a3/x.png]]", // Vault 根相对的写法
      "![说明](attachments/a3/x.jpg)",
      "![](attachments/a3/x.gif)",
      "  ![[attachments/a3/x.png]]", // 行首两格缩进
      "![[attachments/a3/x.png]] ", // 尾巴上的空格（块锚点被摘掉之后就是这形状）
      "![[x.png]]\t",
    ]) {
      expect(回(源), 源).toBe(源);
    }
  });

  it("两种形状分得清：wiki 与 Markdown 各自拼回自己", () => {
    expect(拆资产引用("![[a.png]]")!.形).toBe("wiki");
    expect(拆资产引用("![x](a.png)")!.形).toBe("md");
    // Markdown 形的空方括号不等于"写了别名"，拼回去也不能凭空多一根竖线
    expect(拆资产引用("![](a.png)")!.有别名).toBe(false);
    expect(拆资产引用("![[a.png|]]")!.有别名).toBe(true);
    expect(拆资产引用("![[a.png|图注]]")!.别名).toBe("图注");
  });

  it("缩进与尾随空白是分开记的，不是被 trim 掉的", () => {
    const 拆 = 拆资产引用("   ![[a.png]]  ")!;
    expect(拆.前).toBe("   ");
    expect(拆.后).toBe("  ");
    expect(拆.目标).toBe("a.png");
    expect(拼资产引用(拆)).toBe("   ![[a.png]]  ");
  });

  it("接管不了的形状一律返回 null，不许勉强", () => {
    for (const 源 of [
      "", // 空行
      "一句话",
      "![[a.png]] 后面还有字", // 那一行不是只有引用：接管就把后面的字吃掉了
      "前面 ![[a.png]]",
      "![[a.png]]]]", // 多出来的尾巴
      "![[|]]", // 没有目标
      "![[a.png|左|右]]", // 第二根竖线没进 attrs，接管就拼不回去
      '![x](a.png "标题")', // 标题没搬进 attrs
      "![x](<a.png>)", // 尖括号包路径
      "![x](a.png extra)",
      "![[a\nb.png]]", // 跨行不是一行引用
      "![x](a.png", // 没闭合
      "![[a.png]",
      "```js", // 围栏不是引用
    ]) {
      expect(拆资产引用(源), 源).toBeNull();
    }
  });

  it("只有指向 attachments/ 的才算库内资产", () => {
    expect(是库内资产("attachments/a3/x.png")).toBe(true);
    expect(是库内资产("/attachments/a3/x.png")).toBe(true); // 根相对写法
    expect(是库内资产("attachments\\a3\\x.png")).toBe(true); // Windows 分隔符
    // 裸文件名与相对路径要的是全库解析，那件活没做，不能接管
    expect(是库内资产("去年圣诞.png")).toBe(false);
    expect(是库内资产("../outside.png")).toBe(false);
    expect(是库内资产("notes/x.md")).toBe(false);
    // 带 .. 的即便前缀对也不算——那已经不是"我们的资产"这个前提
    expect(是库内资产("attachments/../secret.png")).toBe(false);
    expect(是库内资产("attachments/")).toBe(false); // 指向目录本身
    expect(是库内资产("")).toBe(false);
  });

  it("新建的引用是干净的 wiki 形", () => {
    const 拆 = 新引用("attachments/a3/x.png");
    expect(拆.形).toBe("wiki");
    expect(拆.有别名).toBe(false);
    expect(拼资产引用(拆)).toBe("![[attachments/a3/x.png]]");
  });
});
