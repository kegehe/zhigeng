import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGrid, parseTable, serializeTable, splitRow, type ParsedTable } from "./table";

/**
 * 表格的双向转换是"改一个格子就会重写整块"的那条路，所以**接管判据**比转换本身更要钉：
 * 接管错了就是把用户的字节拼成另一种形状（[02] D9 的教训）。
 */

const 表 = (rows: string[][], aligns: ParsedTable["aligns"] = ["", ""]): ParsedTable => ({ rows, aligns });

describe("接管判据", () => {
  it("规范三行两列：接管，并读出对齐", () => {
    const t = parseTable("| A | B |\n|:---|---:|\n| 1 | 2 |\n")!;
    expect(t.rows).toEqual([["A", "B"], ["1", "2"]]);
    expect(t.aligns).toEqual(["left", "right"]);
  });

  it("列数不齐的不接管（GFM 认它，我们拼不回去）", () => {
    expect(parseTable("| 甲 | 乙 |\n| --- |\n| 1 | 2 | 3 |\n")).toBeNull();
    expect(parseTable("| A | B |\n|---|---|\n| 1 |\n")).toBeNull();
  });

  it("带块锚的不接管：锚点可能独占一行挂在后面，也可能挤成第 N+1 格", () => {
    expect(parseTable("| A | B |\n|---|---|\n| 1 | 2 |\n^b-f3g6j9l2mn\n")).toBeNull();
    expect(parseTable("| A | B |\n|---|---|\n| 1 | 2 | ^b-k3x9m2v7qa\n")).toBeNull();
  });

  it("行首缩进、空行、只有一行、分隔行非法：都不接管", () => {
    expect(parseTable("  | A | B |\n  |---|---|\n")).toBeNull();
    expect(parseTable("| A | B |\n|---|---|\n\n| 1 | 2 |\n")).toBeNull();
    expect(parseTable("| A | B |\n")).toBeNull();
    expect(parseTable("| A | B |\n| x | y |\n| 1 | 2 |\n")).toBeNull();
    expect(parseTable("")).toBeNull();
  });

  it("不以 | 开头的行不接管（内核可能判成 table，但我们不猜）", () => {
    expect(parseTable("| A | B |\n|---|---|\n甲 | 乙\n")).toBeNull();
  });
});

describe("产回 GFM", () => {
  it("规范形：表头 + 分隔行 + 数据行，结尾不带换行", () => {
    expect(serializeTable(表([["A", "B"], ["1", "2"]]))).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("空单元格不留竖线粘连", () => {
    expect(serializeTable(表([["A", "B"], ["", ""]]))).toBe("| A | B |\n| --- | --- |\n|  |  |");
  });

  it("单元格里的竖线必须转义，否则重新解析多出一列", () => {
    const 出 = serializeTable(表([["A", "B"], ["x|y", "2"]]));
    expect(出).toBe("| A | B |\n| --- | --- |\n| x\\|y | 2 |");
    expect(parseTable(出 + "\n")!.rows[1]).toEqual(["x|y", "2"]);
  });

  it("格子里的换行折成空格：产出永远是 N 行，一张表不会被写成两张", () => {
    const 出 = serializeTable(表([["甲\n\n乙", "丙\r\n丁"], ["1\t2", "2"]]));
    expect(出.split("\n")).toHaveLength(3);
    expect(出).toBe("| 甲 乙 | 丙 丁 |\n| --- | --- |\n| 1\t2 | 2 |");
    expect(parseTable(出 + "\n")!.rows[0]).toEqual(["甲 乙", "丙 丁"]);
  });

  it("对齐按 aligns 产出，三种都算", () => {
    const t = parseTable("| A | B | C | D |\n|---|:--|--:|:-:|\n| 1 | 2 | 3 | 4 |\n")!;
    expect(serializeTable(t).split("\n")[1]).toBe("| --- | :--- | ---: | :---: |");
  });

  it("转换是幂等的：产出的那份再 parse 一次结构相同，再产一次字节相同", () => {
    const 一次 = serializeTable(表([["甲", "乙"], ["1", "2"]], ["left", "right"]));
    const 二次 = serializeTable(parseTable(一次 + "\n")!);
    expect(二次).toBe(一次);
    expect(serializeTable(parseTable(二次 + "\n")!)).toBe(二次);
  });
});

describe("剪贴板里的表：parseGrid", () => {
  it("Markdown 源文本走 parseTable 同一条判据", () => {
    const t = parseGrid("| A | B |\n| --- | --- |\n| 1 | 2 |\n")!;
    expect(t.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    // 列数不齐 / 带块锚 / 有缩进：文件里不接管的，粘贴同样不接管
    expect(parseGrid("| A | B |\n| --- |\n| 1 | 2 | 3 |\n")).toBeNull();
    expect(parseGrid("  | A | B |\n  |---|---|\n")).toBeNull();
    expect(parseGrid("甲\n乙")).toBeNull();
  });

  it("电子表格的 TSV：制表符分列，第一行当表头", () => {
    const t = parseGrid("指标\t目标\t实测\n打字\t16ms\t待测\n滚动\t不掉帧\t已验")!;
    expect(t.rows.length).toBe(3);
    expect(t.rows[0]).toEqual(["指标", "目标", "实测"]);
    expect(t.aligns).toEqual(["", "", ""]);
  });

  it("CRLF 与行尾多出来的制表符都先收干净", () => {
    const t = parseGrid("A\tB\r\n1\t2\r\n3\t4\t")!;
    expect(t.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("列数不齐 / 只有一列 / 只有一行 / 全是制表符：都不接", () => {
    expect(parseGrid("A\tB\n1")).toBeNull(); // Excel 会省掉行尾空格，补空列就是替用户编内容
    expect(parseGrid("只有一列\n第二行")).toBeNull();
    expect(parseGrid("A\tB")).toBeNull();
    expect(parseGrid("\t\t\n\t\t")).toBeNull();
  });

  it("CSV 不认：逗号在正文里太常见，不拿用户的内容赌概率", () => {
    expect(parseGrid("甲,乙,丙\n1,2,3")).toBeNull();
  });
});

describe("真夹具", () => {
  const 读 = (名: string) => readFileSync(`testdata/roundtrip/${名}.md`, "utf8");

  it("03 与 06 里的表都接管", () => {
    const 三 = 读("03-代码表格与公式");
    const 源 = 三.split("\n").filter((l) => l.trim().startsWith("|")).join("\n");
    expect(parseTable(源 + "\n")!.rows[0]).toEqual(["列 A", "列 B"]);
    // 转义竖线那格读回来是一个字符，不是两列
    expect(parseTable(源 + "\n")!.rows[2]).toEqual(["含 `内联码` 与 [[链接]]", "竖线 | 转义"]);
    const 六 = 读("06-插入骨架");
    const 骨架 = 六.split("\n").filter((l) => l.trim().startsWith("|")).join("\n");
    expect(parseTable(骨架 + "\n")).not.toBeNull();
  });

  it("splitRow 与表格解析对『结尾没竖线』的宽容一致", () => {
    expect(splitRow("| A | B |")).toEqual(["A", "B"]);
    expect(splitRow("| A | B")).toEqual(["A", "B"]);
    expect(splitRow("| A \\| B | C |")).toEqual(["A | B", "C"]);
  });
});
