import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 改名会换路径、再按盘上的内容重装编辑器。前提是那篇的正文已经落盘——
 * 否则 `loadNote` 读回来的旧文件会把框里没存的字盖掉，连冲突横幅一起消失，
 * 用户连"选留哪份"的机会都没有。冲突时 `persist` 不覆盖、返回 false，
 * 所以每个改名入口都必须先问 `备好这篇`，失败就原地停下。
 *
 * 与 present.test.ts 同一路数：钉接线（谁先谁后），不重画界面。
 */
describe("改名先落盘，冲突时不许把字丢掉", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");

  /** 取一段源码：从 `起` 到它后面第一次出现的 `终`（含终点） */
  const 段 = (起: string, 终: string) => {
    const a = 主窗.indexOf(起);
    expect(a, `找不到起点：${起}`).toBeGreaterThanOrEqual(0);
    const b = 主窗.indexOf(终, a + 起.length);
    expect(b, `找不到终点：${终}`).toBeGreaterThanOrEqual(0);
    return 主窗.slice(a, b + 终.length);
  };

  it("正文右上角「改名」：进改名态之前先确认存盘", () => {
    const 进改名 = 主窗.indexOf('setMode("rename");');
    expect(进改名).toBeGreaterThanOrEqual(0);
    // 按钮自己的 onClick 起点：setMode("rename") 之前最近的那一个
    const 钮 = 主窗.slice(主窗.lastIndexOf("onClick={() => {", 进改名), 进改名);
    expect(钮).toContain("void (async () => {");
    expect(钮).toContain("const 目标 = selected.rel;");
    expect(钮).toContain("备好这篇(目标)");
    // 存不下去就 return，绝不能走到 setMode("rename")——那一步会清掉自动保存定时器
    expect(钮).toMatch(/if \(!\(await 备好这篇\(目标\)\)\) \{[\s\S]*?return;[\s\S]*?\}/);
    // 落盘期间可能已经切走：别把 A 的文件名套到 B 的正文上
    expect(钮).toContain("当前rel.current !== 目标");
    expect(钮).toContain("stemOf(目标)");
  });

  it("确认改名：搬文件之前再确认一次（改名前可能又脏了）", () => {
    const 提交 = 段("const commitRename = async () => {", "const 备好这篇 = async");
    const 落盘 = 提交.indexOf("备好这篇(selected.rel)");
    const 搬 = 提交.indexOf("api.noteRename(selected.rel, next)");
    expect(落盘).toBeGreaterThanOrEqual(0);
    expect(搬).toBeGreaterThanOrEqual(0);
    expect(落盘).toBeLessThan(搬);
  });

  it("树里重命名正开着的那一篇：同样先落盘，失败要说一声", () => {
    const 提交 = 段("const 提交树动作 = async () => {", "const createNote = async");
    const 落盘 = 提交.indexOf("备好这篇(动作.rel)");
    const 搬 = 提交.indexOf("api.noteRename(动作.rel, 文)");
    expect(落盘).toBeGreaterThanOrEqual(0);
    expect(搬).toBeGreaterThanOrEqual(0);
    expect(落盘).toBeLessThan(搬);
    expect(提交).toMatch(
      /if \(!\(await 备好这篇\(动作\.rel\)\)\) \{[\s\S]*?setFlash\("这篇还没保存——先处理冲突或错误提示"\);[\s\S]*?return;[\s\S]*?\}/,
    );
  });

  it("备好这篇：浏览态有改动就不许搬，落盘失败要把自动保存重新排上", () => {
    const 备 = 段("const 备好这篇 = async (rel: string) => {", "const 回收这篇 = async");
    // 浏览态的 persist 一个字节都不写却报成功
    expect(备).toContain('if (mode === "view") return false;');
    // 先撤定时器再落盘：两笔同哈希并发，后到的那笔会被误判冲突
    expect(备.indexOf("撤自动保存()")).toBeLessThan(备.indexOf("await persist()"));
    // 失败后不能停在"有改动但没有定时器"的状态
    expect(备).toContain("排自动保存();");
    expect(备).toContain("return false;");
  });

  it("persist 冲突时不覆盖、返回 false，冲突横幅留给用户选", () => {
    const 存 = 段("const persist = useCallback(", "// 停手 800ms 就存");
    expect(存).toMatch(/kind === "conflict"\) setSaveState\("conflict"\)/);
    expect(存).toMatch(/catch \(e\) \{[\s\S]*?return false;[\s\S]*?\}/);
  });

  it("落盘期间又敲的字不会被 setInlineRev(0) 清掉，而且同一篇只发一笔", () => {
    const 存 = 段("const persist = useCallback(", "const 排自动保存");
    // 失焦与按钮点击会前后脚各调一次：第二笔必须复用第一笔，不然同哈希并发 = 误报冲突
    expect(存).toContain("if (落盘中.current) {");
    expect(存).toContain("if (!force) return 落盘中.current;");
    // 冲突横幅上的「仍然存我这份」不能被并掉：等前一笔落地再强写
    expect(存).toContain("() => persist(true)");
    // 存完对稿本：变了就用新内容再存一轮，不能把新字标成已保存
    expect(存).toContain("稿本.current === 存时稿本");
    expect(存).toContain("已存 = 新稿;");
    // 自动保存失败也要补排一次，否则"有改动但没有定时器"
    expect(存).toContain("已补排.current");
  });

  it("回收这篇落盘失败也要说一声，与改名口径一致", () => {
    const 回 = 段("const 回收这篇 = async (rel: string) => {", "const 刷新目录");
    expect(回).toMatch(
      /if \(!\(await 备好这篇\(rel\)\)\) \{[\s\S]*?setFlash\("这篇还没保存——先处理冲突或错误提示"\);/,
    );
  });

  it("选了「仍然存我这份」之后，入口留下的提示要撤掉", () => {
    // 否则横幅已经消失，底下还挂着一句"还没保存——先处理冲突"，自相矛盾
    expect(主窗).toMatch(/setFlash\(null\);\s*void persist\(true\);/);
  });

  it("工具栏留着删除入口：侧栏只有前 300 篇，搜索打开的旧笔记不能没法回收", () => {
    expect(主窗).toMatch(/className=\{btnDanger\}[\s\S]*?回收这篇\(selected\.rel\)/);
  });
});
