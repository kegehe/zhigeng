import type { AiView } from "../ipc/types";

export type 齐 = Pick<AiView, "baseUrl" | "chatModel" | "embeddingModel">;

/** 还差哪几项。**不含 Key**：本地模型（Ollama）不需要它，把"没填 Key"算成没配好
 *  会逼着用户去填一个用不上的格子。 */
export function 缺项(v: 齐): string[] {
  const 空 = (s: string) => !s || !s.trim();
  const 缺: string[] = [];
  if (空(v.baseUrl)) 缺.push("base_url");
  if (空(v.chatModel)) 缺.push("chat_model");
  if (空(v.embeddingModel)) 缺.push("embedding_model");
  return 缺;
}

/**
 * 侧栏底部那枚入口的角标。`测过` 是这一次会话里连通测试的结论（null = 还没测）。
 *
 * 为什么"测过"不持久化：重启之后还挂着"已连通"，说的其实是上一次开机时的事实。
 * 网络、Key、模型名都会变，那一格宁可回到"已配置"。
 */
export function 徽标(v: 齐, 测过: boolean | null): string | null {
  const 缺 = 缺项(v);
  if (缺.length) return "没配";
  if (测过 === false) return "不通";
  if (测过 === true) return "通了";
  return null;
}

/** 角标该不该刺眼：只有"配齐了却连不上"才红，"没配"是中性事实 */
export function 徽标红(测过: boolean | null): boolean {
  return 测过 === false;
}

/** 测试报告里那一步的中文标题 */
export function 步骤名(stage: string): string {
  if (stage === "chat") return "对话模型";
  if (stage === "embeddings") return "嵌入模型";
  return "配置";
}
