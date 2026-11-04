import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from "react";

import { api, describeError, inTauri } from "../ipc/commands";
import type { DocEditBlock, DocEditPlan, DocEditTurn } from "../ipc/types";
import { 是回车提交 } from "../ui/keys";
import { 应用整篇编辑, 计划预览, 收集整篇 } from "./docEdit";
import { 工具图标 } from "./icons";
import { parseInline, type InlineMark } from "./inline";
import { 新运行号 } from "./runId";
import { 应用样式命令, 识别样式命令 } from "./styleCommand";
import {
   删除选区,
  取选段,
  段首记号问题,
  看选区,
  清空正文,
  替换选区,
  随事务,
  选区源,
  type 锚,
  type 选区概况,
} from "./rewrite";

/**
 * 文档底部的 AI 对话框。**它是唯一的 AI 入口**（2026-10-28 撤掉了工具栏与气泡上那两枚 ✨）。
 *
 * 三条不变量：
 *
 * 1. **它不写文档**。回稿只在自己身上累积，用户点「替换」才发一笔事务；AI 不静默改写
 *    （docs/04 §0）。替换后把新文字重新选中，下一句就接着改同一段——这才是"对话式改字"。
 * 2. **目标有先后**：选了字就改**选中的那段**，没选就是**整篇**（块级补丁，见 docEdit.ts）。
 *    没有"本段 / 整篇"开关：用户圈了哪儿、圈没圈，就是唯一的目标来源。选中原文直接显示
 *    在输入框上方，按下发送前就能核对改的是哪一段。
 * 3. **整篇正文只作背景**（有上限，超了截断并标明）。它是用户这次按下发送的明确动作，
 *    不是后台自动送出去的。这件事写在把手的 title 里——**不摆常驻说明文**（用户 2026-10-28
 *    要求去掉），但也不藏着。
 *
 * 悬浮展开 / 移开收起（用户 2026-10-28 定的交互），但**焦点在里面、正在生成、草稿还没发**
 * 时不许收：把用户正在读的字收走，比"多开一会儿"糟得多。右上角那枚钉住可以把自动收起
 * 关掉——读长回复时鼠标总要移开去滚动。
 */

type 轮 = {
  id: number;
  范围: "选区" | "整篇";
  /** 发起那一刻目标有多长。落笔之后 `目标` 会被换成新文（它还要跟着后续事务平移），
   *  历史条目上那个"N 字"不许跟着变——它记的是"当时让模型改了多长一段" */
  目标字数: number;
  问: string;
  /** 模型改写轮的锚点；整篇清空轮没有单段目标，是 null */
  目标: 锚 | null;
  /** 整篇清空发起时的文档快照；模型改写轮为 null。确认时逐节点比对，改过就作废 */
  快照: EditorState["doc"] | null;
  /** 整篇清空轮（本地确定性操作，不发给模型） */
  整篇: boolean;
  /** 整篇编辑轮：模型返回块级补丁，预览后才应用 */
  整篇编辑: boolean;
  /** 整篇编辑的计划（含 edits / note / 用量）；空计划也保留，界面要说"不用改" */
  计划: DocEditPlan | null;
  /** 整篇编辑已经被取消：与"已应用"分开记 */
  已取消: boolean;
  /** 已应用的编辑条数（清掉计划后历史仍要说清改了几处） */
  应用数: number;
  /** 模型在计划里写的说明。`计划` 应用 / 取消后会清空，这一份留给下一轮历史 */
  注: string;
  答: string;
  想: number;
  busy: boolean;
  错: string | null;
  /** 错误类型（来自后端 `kind`）：空回稿要另给删除确认，不靠匹配文案 */
  错类: string;
  量: string | null;
  /** 已经落进正文：再点一次「替换」就是重复插入，按钮要换掉 */
  已落: boolean;
  /** 这一轮已经确认删除过：与"替换"分开记，历史里说清发生了什么 */
  已删: boolean;
  /** 本地确定性执行（样式动词）：没有调用模型，也没有「替换」这一步 */
  本地: boolean;
};

/**
 * 回稿的样式预览。走的是与落笔**同一份** `parseInline`：预览里看到什么，替换进正文就是
 * 什么——两处各解析一套的话，样式预览就成了另一句话。链接只显示、不可点：这里是预览区，
 * 点一下把用户带离文档不是它的职责。
 */
function 包标(文字: ReactNode, m: InlineMark): ReactNode {
  switch (m.name) {
    case "bold":
      return <strong>{文字}</strong>;
    case "italic":
      return <em>{文字}</em>;
    case "strike":
      return <del>{文字}</del>;
    case "code":
      return <code>{文字}</code>;
    case "highlight":
      return <mark>{文字}</mark>;
    case "sup":
      return <sup>{文字}</sup>;
    case "sub":
      return <sub>{文字}</sub>;
    case "textColor":
      return <span style={{ color: m.color }}>{文字}</span>;
    case "bgColor":
      return <span style={{ background: m.color }}>{文字}</span>;
    case "link":
      return (
        <span className="ai-inline-link" title={m.href}>
          {文字}
        </span>
      );
    default:
      return 文字;
  }
}

function 富文({ 文 }: { 文: string }) {
  return (
    <>
      {parseInline(文).map((n, i) => {
        let 节点: ReactNode = n.text;
        // `parseInline` 的 marks[0] 是最内层：从内往外包，最后包上的是最外层
        for (const m of n.marks) 节点 = 包标(节点, m);
        return <Fragment key={i}>{节点}</Fragment>;
      })}
    </>
  );
}

const 字数 = (s: string) => [...s].length;

/** 选区预览只比较"看得到的那些"；对象每次新造，不比较就等于每敲一个字重画一遍 */
function 同选区(a: 选区概况 | null, b: 选区概况 | null): boolean {
  if (a === null || b === null) return a === b;
  return a.text === b.text && a.能用 === b.能用 && a.why === b.why;
}

/** 整篇清空是**另一档**：它不经过模型的"换一段"，而是用户确认后清掉全部正文 */
function 是整篇清空要求(问: string): boolean {
  if (/格式|样式|排版/.test(问)) return false;
  /**
   * **整句就是一个清空命令**才认，不做"删 + 整篇"的宽匹配。宽匹配会把
   * 「删掉整篇里多余的空行」「不要整篇重写，只改第二段」「整篇删减一半」都读成
   * "清空整篇"——用户只是要在整篇范围内改一处，却弹出清空确认，按下去就全没了。
   * 归一只削礼貌头尾、`把/将` 和标点，不碰句子中间的字。
   */
  const s = 问
    .trim()
    .replace(/^(?:请你|请|麻烦你|麻烦|帮我|帮忙|能不能|可以|你)/, "")
    .replace(/^(?:把|将)/, "")
    .replace(/^[\s，。！？、；：""''（）()【】「」《》,.!?;:'"`~]+|[\s，。！？、；：""''（）()【】「」《》,.!?;:'"`~]+$/g, "")
    .replace(/(?:一下|吧|呢|呗|谢谢|好吗|可以吗|行吗)$/, "");
  const 范围 =
    "(?:(?:整篇|全文|全篇)(?:的)?(?:内容|正文|文字|文本|文档|笔记)?|整个文档|文档内容|全部内容|所有内容)";
  const 动词 = "(?:删掉|删除|删光|清空|清掉|清除|移除|抹掉|去掉)";
  const 前缀 = "(?:(?:这|本|该)?(?:篇|个)?(?:笔记|文档)?(?:的)?)";
  return (
    new RegExp(`^${动词}(?:一下)?${前缀}${范围}(?:都|全部|全都|全)?$`).test(s) ||
    new RegExp(`^${前缀}${范围}(?:都|全部|全都|全)?(?:一下)?${动词}$`).test(s)
  );
}

/** 只有用户明确说要删，才在空回稿旁给删除确认：模型偶尔回空不是删除许可证 */
function 是删除要求(问: string): boolean {
  if (是整篇清空要求(问)) return false;
  if (/格式|样式|排版/.test(问)) return false;
  // 「不要删掉这段」「别把它去掉」是在**禁止**删除：再给一枚删除钮就反着来了
  if (
    /(?:不要|别|不用|不必|无需|不需要)(?:把|将)?(?:它|这|那|这段|本段|这一块|那块|整篇|全篇)?(?:删|去掉|移除|清除|清空|抹掉)/.test(
      问,
    )
  ) {
    return false;
  }
  return /删|清空|清掉|清除|去掉|移除|抹掉/.test(问);
}

/**
 * 带进整篇请求的最近对话。只带整篇那几轮的问与答（计划 JSON 不带），
 * 用来接住"再改正式一点""第二点展开说"这类指代；文档本身仍以块清单为准。
 * 与后端上限同口径：最多 8 条、共 6000 字；单条先截到 2000 字。
 */
function 整理历史(轮们: 轮[]): DocEditTurn[] {
  const 平: DocEditTurn[] = [];
  for (const t of 轮们) {
    if (t.范围 !== "整篇" || t.整篇) continue;
    const 问 = t.问.trim();
    if (问) 平.push({ role: "user", text: 问 });
    const 答 = (t.注 || t.计划?.note || t.答 || "").trim();
    if (答) 平.push({ role: "assistant", text: 答 });
  }
  const 取: DocEditTurn[] = [];
  let 总 = 0;
  for (let i = 平.length - 1; i >= 0 && 取.length < 8; i--) {
    const 条 = 平[i]!;
    const 剩 = 6000 - 总;
    if (剩 <= 0) break;
    const 文 = [...条.text].slice(0, Math.min(2000, 剩)).join("");
    if (!文) continue;
    取.unshift({ role: 条.role, text: 文 });
    总 += [...文].length;
  }
  return 取;
}

/** 与工具栏同一套按钮基线；这里只差字号，不另发明一套 */
const 钮 =
  "rounded-md border border-line px-2 py-0.5 text-xs text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover active:translate-y-px disabled:opacity-55";
const 主钮 =
  "rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:opacity-55";
const 危钮 =
  "rounded-md border border-danger px-2 py-0.5 text-xs text-danger transition-colors duration-(--dur-1) hover:bg-danger-soft active:translate-y-px disabled:opacity-55";

export const AiDock = memo(function AiDock({
  editor,
  aiReady,
  全文,
  rel,
  onNeedEdit,
  onApplied,
  onNotice,
}: {
  editor: Editor;
  /** 这一篇的 rel：只用来让后端查隐私位（私密篇不发整篇背景） */
  rel: string;
  /** 对话模型配好没有（地址 + 对话模型）。没配时不发请求，把下一步说清楚 */
  aiReady: boolean;
  /** 整篇正文（不含 front-matter），每次发送时现取 */
  全文: () => string;
  /** 落笔前先切成编辑态：浏览态 persist 直接 return，改了不会写盘 */
  onNeedEdit: () => void;
  /** 已经改过正文：让 App 记一次脏（dock 在 BlockEditor 外面，收不到它的 onUpdate） */
  onApplied: () => void;
  onNotice?: (文: string) => void;
}) {
  const [开, set开] = useState(false);
  /** 钉住：不随鼠标移开收起 */
  const [钉, set钉] = useState(false);
  const [草稿, set草稿] = useState("");
  const [轮们, set轮们] = useState<轮[]>([]);
  const [总错, set总错] = useState<string | null>(null);
  /** 正在等用户二次确认的那一轮（null = 没有） */
  const [待确认删, set待确认删] = useState<number | null>(null);
  /** 当前选区（null = 没选字，这一次按"整篇"处理）。只用于显示与目标判定 */
  const [选区, set选区] = useState<选区概况 | null>(null);

  const 盒 = useRef<HTMLDivElement | null>(null);
  const 把手 = useRef<HTMLButtonElement | null>(null);
  const 输入 = useRef<HTMLTextAreaElement | null>(null);
  const 记录 = useRef<HTMLDivElement | null>(null);
  /** 手上这一趟的号（0 = 没有请求）。流里来的字号对不上就丢——连发两句时靠它 */
  const 号 = useRef(0);
  const 当前 = useRef<number | null>(null);
  const 序 = useRef(0);
  const 收钟 = useRef<number | null>(null);
  const 开钟 = useRef<number | null>(null);
  /** 这一次展开是**点开的**（不是悬浮）：点开的才把焦点放进输入框，悬浮不许抢 */
  const 想焦点 = useRef(false);
  /** 用面板里的「收起」或 Esc 关掉时，把焦点交给重新出现的把手（否则键盘用户落在 body 上） */
  const 想焦点把手 = useRef(false);
  /** 指针是不是停在这只坞上。用来区分"鼠标真的移开了"与"面板里点空白导致失焦" */
  const 悬停 = useRef(false);

  const 忙 = 轮们.some((t) => t.busy);
  const 忙ref = useRef(忙);
  忙ref.current = 忙;
  const 草稿ref = useRef(草稿);
  草稿ref.current = 草稿;
  const 钉ref = useRef(钉);
  钉ref.current = 钉;

  // 流式回稿。只装一次：号码对不上就丢（与原来的改写浮层同一条纪律）
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    let 拆: (() => void) | undefined;
    const 订 = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const 加 = (id: number, 字: string, 思考: boolean) => {
        set轮们((旧) =>
          旧.map((t) => {
            if (t.id !== id) return t;
            // 已经定稿（busy=false）就不再收字：事件是排队送来的，最后几个可能比 Promise 晚到
            if (!t.busy) return t;
            return 思考 ? { ...t, 想: t.想 + 字.length } : { ...t, 答: t.答 + 字 };
          }),
        );
      };
      const a = await listen<{ runId: number; text: string }>("ai://rewrite-token", (e) => {
        if (!alive || e.payload.runId !== 号.current || 当前.current === null) return;
        加(当前.current, e.payload.text, false);
      });
      const b = await listen<{ runId: number; text: string }>("ai://rewrite-think", (e) => {
        if (!alive || e.payload.runId !== 号.current || 当前.current === null) return;
        加(当前.current, e.payload.text, true);
      });
      return () => {
        a();
        b();
      };
    };
    void 订().then((f) => {
      if (alive) 拆 = f;
      else f();
    });
    return () => {
      alive = false;
      拆?.();
    };
  }, []);

  // 等回稿期间用户改了别处：锚点跟着事务走，落笔时再核一次字节
  useEffect(() => {
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      set轮们((旧) => {
        // 已经落进正文的那几轮不再用锚点（按钮已禁用），不必为它们重算
        if (!旧.some((t) => !t.已落)) return 旧;
        let 动 = false;
        const 新 = 旧.map((t) => {
          if (t.已落 || t.目标 === null) return t;
          const 锚 = 随事务(t.目标, transaction);
          if (锚.from === t.目标.from && 锚.to === t.目标.to) return t;
          动 = true;
          return { ...t, 目标: 锚 };
        });
        // 位置没变就返回**同一个数组**：每敲一个字都造新数组，等于给打字路径白加一次
        // 重渲染（G6），顺带还会把记录区重新滚到底（见下面那条 effect 的依赖）
        return 动 ? 新 : 旧;
      });
    };
    editor.on("transaction", onTr);
    return () => {
      editor.off("transaction", onTr);
    };
  }, [editor]);

  // 选区预览：圈了哪儿就显示哪儿。trans 一起听——在选区内部改字时选区端点可能没动，
  // 但显示的原文已经不一样了；比较过才换 state，避免每敲一个字重画一次。
  useEffect(() => {
    const 更 = () => {
      const 新 = 看选区(editor.state);
      set选区((旧) => (同选区(旧, 新) ? 旧 : 新));
    };
    更();
    editor.on("selectionUpdate", 更);
    editor.on("transaction", 更);
    return () => {
      editor.off("selectionUpdate", 更);
      editor.off("transaction", 更);
    };
  }, [editor]);

  useEffect(() => {
    if (!开 && 待确认删 !== null) set待确认删(null);
  }, [开, 待确认删]);

  const 末轮 = 轮们.length ? 轮们[轮们.length - 1]! : null;
  const 末答长 = 末轮 ? 末轮.答.length : 0;

  /**
   * 新的一轮到了、末尾那条正在变长、或重新展开时，把记录滚到底：正在写的那个字不该在
   * 可视区外面。**依赖刻意不写 `轮们`**：锚点跟随事务也会换数组，按它触发等于用户每敲
   * 一个字就把记录拽回底部——钉住读长回复时最难受的就是这个。
   */
  useEffect(() => {
    const el = 记录.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [轮们.length, 末答长, 开]);

  /**
   * 输入框随内容长高，封顶 9rem（再长就内部滚）。**不做 auto-grow 的话，一句话写两行
   * 就得在小框里推着看**；做成了又必须封顶，否则贴一段长指令会把整块正文盖掉。
   */
  useEffect(() => {
    const el = 输入.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [草稿, 开]);

  const 清收 = () => {
    if (收钟.current !== null) {
      window.clearTimeout(收钟.current);
      收钟.current = null;
    }
  };
  const 清开 = () => {
    if (开钟.current !== null) {
      window.clearTimeout(开钟.current);
      开钟.current = null;
    }
  };

  /**
   * 安排一次"移开就收"。**失焦与指针移开走同一条路**，但判据里要分开：
   * 在面板里点一下空白处会让输入框失焦，而鼠标根本没走——那种情况收掉面板，
   * 用户会觉得"我就点了下空白，怎么没了"。
   */
  const 安排收 = () => {
    清开();
    清收();
    收钟.current = window.setTimeout(() => {
      收钟.current = null;
      const 焦点在 = 盒.current?.contains(document.activeElement) ?? false;
      if (悬停.current || 钉ref.current || 焦点在 || 忙ref.current || 草稿ref.current.trim()) {
        return;
      }
      set开(false);
    }, 260);
  };
  const 悬入 = () => {
    悬停.current = true;
    清收();
    清开();
    if (开) return;
    开钟.current = window.setTimeout(() => {
      开钟.current = null;
      set开(true);
    }, 120);
  };
  const 悬出 = () => {
    悬停.current = false;
    安排收();
  };

  useEffect(() => {
    if (!开) return;
    const onKey = (e: KeyboardEvent) => {      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      // 只收自己：别的浮层（命令面板、设置）的 Esc 不归这里管
      e.preventDefault();
      // 焦点本来在面板里：面板一卸载就落到 body 上，交给重新出现的把手。
      // 焦点在正文里（只是把面板开着）就**不许抢**——那是用户正在写字的地方。
      想焦点把手.current = 盒.current?.contains(document.activeElement) ?? false;
      set开(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [开]);

  useEffect(
    () => () => {
      清收();
      清开();
    },
    [],
  );

  // 点开之后才拿焦点：悬浮展开时正文还在用，抢焦点等于把用户的光标抢走
  useEffect(() => {
    if (!开 || !想焦点.current) return;
    想焦点.current = false;
    输入.current?.focus();
  }, [开]);

  // 收起之后把焦点还给把手：面板里的按钮随面板一起卸载，不接住就落到 body 上
  useEffect(() => {
    if (开 || !想焦点把手.current) return;
    想焦点把手.current = false;
    把手.current?.focus();
  }, [开]);

  const 发起 = async (令: string, 锚: 锚, 目标字数: number) => {
    const id = ++序.current;
    const 本号 = (号.current = 新运行号());
    当前.current = id;
    set待确认删(null);
    // 现取一遍：整篇正文作背景，长度留给界面说"带没带上"
    const 背景 = 全文();
    set轮们((旧) =>
      [
        ...旧,
        {
          id,
          范围: "选区" as const,
          目标字数,
          问: 令,
          目标: 锚,
          快照: null,
          整篇: false,
          整篇编辑: false,
          计划: null,
          已取消: false,
          应用数: 0,
          注: "",
          答: "",
          想: 0,
          busy: true,
          错: null,
          错类: "",
          量: null,
          已落: false,
          已删: false,
          本地: false,
        },
      ].slice(-30),
    );
    // 点「发送」时焦点在按钮上，按钮随即变灰会把它甩给 body；回车路径本来就在框里。
    // 统一把焦点放回输入框：回完字就能接着写下一句，不用重新点一下。
    输入.current?.focus();
    try {
      // 审计里的预设标签固定记 custom：对话框只有一句话，没有预设档
      // 发的是**带行内样式的原文**（选区切片的 Markdown 序列化）：只发纯文字的话，
      // "改得正式一点"会把加粗 / 颜色一起洗掉。审计里仍只记字数，不存内容。
      const 果 = await api.aiRewrite(选区源(editor.state, 锚), 令, "custom", 本号, 背景, rel);
      if (本号 !== 号.current) return;
      // 背景发了却没进账 = 后端按隐私位挡掉了（私密篇），把这件事说出来，不装作"没背景"。
      // **按 trim 后的长度判**：空笔记的正文只有一个换行，后端也会把它当"没背景"，那种情况
      // 不能反过来说"私密篇"——同一份判据（后端 trim 后才算背景字）。
      const 背景话 = 果.ctxChars
        ? `｜背景 ${果.ctxChars} 字`
        : 背景.trim()
          ? "｜私密篇：只发了目标段"
          : "";
      set轮们((旧) =>
        旧.map((t) =>
          t.id === id
            ? {
                ...t,
                答: 果.text,
                busy: false,
                量: `${果.model}｜in ${果.inTokens} / out ${果.outTokens}｜${果.ms}ms${背景话}`,
              }
            : t,
        ),
      );
      // 定稿到手就把号归零：事件是排队送来的，**最后几个 token 可能比 Promise 晚到**，
      // 不归零它们会接在定稿后面，变成重复的一截
      号.current = 0;
    } catch (e) {
      if (本号 !== 号.current) return;
      const 描 = describeError(e);
      set轮们((旧) =>
        旧.map((t) =>
          t.id === id
            ? // 流到一半的那截不能留：它可能正是被判多行而拒收的那份
              { ...t, 答: "", busy: false, 错: 描.message, 错类: 描.kind }
            : t,
        ),
      );
      号.current = 0;
    }
  };

  /**
   * 整篇清空轮：**不发给模型**。这是确定性删除，模型能起的只是"要不要删"的判断，
   * 而用户已经把话说清楚了；把整篇正文交给模型再等一个空答案，既多花钱也多一个
   * 隐私面。它仍然只提议——正文要等用户在二次确认里按下「确认清空」才动。
   */
  const 发起整篇清空 = (令: string) => {
    const id = ++序.current;
    当前.current = null;
    set待确认删(null);
    set轮们((旧) =>
      [
        ...旧,
        {
          id,
          范围: "整篇" as const,
          目标字数: 字数(全文()),
          问: 令,
          目标: null,
          快照: editor.state.doc,
          整篇: true,
          整篇编辑: false,
          计划: null,
          已取消: false,
          应用数: 0,
          注: "",
          答: "",
          想: 0,
          busy: false,
          错: null,
          错类: "",
          量: null,
          已落: false,
          已删: false,
          本地: false,
        },
      ].slice(-30),
    );
    输入.current?.focus();
  };

  /**
   * 整篇编辑轮：把块清单发给模型，拿回**块级补丁**。模型只提议——计划先显示在对话框里，
   * 用户点「应用修改」才落一笔事务；未涉及的块与块 id 都原样保留。
   */
  const 发起整篇编辑 = async (
    令: string,
    blocks: DocEditBlock[],
    history: DocEditTurn[],
  ) => {
    const id = ++序.current;
    当前.current = null;
    set待确认删(null);
    set轮们((旧) =>
      [
        ...旧,
        {
          id,
          范围: "整篇" as const,
          目标字数: 字数(全文()),
          问: 令,
          目标: null,
          快照: editor.state.doc,
          整篇: false,
          整篇编辑: true,
          计划: null,
          已取消: false,
          应用数: 0,
          注: "",
          答: "",
          想: 0,
          busy: true,
          错: null,
          错类: "",
          量: null,
          已落: false,
          已删: false,
          本地: false,
        },
      ].slice(-30),
    );
    输入.current?.focus();
    try {
      const 果 = await api.aiDocEdit(blocks, 令, rel, history);
      if (序.current !== id) return;
      set轮们((旧) =>
        旧.map((t) =>
          t.id === id
            ? {
                ...t,
                busy: false,
                计划: 果,
                注: 果.note ?? "",
                量: `${果.model}｜in ${果.inTokens} / out ${果.outTokens}｜${果.ms}ms｜整篇 ${果.blocks} 块`,
              }
            : t,
        ),
      );
    } catch (e) {
      if (序.current !== id) return;
      const 描 = describeError(e);
      set轮们((旧) =>
        旧.map((t) =>
          t.id === id ? { ...t, busy: false, 错: 描.message, 错类: 描.kind } : t,
        ),
      );
    }
  };

  /**
   * 本地执行的一轮：**没有请求、没有「替换」**，结果当场已经落进正文。
   * 记在历史里是为了让用户看得见"刚才是本地做的"——不然字变了、对话里却没有痕迹，
   * 下一次会以为模型改的（进而去别处找撤销）。
   */
  const 记本地 = (令: string, 锚: 锚, 说明: string, 改了: boolean) => {
    const id = ++序.current;
    当前.current = null;
    set待确认删(null);
    set轮们((旧) =>
      [
        ...旧,
        {
          id,
          范围: "选区" as const,
          目标字数: 字数(锚.text),
          问: 令,
          目标: 锚,
          快照: null,
          整篇: false,
          整篇编辑: false,
          计划: null,
          已取消: false,
          应用数: 0,
          注: "",
          答: 说明,
          想: 0,
          busy: false,
          错: null,
          错类: "",
          量: 改了 ? "本地执行｜未调用模型｜Ctrl+Z 可撤销" : "本地执行｜未调用模型｜没有改动",
          已落: true,
          已删: false,
          本地: true,
        },
      ].slice(-30),
    );
  };

  const 发 = async () => {
    const 令 = 草稿.trim();
    if (!令 || 忙) return;
    // 整篇清空不依赖模型：没有 Key、断网也能用；仍然要用户二次确认
    if (是整篇清空要求(令)) {
      if (!editor.state.doc.textContent.trim()) {
        set总错("正文已经是空的，没有可清空的内容");
        set开(true);
        return;
      }
      set总错(null);
      // **发送不动编辑态**：确认那一下再切（见 `清整整篇`）
      set草稿("");
      set开(true);
      发起整篇清空(令);
      return;
    }
    // 有选区就改选中的那段；没选区就是整篇（块级补丁）。**不按光标位置兜底**：
    // 用户没圈字时想要的是"对这篇说话"，不是悄悄改光标底下那一段。
    // 判据现取 editor.state，不用上面那个显示用的 state——它可能比编辑器慢一拍。
    const 选 = editor.state.selection.empty ? null : 取选段(editor.state);
    // 选区不成立时先说选区：没配模型时两件事都挡着，但用户刚圈了字，
    // "选区跨了多块"才是这一下的直接原因
    if (选 && !选.ok) {
      set总错(选.why);
      set开(true);
      return;
    }
    /**
     * 显式样式动词走本地：**不花钱、不等网络、没有「替换」那一步**（2026-11-02）。
     * 排在 `aiReady` 前面——"把这段加粗"本来就不需要模型，没配 Key 也该做得成。
     * 识别是整句比对，带内容要求的句子（"加粗一点顺便改得更正式"）仍然交给模型。
     */
    if (选?.ok) {
      const 命 = 识别样式命令(令);
      if (命) {
        const 果 = 应用样式命令(editor.state, 选.锚, 命);
        set总错(null);
        set草稿("");
        set开(true);
        if (果.tr) {
          // 与「替换」同一条纪律：落笔前先把只读的笔记翻进编辑态，否则保存层直接 return
          if (!editor.isEditable) onNeedEdit();
          editor.view.dispatch(果.tr.scrollIntoView());
          editor.view.focus();
          onApplied();
        }
        记本地(令, 选.锚, 果.说明, Boolean(果.tr));
        return;
      }
    }
    if (!aiReady) {
      set总错("还没配模型：先打开设置，在「模型与 Key」里填好接口地址和对话模型");
      set开(true);
      return;
    }
    if (!选) {
      const 收 = 收集整篇(editor.state);
      if (!收.ok) {
        set总错(收.why);
        set开(true);
        return;
      }
      set总错(null);
      // **发送不动编辑态**：用户点「应用修改」那一下再切（见 `应用整篇`）
      set草稿("");
      set开(true);
      await 发起整篇编辑(令, 收.blocks, 整理历史(轮们));
      return;
    }
    set总错(null);
    // **发送不动编辑态**：问一句不该把只读的笔记翻进编辑。切态放到落笔那一下（见 `落`）
    set草稿("");
    await 发起(令, 选.锚, 字数(选.锚.text));
  };

  /**
   * 错误那一轮的「重试」（方案 G·错误态）：沿用**同一句问话与同一段目标**——锚一直跟着
   * 事务走，落笔前还会再核一次字节。旧的那轮留在历史里不动：出错不吞掉已有对话。
   */
  const 重发 = async (t: 轮) => {
    if (忙 || t.整篇 || t.整篇编辑 || !t.目标) return;
    set总错(null);
    await 发起(t.问, t.目标, t.目标字数);
  };

  /** 复制失败要说出来：某些 WebView 环境下 navigator.clipboard 直接不存在，静默失败最糟 */
  const 复制 = async (文: string) => {
    try {
      await navigator.clipboard.writeText(文);
      onNotice?.("已复制");
    } catch {
      onNotice?.("复制失败：这个环境没给剪贴板权限");
    }
  };

  const 落 = (t: 轮) => {
    if (!t.目标) return;
    // 说清是哪一条：`替换选区` 对"记号"和"锚点失鲜"都只回 null，
    // 界面上若都报"被改过"，用户会去重选一遍，然后拿到同一份回稿再撞一次。
    const 记号 = 段首记号问题(editor.state, t.目标, t.答);
    if (记号) {
      set轮们((旧) =>
        旧.map((x) => (x.id === t.id ? { ...x, 错: 记号, 错类: "error" } : x)),
      );
      return;
    }
    const 果 = 替换选区(editor.state, t.目标, t.答, true);
    if (!果) {
      set轮们((旧) =>
        旧.map((x) =>
          x.id === t.id
            ? { ...x, 错: "目标那段文字在这期间被改过，这次没有替换。重新选一下再试" }
            : x,
        ),
      );
      return;
    }
    if (!editor.isEditable) onNeedEdit();
    editor.view.dispatch(果.tr.scrollIntoView());
    // 焦点给回正文：改完通常接着写；顺带让"鼠标移开就收"重新生效（焦点留在按钮里就收不了）
    editor.view.focus();
    // 新文整段选中：下一句接着改同一段（对话式改字的连续性就靠这一下）。
    // 锚点用**落进文档的那份纯文字**：回稿可能带 `**` 之类的标记，拿原串算长度会偏。
    const 新锚: 锚 = { from: t.目标.from, to: t.目标.from + 果.文.length, text: 果.文 };
    set轮们((旧) =>
      旧.map((x) => (x.id === t.id ? { ...x, 目标: 新锚, 已落: true, 错: null } : x)),
    );
    onApplied();
    // 不再走全局 flash：它渲染在正文顶部，深文档里滚到中间时正好在屏幕外，
  };

  /** 删除这一轮锚定的文字。**只在用户二次确认后调用**；锚点失鲜就拒绝，绝不猜 */
  const 删 = (t: 轮) => {
    if (!t.目标) return;
    const 目标 = t.目标;
    const tr = 删除选区(editor.state, 目标);
    set待确认删(null);
    if (!tr) {
      set轮们((旧) =>
        旧.map((x) =>
          x.id === t.id
            ? {
                ...x,
                错: "目标那段文字在这期间被改过，这次没有删除。重新选一下再试",
                错类: "error",
              }
            : x,
        ),
      );
      return;
    }
    if (!editor.isEditable) onNeedEdit();
    editor.view.dispatch(tr.scrollIntoView());
    // 焦点给回正文：删完通常接着写；也顺带让"鼠标移开就收"重新生效
    editor.view.focus();
    set轮们((旧) =>
      旧.map((x) =>
        x.id === t.id
          ? {
              ...x,
              目标: { from: 目标.from, to: 目标.from, text: "" },
              已落: true,
              已删: true,
              错: null,
              错类: "",
            }
          : x,
      ),
    );
    onApplied();
  };

  /**
   * 清空整篇正文。**只在用户二次确认后调用**；与段落删除同一套安全线：
   * 快照逐节点比对，确认期间改过一个字就作废；一笔事务，Ctrl+Z 一步回来。
   * front-matter 不在编辑器里，保存时由 `docToMarkdown` 原样保留。
   */
  const 清整整篇 = (t: 轮) => {
    if (!t.快照) return;
    const tr = 清空正文(editor.state, t.快照);
    set待确认删(null);
    if (!tr) {
      set轮们((旧) =>
        旧.map((x) =>
          x.id === t.id
            ? {
                ...x,
                错: "文档在这期间被改过，这次没有清空；请重新发起",
                错类: "error",
              }
            : x,
        ),
      );
      return;
    }
    if (!editor.isEditable) onNeedEdit();
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
    set轮们((旧) =>
      旧.map((x) =>
        x.id === t.id
          ? {
              ...x,
              快照: null,
              已落: true,
              已删: true,
              错: null,
              错类: "",
            }
          : x,
      ),
    );
    onApplied();
  };

  /** 应用整篇编辑计划：全有或全无；任何 id / 类型 / 换行问题整份拒绝，正文不动 */
  const 应用整篇 = (t: 轮) => {
    if (!t.快照 || !t.计划) return;
    const 果 = 应用整篇编辑(editor.state, t.快照, t.计划);
    if (!果.ok) {
      set轮们((旧) =>
        旧.map((x) =>
          x.id === t.id ? { ...x, 错: 果.why, 错类: "error" } : x,
        ),
      );
      return;
    }
    if (!editor.isEditable) onNeedEdit();
    editor.view.dispatch(果.tr.scrollIntoView());
    editor.view.focus();
    set轮们((旧) =>
      旧.map((x) =>
        x.id === t.id
          ? {
              ...x,
              计划: null,
              快照: null,
              已落: true,
              应用数: 果.应用数,
              错: null,
              错类: "",
            }
          : x,
      ),
    );
    onApplied();
  };

  const 取消整篇 = (t: 轮) => {
    set轮们((旧) =>
      旧.map((x) =>
        x.id === t.id ? { ...x, 已取消: true, 计划: null, 快照: null } : x,
      ),
    );
  };

  const 可删 = (t: 轮) =>
    !t.整篇 &&
    !t.整篇编辑 &&
    t.错类 === "empty-answer" &&
    !t.busy &&
    !t.已落 &&
    !t.已删 &&
    是删除要求(t.问);

  // 预览只放看得完的那一段：全选整篇时 DOM 里塞几万字没有意义，字数照实显示
  const 选区预览 = 选区
    ? 选区.text.length > 1200
      ? 选区.text.slice(0, 1200) + "…"
      : 选区.text
    : "";

  return (
    <div
      className="ai-dock"
      ref={盒}
      onPointerEnter={悬入}
      onPointerLeave={悬出}
      onFocusCapture={清收}
      onBlurCapture={(e) => {
        // 不能走「悬出」：那会把"指针还在坞上"记成离开，点一下面板空白就把自己收掉
        if (!盒.current?.contains(e.relatedTarget as Node | null)) 安排收();
      }}
    >
      {开 ? (
        <div
          className={轮们.length || 总错 ? "ai-dock-panel has-log" : "ai-dock-panel"}
          role="dialog"
          aria-label="AI 编辑"
        >
          {/* 标题行（方案 G）：左边一句「AI 编辑」，右边还是钉住 + 收起两枚图标。
              收起放这里，面板展开时下面就不再挂一颗把手 */}
          <div className="ai-dock-head">
            <span className="ai-dock-title">AI 编辑</span>
            <div className="ai-dock-tools">
              <button
                type="button"
                className={钉 ? "ai-dock-ic on" : "ai-dock-ic"}
                title={钉 ? "取消钉住（移开就收）" : "钉住，不随鼠标移开收起"}
                aria-label={钉 ? "取消钉住" : "钉住"}
                aria-pressed={钉}
                onClick={() => set钉((v) => !v)}
              >
                <工具图标.pin />
              </button>
              <button
                type="button"
                className="ai-dock-ic"
                title="收起（Esc）"
                aria-label="收起"
                onClick={() => {
                  想焦点把手.current = true;
                  set开(false);
                }}
              >
                <工具图标.chevronDown />
              </button>
            </div>
          </div>

          {/* 没有消息时这块由 CSS 的 :empty 收掉：对话框是说话的地方，不摆说明文 */}
          <div className="ai-dock-log" ref={记录}>
            {轮们.map((t) => (
              <div className="ai-turn" key={t.id}>
                <div className="ai-turn-q">
                  <span className="ai-turn-tag">
                    {t.范围} {t.目标字数} 字
                  </span>
                  {t.问}
                </div>
                {t.答 || t.busy ? (
                  <div className="ai-turn-a">
                    <p>
                      {/* 定稿按行内 Markdown 画：预览里看到的样式就是「替换」后进正文的样式。
                          流式中途仍按纯文字显示——半截的 `**` 画出来只是闪烁 */}
                      {t.答 && !t.busy && t.范围 === "选区" && !t.本地 ? (
                        <富文 文={t.答} />
                      ) : (
                        t.答
                      )}
                      {t.busy ? <span className="ai-caret" aria-hidden="true" /> : null}
                    </p>
                    {t.busy ? (
                      <p className="ai-turn-meta">
                        {t.想 ? `正在思考…（${t.想} 字）` : "正在等待回应…"}
                        {t.答 ? `｜已到 ${字数(t.答)} 字` : ""}
                      </p>
                    ) : null}
                    {t.答 && !t.busy ? (
                      <div className="ai-turn-actions">
                        {t.本地 ? (
                          // 本地那一轮已经落进正文：没有东西可「替换」，也没有费用
                          <span className="ai-turn-meta">{t.量}</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={主钮}
                              disabled={t.已落}
                              onClick={() => 落(t)}
                              title={
                                t.已落
                                  ? "这一轮已经替换过了"
                                  : "把选中的这段换进正文（Ctrl+Z 可撤销）"
                              }
                            >
                              {t.已落 ? "已替换" : "替换选中"}
                            </button>
                            <button
                              type="button"
                              className={钮}
                              onClick={() => void 复制(t.答)}
                            >
                              复制
                            </button>
                            {t.已落 ? (
                              <span className="ai-turn-meta">已写进正文，Ctrl+Z 可撤销</span>
                            ) : t.量 ? (
                              <span className="ai-turn-meta ai-turn-usage">{t.量}</span>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {t.错 ? <p className="ai-turn-err">{t.错}</p> : null}
                {/* 错误态的操作（方案 G）：一句话说原因，重试就在手边；不吞掉已有对话。
                    空回稿且用户确实要删时，多给一枚**二次确认**的删除钮——AI 只提议，
                    落笔必须由用户按下确认；删除是一笔可撤销事务 */}
                {t.错 && !t.busy ? (
                  <div className="ai-turn-actions">
                    {可删(t) ? (
                      待确认删 === t.id ? (
                        <>
                          <button
                            type="button"
                            className={危钮}
                            onClick={() => 删(t)}
                            title="删除锚定的这段文字（Ctrl+Z 可撤销）"
                          >
                            确认删除
                          </button>
                          <button
                            type="button"
                            className={钮}
                            onClick={() => set待确认删(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={危钮}
                          onClick={() => set待确认删(t.id)}
                          title="只删这一轮锚定的那段文字，不会动别处"
                        >
                          删除这段
                        </button>
                      )
                    ) : null}
                    {/* 整篇清空轮不带模型锚点，重试没有意义；重新说一句就是了 */}
                    {t.目标 !== null ? (
                      <button type="button" className={主钮} onClick={() => void 重发(t)}>
                        重试
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {/* 整篇清空：不经过模型，仍然只提议——用户按下「确认清空」前正文一个字都不动 */}
                {t.整篇 && !t.已删 && !t.错 ? (
                  <div className="ai-doc-danger">
                    <p>
                      整篇清空：将删除这篇正文的全部内容（{t.目标字数} 字），front-matter
                      保留；未确认前正文不动。
                    </p>
                    <div className="ai-turn-actions">
                      {待确认删 === t.id ? (
                        <>
                          <button
                            type="button"
                            className={危钮}
                            onClick={() => 清整整篇(t)}
                            title="清空整篇正文（Ctrl+Z 可撤销）"
                          >
                            确认清空
                          </button>
                          <button
                            type="button"
                            className={钮}
                            onClick={() => set待确认删(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={危钮}
                          onClick={() => set待确认删(t.id)}
                          title="只清空这篇正文，front-matter 保留"
                        >
                          清空整篇正文
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
                {t.已删 ? (
                  <p className="ai-turn-meta">
                    {t.整篇 ? "已清空整篇正文" : "已删除这段文字"}，Ctrl+Z 可撤销
                  </p>
                ) : null}
                {/* 整篇编辑方案：模型只提议；未点「应用修改」前正文一个字都不动 */}
                {t.整篇编辑 && !t.已落 && !t.已取消 && !t.错 && t.计划 ? (
                  <div className="ai-doc-plan">
                    <p className="ai-doc-plan-title">
                      {t.计划.edits.length
                        ? `整篇编辑方案（${t.计划.edits.length} 处修改）`
                        : "整篇：没有要改的地方"}
                    </p>
                    {t.计划.note || !t.计划.edits.length ? (
                      <p className="ai-doc-plan-note">
                        {t.计划.note ?? "AI 没有给出说明"}
                      </p>
                    ) : null}
                    {t.计划.edits.length ? (
                      <ul className="ai-doc-plan-list">
                        {计划预览(t.计划, t.快照)
                          .slice(0, 20)
                          .map((条, i) => (
                            <li key={i}>
                              <span className="ai-doc-plan-item">{条.标签}</span>
                              {条.旧 ? <del>{条.旧}</del> : null}
                              {条.新 ? <ins>{条.新}</ins> : null}
                            </li>
                          ))}
                      </ul>
                    ) : null}
                    {t.计划.edits.length > 20 ? (
                      <p className="ai-doc-plan-note">
                        还有 {t.计划.edits.length - 20} 处未展开
                      </p>
                    ) : null}
                    <div className="ai-turn-actions">
                      {t.计划.edits.length ? (
                        <button type="button" className={主钮} onClick={() => 应用整篇(t)}>
                          应用修改
                        </button>
                      ) : null}
                      <button type="button" className={钮} onClick={() => 取消整篇(t)}>
                        {t.计划.edits.length ? "取消" : "知道了"}
                      </button>
                      {t.量 ? (
                        <span className="ai-turn-meta ai-turn-usage">{t.量}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {t.整篇编辑 && t.已落 ? (
                  <p className="ai-turn-meta">
                    已应用 {t.应用数} 处修改，Ctrl+Z 可撤销
                  </p>
                ) : null}
                {t.整篇编辑 && t.已取消 ? (
                  <p className="ai-turn-meta">已取消，正文未改</p>
                ) : null}
              </div>
            ))}
          </div>

          {总错 ? <p className="ai-turn-err">{总错}</p> : null}

          <div className="ai-dock-foot">
            {/* 选中的原文就摆在输入框上沿：用户圈了哪儿、这次改哪一段，一眼能对上。
                没选字时这块不出现——那一次要求是对整篇说的 */}
            {选区 ? (
              <div
                className={选区.能用 ? "ai-dock-sel" : "ai-dock-sel is-warn"}
                title={选区预览}
              >
                <span className="ai-dock-sel-label">
                  选中 {选区.字数} 字{选区.why ? `｜${选区.why}` : ""}
                </span>
                <span className="ai-dock-sel-text">{选区预览 || "（空白）"}</span>
              </div>
            ) : null}
            <div className="ai-dock-row">
              <textarea
                ref={输入}
                className="ai-dock-input"
                rows={3}
                aria-label="说一句要改什么"
                value={草稿}
                maxLength={500}
                placeholder={
                  !aiReady
                    ? "先在设置里配好模型（整篇清空可直接说）"
                    : 选区
                      ? "说一句要改选中这段的什么"
                      : "说一句要对整篇做什么"
                }
                onChange={(e) => set草稿(e.target.value)}
                onKeyDown={(e) => {
                  if (是回车提交(e) && !e.shiftKey && !忙 && 草稿.trim()) {
                    e.preventDefault();
                    void 发();
                  }
                }}
              />
              <button
                type="button"
                className={主钮 + " ai-dock-send"}
                aria-label="发送"
                disabled={忙 || !草稿.trim()}
                onClick={() => void 发()}
              >
                {忙 ? "生成中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          ref={把手}
          className="ai-dock-bar"
          title="AI 编辑（会带上整篇正文作背景；标了私密的篇只发目标段）"
          aria-haspopup="dialog"
          aria-label="展开 AI 编辑"
          onClick={() => {
            想焦点.current = true;
            set开(true);
          }}
        >
          <工具图标.ai />
          <工具图标.chevronUp />
          {/* 未读红点（方案 G·气泡态）：收起期间有结果没替换、或有错误没处理时亮着。
              替换掉 / 重试成功后自然熄灭；aria-hidden——状态由面板自己说，不进读屏 */}
          {轮们.some(
            (t) =>
              t.错 ||
              (t.答 !== "" && !t.已落) ||
              (t.整篇 && !t.已删 && !t.错) ||
              (t.整篇编辑 && t.计划 && !t.已落 && !t.已取消 && !t.错),
          ) ? (
            <span className="ai-dock-dot" aria-hidden="true" />
          ) : null}
        </button>
      )}
    </div>
  );
});
