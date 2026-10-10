import { describe, expect, it } from "vitest";
import { 可检索, 徽标, 徽标红, 缺项, 步骤名 } from "./ai";

const 齐 = { baseUrl: "https://api.example.com/v1", chatModel: "gpt-x", embeddingModel: "emb-1" };

describe("AI 入口的角标", () => {
  it("三项全空时按用户该填的顺序报缺项", () => {
    expect(缺项({ baseUrl: "", chatModel: "", embeddingModel: "" })).toEqual([
      "base_url",
      "chat_model",
      "embedding_model",
    ]);
  });

  it("只缺嵌入模型时报那一项", () => {
    expect(缺项({ ...齐, embeddingModel: "" })).toEqual(["embedding_model"]);
  });

  it("只有空格也算没填", () => {
    expect(缺项({ ...齐, chatModel: "   " })).toEqual(["chat_model"]);
  });

  it("没配齐的角标是中性事实，不是红色警告", () => {
    expect(徽标({ ...齐, baseUrl: "" }, null)).toBe("没配");
    expect(徽标红(null)).toBe(false);
  });

  it("配齐了但没测过：不占角标位", () => {
    expect(徽标(齐, null)).toBe(null);
  });

  it("测过之后角标跟着结论走，只有不通才红", () => {
    expect(徽标(齐, true)).toBe("通了");
    expect(徽标红(true)).toBe(false);
    expect(徽标(齐, false)).toBe("不通");
    expect(徽标红(false)).toBe(true);
  });

  it("缺项时测没测都不给结论：没填齐根本不会发请求", () => {
    expect(徽标({ ...齐, chatModel: "" }, false)).toBe("没配");
  });

  it("报告里的 stage 有中文名", () => {
    expect(步骤名("chat")).toBe("对话模型");
    expect(步骤名("embeddings")).toBe("嵌入模型");
    expect(步骤名("config")).toBe("配置");
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
