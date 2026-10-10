import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { 可检索, 徽标, 徽标红, 缺项, 步骤名, 探针数, 探针结论 } from "./ai";

const 齐 = { baseUrl: "https://api.example.com/v1", chatModel: "gpt-x", embeddingModel: "emb-1" };

describe("AI 入口的角标", () => {
  it("必填只有两项：地址与对话模型", () => {
    expect(缺项({ baseUrl: "", chatModel: "", embeddingModel: "" })).toEqual([
      "base_url",
      "chat_model",
    ]);
  });

  it("嵌入模型留空不算缺项", () => {
    // DeepSeek、Anthropic 只有对话端点，Kimi 的嵌入要单独申请。把它算成"没配好"
    // 等于逼用户去填一个他家根本没有的东西
    expect(缺项({ ...齐, embeddingModel: "" })).toEqual([]);
    expect(缺项({ ...齐, embeddingModel: "   " })).toEqual([]);
  });

  it("只有空格也算没填对话模型", () => {
    expect(缺项({ ...齐, chatModel: "   " })).toEqual(["chat_model"]);
  });

  it("没配齐的角标是中性事实，不是红色警告", () => {
    expect(徽标({ ...齐, baseUrl: "" }, null)).toBe("没配");
    expect(徽标红(null)).toBe(false);
  });

  it("配齐了但没测过：不占角标位", () => {
    expect(徽标(齐, null)).toBe(null);
  });

  it("测过之后角标说清这一路开到哪儿", () => {
    expect(徽标(齐, true)).toBe("能检索");
    expect(徽标红(true)).toBe(false);
    // 只对话通了 ≠ 检索在用模型。从前这里统一写"通了"，是半个谎
    expect(徽标({ ...齐, embeddingModel: "" }, true)).toBe("只对话");
    expect(徽标(齐, false)).toBe("不通");
    expect(徽标红(false)).toBe(true);
  });

  it("缺项时测没测都不给结论：没填齐根本不会发请求", () => {
    expect(徽标({ ...齐, chatModel: "" }, false)).toBe("没配");
  });

  it("报告里的 stage 有中文名，未启用那一步也有", () => {
    expect(步骤名("chat")).toBe("对话模型");
    expect(步骤名("embeddings")).toBe("嵌入模型");
    expect(步骤名("embeddings-off")).toBe("嵌入模型（未启用）");
    expect(步骤名("config")).toBe("配置");
  });
});

describe("探针个数是数出来的，不是写死的", () => {
  it("嵌入未启用时只剩一个探针", () => {
    const 步 = [{ stage: "chat" }, { stage: "embeddings-off" }];
    expect(探针数(步)).toBe(1);
    expect(探针结论(true, 步)).toBe("1 个探针都通了");
  });

  it("两个都打了才说两个", () => {
    const 步 = [{ stage: "config" }, { stage: "chat" }, { stage: "embeddings" }];
    expect(探针数(步)).toBe(2);
    expect(探针结论(true, 步)).toBe("2 个探针都通了");
  });

  it("不通就是不通，不数个数；一个都没打要说一个都没打", () => {
    expect(探针结论(false, [{ stage: "chat" }, { stage: "embeddings" }])).toBe("有一步不通");
    expect(探针结论(true, [{ stage: "config" }])).toBe("没有可测的探针");
  });
});

describe("语义那一路的门槛", () => {
  it("只填了地址与嵌入模型就该允许检索", () => {
    // 对话模型是问答那一档的前提。拿它去挡检索，等于一个用不上的格子决定另一件事能不能跑
    expect(可检索({ baseUrl: "http://x/v1", embeddingModel: "e" })).toBe(true);
  });

  it("缺地址或缺嵌入模型就不打那一趟", () => {
    expect(可检索({ baseUrl: "", embeddingModel: "e" })).toBe(false);
    expect(可检索({ baseUrl: "http://x/v1", embeddingModel: "   " })).toBe(false);
  });
});

describe("后端指引里点名的按钮，就是界面上那枚", () => {
  // 真机照出来的一条：`probe` 的未启用指引写着「看看这家有哪些嵌入模型」，而按钮叫
  // 「看看这家有哪些模型」——用户按着那句话找，屏幕上没有那么个东西。跨语言的等值
  // 只有这种写法拦得住：两边都从**源码**里读，改一处就红。
  // jsdom 环境里 `import.meta.url` 是 vite 给的 http URL，`fileURLToPath` 会直接抛
  // "The URL must be of scheme file"（真跑出来过一次）。vitest 的工作目录恒等于仓库根，
  // 所以按根拼路径。
  const 界面 = fs.readFileSync("src/App.tsx", "utf8");
  const 后端 = fs.readFileSync("crates/note-core/src/ai.rs", "utf8");

  it("两边都还在，且能各读到一次按钮名", () => {
    const 按钮 = /aiBusy === "models" \? "[^"]*" : "([^"]+)"/.exec(界面)?.[1];
    const 指引 = /pub const 发现按钮名: &str = "([^"]+)";/.exec(后端)?.[1];
    expect(按钮, "界面上那枚按钮的文案要还能被读到（改了写法就要同步改这条用例）").toBeTruthy();
    expect(指引, "后端那份常量要还在").toBeTruthy();
    expect(指引).toBe(按钮);
  });
});
