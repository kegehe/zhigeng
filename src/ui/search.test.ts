import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { 来源徽章, 走了哪几路, 走了那句, 重排尾巴, 路名, 面板标题 } from "./search";

/**
 * 后端那份判据的原文。跨语言比对靠它，不靠我记得去改两处。
 * 路径按仓库根拼：jsdom 里 `import.meta.url` 是 vite 给的 http URL，
 * `new URL(..., import.meta.url)` 会在 readFileSync 上抛"URL must be of scheme file"
 * （ai.test.ts 那条注释就是踩过一次留下的）
 */
const 检索源 = fs.readFileSync("crates/note-core/src/retrieve.rs", "utf8");
const 界面源 = fs.readFileSync("src/App.tsx", "utf8");

/** 取一段原文。取不到就是**红**，而不是悄悄跳过——跳过等于这条护栏不存在 */
function 段(源: string, 式: RegExp, 说明: string): string {
  const 匹 = 源.match(式);
  expect(匹, `retrieve.rs 的形状和这条用例假设的不一样，两边必须一起改：${说明}`).not.toBeNull();
  return 匹 ? (匹[0] ?? "") : "";
}

/** 抓一段里所有第一个捕获组 */
function 抓(文本: string, 式: RegExp): string[] {
  return [...文本.matchAll(式)]
    .map((m) => m[1])
    .filter((x): x is string => typeof x === "string");
}

describe("检索来源的徽章", () => {
  it("说得出是哪几路，而不是把档数写死", () => {
    expect(来源徽章(["keyword"])).toBe("关键词");
    expect(来源徽章(["graph"])).toBe("链接");
    expect(来源徽章(["keyword", "semantic"])).toBe("关键词+语义");
    expect(来源徽章(["keyword", "graph"])).toBe("关键词+链接");
    expect(来源徽章(["keyword", "semantic", "graph"])).toBe("关键词+语义+链接");
  });

  it("反面：界面上不许再出现写死的\"两路都中\"", () => {
    // 那是只有两路时的话。加一档路它就变成谎，而它只是一个字符串，前端单测拦不住
    expect(界面源).not.toContain("两路都中");
    expect(来源徽章(["keyword", "graph"])).not.toContain("两路");
  });

  it("认不出的档名原样显示，不翻译成一个已知的路", () => {
    // 后端多一档而我没跟上时，界面上多一个生词是难看；把它说成"关键词"是说谎
    expect(来源徽章(["keyword", "mystery"])).toBe("关键词+mystery");
  });

  it("档名与 Rust 的 路 枚举一一对上", () => {
    const 枚举 = 段(检索源, /pub enum 路 \{[\s\S]*?\n\}/, "pub enum 路");
    const 变体 = 抓(枚举, /([A-Z]\w+),/g).map((x) => x.toLowerCase());
    expect(变体.length).toBeGreaterThan(1);
    expect(Object.keys(路名).sort()).toEqual([...变体].sort());
  });

  it("中文名与 Rust 的 显示名() 逐条相等", () => {
    const 体 = 段(检索源, /pub fn 显示名\(self\)[\s\S]*?\n    \}/, "路::显示名");
    const 对应 = [...体.matchAll(/路::([A-Z]\w+) => "([^"]+)"/g)];
    expect(对应.length).toBe(Object.keys(路名).length);
    for (const 项 of 对应) {
      const 变体 = 项[1]?.toLowerCase();
      expect(变体, `显示名 里读出一个认不上的变体：${项[0]}`).toBeDefined();
      expect(路名[变体 ?? ""]).toBe(项[2]);
    }
  });
});

describe("这一趟走了哪几路", () => {
  /**
   * 顺序读 Rust 的 `三路` 那张表，分隔符读 `走了哪几路` 里的 join，名字用上面那条
   * 用例已经比对过的 `路名`。读不出形状就红——那正是"两边各改一句"的那一刻。
   */
  function 后端的拼法(): (语义: boolean, 图: boolean) => string {
    const 表 = 段(检索源, /pub const 三路: \[[^\]]*\] = \[[^\]]*\];/, "pub const 三路");
    const 序 = 抓(表, /路::([A-Z]\w+)/g).map((x) => x.toLowerCase());
    expect(序.length, `三路 那张表读不出档位：${表}`).toBeGreaterThan(1);
    const 体 = 段(检索源, /pub fn 走了哪几路\([\s\S]*?\n\}/, "走了哪几路");
    const 分隔 = 抓(体, /\.join\("([^"]*)"\)/g)[0];
    expect(分隔, `走了哪几路 里读不出分隔符：\n${体}`).toBeDefined();
    const 开关: Record<string, (语义: boolean, 图: boolean) => boolean> = {
      keyword: () => true,
      graph: (_语义, 图) => 图,
      semantic: (语义) => 语义,
    };
    return (语义, 图) =>
      序
        .filter((档) => (开关[档] ?? (() => false))(语义, 图))
        .map((档) => 路名[档] ?? 档)
        .join(分隔 ?? "");
  }

  it("四种开关两边拼出同一句话", () => {
    const 后端 = 后端的拼法();
    for (const 语义 of [false, true]) {
      for (const 图 of [false, true]) {
        expect(走了哪几路(语义, 图)).toBe(后端(语义, 图));
      }
    }
  });

  it("没配嵌入模型时说的是两路而不是一路", () => {
    // 图扩展那一路零 token、不配 Key 也在跑。从前这句话是"只有关键词"
    expect(走了哪几路(false, true)).toBe("关键词 + 链接");
    expect(走了哪几路(false, false)).toBe("关键词");
    expect(走了哪几路(true, true)).toBe("关键词 + 链接 + 语义");
  });

  it("重排那段尾巴两边逐字相等", () => {
    // 右上角那句话与 CLI 那行总结共用它。改了 Rust 那份而没改这里，界面上就会出现
    // 另一句"· 重排过"之类对不上的话
    const 常 = 段(检索源, /pub const 重排尾巴: &str = "[^"]*";/, "重排尾巴");
    expect(常.match(/= "([^"]*)";/)![1]).toBe(重排尾巴);
  });

  it("重排是尾巴，不是第四路", () => {
    expect(走了那句(false, true, false)).toBe("关键词 + 链接");
    expect(走了那句(false, true, true)).toBe("关键词 + 链接 · 已重排");
    expect(走了那句(true, true, true)).toBe("关键词 + 链接 + 语义 · 已重排");
    // 反面：一个模型都没打时不许带尾巴（"配了开关"不等于"生效了"）
    expect(走了那句(true, true, false)).not.toContain("重排");
  });
});

describe("侧栏那块的名字", () => {
  it("不配 Key 也出现：面板不再被 ai就绪 挡着", () => {
    // 链接那一路是本地路。用 ai就绪 挡着它，等于把唯一人人都有的一路藏起来
    expect(界面源).not.toContain("|| !ai就绪)");
    // 名字只有一个家：App.tsx 引 面板标题，那块字面量留在 search.ts 里
    expect(界面源).toContain("面板标题");
    expect(界面源).not.toContain(">语义补充<");
    expect(面板标题).toBe("检索补充");
  });

  it("后端那三路的名字都在这份表里", () => {
    expect(new Set(Object.values(路名))).toEqual(new Set(["关键词", "语义", "链接"]));
  });
});
