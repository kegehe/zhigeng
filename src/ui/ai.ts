import type { AiView } from "../ipc/types";

export type 齐 = Pick<AiView, "baseUrl" | "chatModel" | "embeddingModel">;

/**
 * 还差哪几项。**不含 Key**：本地模型（Ollama）不需要它，把"没填 Key"算成没配好
 * 会逼着用户去填一个用不上的格子。
 *
 * **也不含嵌入模型**（档 A）：DeepSeek、Anthropic 这类只有对话端点，Kimi 的嵌入要单独申请。
 * 留空不是"没配好"，是"语义那一路不开、检索只走关键词与链接"——一条正常配置。
 * 这一份与 `crates/note-core/src/ai.rs` 的 `缺项` 必须同规则。
 */
export function 缺项(v: 齐): string[] {
  const 空 = (s: string) => !s || !s.trim();
  const 缺: string[] = [];
  if (空(v.baseUrl)) 缺.push("base_url");
  if (空(v.chatModel)) 缺.push("chat_model");
  return 缺;
}

/**
 * 语义检索能不能走。**只看地址与嵌入模型**：对话模型是问答那一档的前提，
 * 拿它去挡检索等于让一个用不上的格子决定另一件事能不能跑。
 */
export function 可检索(v: Pick<AiView, "baseUrl" | "embeddingModel">): boolean {
  return !!v.baseUrl.trim() && !!v.embeddingModel.trim();
}

/**
 * 问答 / 选区改写能不能走。只认地址与对话模型——嵌入模型是检索那一路的事。
 * 与 `ai.rs` 的 `缺项` 同规则（那边把这两项算必填、嵌入留空是正常配置）。
 */
export function 可对话(v: Pick<AiView, "baseUrl" | "chatModel">): boolean {
  return !!v.baseUrl.trim() && !!v.chatModel.trim();
}

/**
 * 入口那枚角标。`测过` 是这一次会话里连通测试的结论（null = 还没测）。
 *
 * 为什么"测过"不持久化：重启之后还挂着"已连通"，说的其实是上一次开机时的事实。
 * 网络、Key、模型名都会变，那一格宁可回到"已配置"。
 *
 * **配齐但没测过说"已配置"，不返回空**（2026-10-27 拍板）。从前这一档返回 null，而调用方
 * 是 `aiView && 徽标(...) ? <span>AI·…</span> : null`——于是配齐之后那枚入口一个字都不显示，
 * 反而比"没配"更像没接上模型。角标一共四档，每一档都是一句可读的话：没配 / 已配置 / 不通 /
 * 能检索（或只对话）。**"没配"与"已配置"要能分开看**，否则用户只能点开设置才知道填过没有。
 */
export function 徽标(v: 齐, 测过: boolean | null): string {
  const 缺 = 缺项(v);
  if (缺.length) return "没配";
  if (测过 === false) return "不通";
  // 测过之后分两档说：能检索（两个探针都过、语义路开着）与只对话（检索暂时只有关键词与
  // 链接）。从前这里统一写"通了"，而它在嵌入模型留空时是一句半个谎——用户会以为搜索也在用模型。
  if (测过 === true) return 可检索(v) ? "能检索" : "只对话";
  return "已配置";
}

/** 角标该不该刺眼：只有"配齐了却连不上"才红，"没配"是中性事实 */
export function 徽标红(测过: boolean | null): boolean {
  return 测过 === false;
}

/** 测试报告里那一步的中文标题 */
export function 步骤名(stage: string): string {
  if (stage === "chat") return "对话模型";
  if (stage === "embeddings") return "嵌入模型";
  // 后端在嵌入模型留空时发这一步：请求根本没发，所以既不是通也不是不通
  if (stage === "embeddings-off") return "嵌入模型（未启用）";
  return "配置";
}

/**
 * 这一次真打了几个探针。**数出来而不是写死"两个"**——嵌入那一步可以整个不发，
 * 而"两个探针都通了"在只打了一个的时候是一句谎。
 */
export function 探针数(steps: { stage: string }[]): number {
  return steps.filter((s) => s.stage === "chat" || s.stage === "embeddings").length;
}

/** 报告标题那一句：通/不通由调用方判，这里只负责把"几个"说准 */
export function 探针结论(ok: boolean, steps: { stage: string }[]): string {
  if (!ok) return "有一步没通过";
  const n = 探针数(steps);
  if (n === 0) return "没有可测试的项目";
  return n === 1 ? "1 项测试通过" : `${n} 项测试都通过`;
}
