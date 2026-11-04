import { describe, expect, it } from "vitest";
import { 拼公式, 拆公式 } from "./mathFace";

describe("公式账本：拼回去就是原字节", () => {
  it("首末两行各自只有 $$ 才接管", () => {
    const 拆 = 拆公式("$$\nE = mc^2\n$$");
    expect(拆?.开).toBe("$$");
    expect(拆?.身).toEqual(["E = mc^2"]);
    expect(拆?.闭).toBe("$$");
    expect(拼公式(拆!)).toBe("$$\nE = mc^2\n$$");
  });

  it("单行 / 行内混着正文的形状都不接管", () => {
    expect(拆公式("$$E = mc^2$$")).toBeNull();
    expect(拆公式("$$x$$ y\n$$z$$")).toBeNull();
    expect(拆公式("$$")).toBeNull();
    expect(拆公式("")).toBeNull();
  });

  it("零行与一个空行是两种字节", () => {
    expect(拆公式("$$\n$$")!.身).toEqual([]);
    expect(拆公式("$$\n\n$$")!.身).toEqual([""]);
    expect(拼公式(拆公式("$$\n$$")!)).toBe("$$\n$$");
    expect(拼公式(拆公式("$$\n\n$$")!)).toBe("$$\n\n$$");
  });

  it("CRLF 的 \\r 留在行上，拼回去还是 CRLF", () => {
    const 源 = "$$\r\nE = mc^2\r\n$$";
    const 拆 = 拆公式(源);
    expect(拆?.身).toEqual(["E = mc^2\r"]);
    expect(拼公式(拆!)).toBe(源);
  });

  it("围栏两侧的空白原样留着", () => {
    const 源 = "  $$\n  x\n  $$";
    const 拆 = 拆公式(源);
    expect(拆?.开).toBe("  $$");
    expect(拆?.闭).toBe("  $$");
    expect(拼公式(拆!)).toBe(源);
  });
});
