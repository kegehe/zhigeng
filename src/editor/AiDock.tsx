import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { memo, useEffect, useRef, useState } from "react";

import { api, describeError, inTauri } from "../ipc/commands";
import { 是回车提交 } from "../ui/keys";
import { 工具图标 } from "./icons";
import { 新运行号 } from "./runId";
import { 准备目标, 替换选区, 随事务, type 锚 } from "./rewrite";

/**
 * 文档底部的 AI 对话框。**它是唯一的 AI 入口**（2026-10-28 撤掉了工具栏与气泡上那两枚 ✨）。
 *
 * 三条不变量：
 *
 * 1. **它不写文档**。回稿只在自己身上累积，用户点「替换」才发一笔事务；AI 不静默改写
 *    （docs/04 §0）。替换后把新文字重新选中，下一句就接着改同一段——这才是"对话式改字"。
 * 2. **目标有先后**：有选区就改选区，没有就改**光标所在的那一段**（见 rewrite.ts 的取目标）。
 *    判据只有一份，界面不自己判一遍。
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
  范围: "选区" | "本段";
  /** 发起那一刻目标有多长。落笔之后 `目标` 会被换成新文（它还要跟着后续事务平移），
   *  历史条目上那个"N 字"不许跟着变——它记的是"当时让模型改了多长一段" */
  目标字数: number;
  问: string;
  目标: 锚;
  答: string;
  想: number;
  busy: boolean;
  错: string | null;
  量: string | null;
  /** 已经落进正文：再点一次「替换」就是重复插入，按钮要换掉 */
  已落: boolean;
};

const 字数 = (s: string) => [...s].length;

/** 与工具栏同一套按钮基线；这里只差字号，不另发明一套 */
const 钮 =
  "rounded-md border border-line px-2 py-0.5 text-xs text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover active:translate-y-px disabled:opacity-55";
const 主钮 =
  "rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:opacity-55";

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
          if (t.已落) return t;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
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

  const 发 = async () => {
    const 令 = 草稿.trim();
    if (!令 || 忙) return;
    const r = 准备目标(aiReady, editor.state);
    if (!r.ok) {
      set总错(r.why);
      set开(true);
      return;
    }
    set总错(null);
    // **发送不动编辑态**：问一句不该把只读的笔记翻进编辑。切态放到落笔那一下（见 `落`）
    const id = ++序.current;
    const 本号 = (号.current = 新运行号());
    当前.current = id;
    // 现取一遍：整篇正文作背景，长度留给界面说"带没带上"
    const 背景 = 全文();
    set轮们((旧) =>
      [
        ...旧,
        {
          id,
          范围: r.范围,
          目标字数: 字数(r.锚.text),
          问: 令,
          目标: r.锚,
          答: "",
          想: 0,
          busy: true,
          错: null,
          量: null,
          已落: false,
        },
      ].slice(-30),
    );
    set草稿("");
    // 点「发送」时焦点在按钮上，按钮随即变灰会把它甩给 body；回车路径本来就在框里。
    // 统一把焦点放回输入框：回完字就能接着写下一句，不用重新点一下。
    输入.current?.focus();
    try {
      // 审计里的预设标签固定记 custom：对话框只有一句话，没有预设档
      const 果 = await api.aiRewrite(r.锚.text, 令, "custom", 本号, 背景, rel);
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
      set轮们((旧) =>
        旧.map((t) =>
          t.id === id
            ? // 流到一半的那截不能留：它可能正是被判多行而拒收的那份
              { ...t, 答: "", busy: false, 错: describeError(e).message }
            : t,
        ),
      );
      号.current = 0;
    }
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
    const tr = 替换选区(editor.state, t.目标, t.答, true);
    if (!tr) {
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
    editor.view.dispatch(tr.scrollIntoView());
    // 焦点给回正文：改完通常接着写；顺带让"鼠标移开就收"重新生效（焦点留在按钮里就收不了）
    editor.view.focus();
    // 新文整段选中：下一句接着改同一段（对话式改字的连续性就靠这一下）
    const 新锚: 锚 = { from: t.目标.from, to: t.目标.from + t.答.length, text: t.答 };
    set轮们((旧) =>
      旧.map((x) => (x.id === t.id ? { ...x, 目标: 新锚, 已落: true, 错: null } : x)),
    );
    onApplied();
    // 不再走全局 flash：它渲染在正文顶部，深文档里滚到中间时正好在屏幕外，
  };

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
          {/* 右上角只有两枚图标：钉住 + 收起。收起放这里，面板展开时下面就不再挂一颗把手 */}
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
                      {t.答}
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
                        <button
                          type="button"
                          className={主钮}
                          disabled={t.已落}
                          onClick={() => 落(t)}
                          title={
                            t.已落
                              ? "这一轮已经替换过了"
                              : t.范围 === "选区"
                                ? "把这段换进正文（Ctrl+Z 可撤销）"
                                : "整段按纯文本写回：段内的加粗 / 链接 / 颜色不会保留（Ctrl+Z 可撤销）"
                          }
                        >
                          {t.已落 ? "已替换" : t.范围 === "选区" ? "替换选中" : "替换本段"}
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
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {t.错 ? <p className="ai-turn-err">{t.错}</p> : null}
              </div>
            ))}
          </div>

          {总错 ? <p className="ai-turn-err">{总错}</p> : null}

          <div className="ai-dock-foot">
            <div className="ai-dock-row">
              <textarea
                ref={输入}
                className="ai-dock-input"
                rows={3}
                aria-label="说一句要改什么"
                value={草稿}
                maxLength={500}
                placeholder={aiReady ? "说一句要改什么" : "先在设置里配好模型"}
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
        </button>
      )}
    </div>
  );
});
