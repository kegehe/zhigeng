import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useEffect, useRef, useState } from "react";

import { api, describeError, inTauri } from "../ipc/commands";
import { 是回车提交 } from "../ui/keys";
import {
  取选段,
  能替换,
  替换选区,
  随事务,
  预设,
  type 锚,
  type 浮层放,
} from "./rewrite";
import { 新运行号 } from "./runId";

/** 与 App 里那两枚按钮同一套基线；这里只差字号，不另发明一套按钮。 */
const btn =
  "rounded-md border border-line px-2 py-1 text-xs text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover active:translate-y-px disabled:opacity-55";
const btnPrimary =
  "rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:opacity-55";

const 字数 = (s: string) => [...s].length;

/**
 * 选区改写浮层。**它不写文档**：生成、显示、再生成都只动自己的状态，
 * 用户点「替换选中」时才发一笔事务——AI 不静默改写（docs/04 §0）。
 *
 * 位置在打开那一刻固定：输入框一拿到焦点，浏览器选区就不在正文里了，
 * 跟着"选区矩形"重算会把浮层甩走（气泡那一套只适合不抢焦点的工具条）。
 */
export function RewritePanel({
  editor,
  放,
  onClose,
  onNotice,
}: {
  editor: Editor;
  /** 落点 + 这一侧能给的高度，由 `浮层位置` 一次算好（竖屏翻转也在这里面） */
  放: 浮层放;
  onClose: () => void;
  onNotice?: (文本: string) => void;
}) {
  const [指令, set指令] = useState(预设[0].指令);
  const [预设id, set预设id] = useState(预设[0].id);
  const [原文, set原文] = useState(() => {
    const r = 取选段(editor.state);
    return r.ok ? r.锚.text : "";
  });
  const [回稿, set回稿] = useState("");
  const [想字, set想字] = useState(0);
  const [busy, setBusy] = useState(false);
  const [错误, set错误] = useState<string | null>(null);
  const [用量, set用量] = useState<string | null>(null);
  const 锚 = useRef<锚 | null>(null);
  /**
   * 手上这一趟的号（0 = 还没有请求）。关掉时归零：旧请求还会继续吐字，
   * 归零之后它们的号对不上，就落不进任何一次回稿里。
   */
  const 号 = useRef(0);
  const 关Ref = useRef(onClose);
  关Ref.current = onClose;

  const 关 = () => {
    号.current = 0;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中文输入法用 Esc 取消组词（Chromium 带 isComposing，老内核只给 keyCode 229）：
      // 那一下归输入法，不能顺手把浮层关掉——已经到的回稿会跟着一起没。
      // **已被别人处理过的 Esc 也不算我的**：命令面板开着时那一键归面板（它 preventDefault
      // 关自己），事件照样冒到 window——不挡就会把浮层连同已到的回稿一起关掉。
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229) {
        号.current = 0;
        关Ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 等回稿期间用户改了别处：锚点跟着事务走，apply 时再核一次字节
  useEffect(() => {
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (锚.current) 锚.current = 随事务(锚.current, transaction);
    };
    editor.on("transaction", onTr);
    return () => {
      editor.off("transaction", onTr);
    };
  }, [editor]);

  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    let 拆: (() => void) | undefined;
    const 订 = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const a = await listen<{ runId: number; text: string }>(
        "ai://rewrite-token",
        (e) => {
          if (!alive || e.payload.runId !== 号.current) return;
          set回稿((旧) => 旧 + e.payload.text);
        },
      );
      const b = await listen<{ runId: number; text: string }>(
        "ai://rewrite-think",
        (e) => {
          if (!alive || e.payload.runId !== 号.current) return;
          set想字((旧) => 旧 + e.payload.text.length);
        },
      );
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

  const 生成 = async () => {
    const r = 取选段(editor.state);
    if (!r.ok) {
      set错误(r.why);
      return;
    }
    锚.current = r.锚;
    set原文(r.锚.text);
    // 号从模块那一层取：同一次浮层里重新生成要新号，重开浮层更不许复用上一次的号
    const 本号 = (号.current = 新运行号());
    setBusy(true);
    set错误(null);
    set回稿("");
    set想字(0);
    set用量(null);
    try {
      const 果 = await api.aiRewrite(
        r.锚.text,
        指令.trim(),
        预设id,
        本号,
      );
      if (本号 !== 号.current) return;
      set回稿(果.text);
      set用量(
        `${果.model}｜in ${果.inTokens} / out ${果.outTokens}｜${果.ms}ms`,
      );
    } catch (e) {
      if (本号 !== 号.current) return;
      // 流到一半的那截原文不能留着：它可能正是被后端判成多行而拒收的那份，
      // 摆在「替换选中」旁边等于给一个用不了的候选
      set回稿("");
      set错误(describeError(e).message);
    } finally {
      if (本号 === 号.current) setBusy(false);
    }
  };

  const 应用 = () => {
    const a = 锚.current;
    if (!a) {
      set错误("找不到原来选中的文字了，请重新选中再生成");
      return;
    }
    const tr = 替换选区(editor.state, a, 回稿);
    if (!tr) {
      set错误(
        "选中的文字刚被改过，这次没有替换。请重新选中再生成。",
      );
      return;
    }
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
    onNotice?.("已替换，按 Ctrl+Z 可以撤销");
    关();
  };

  return (
    <div
      className="rewrite"
      style={{ top: 放.top, bottom: 放.bottom, left: 放.left, maxHeight: 放.maxHeight }}
      role="dialog"
      aria-label="AI 改写选中文字"
      data-md-ai
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-2">
          AI 改写｜选中 {字数(原文)} 字
        </span>
        <button type="button" className={btn} onClick={关} title="关闭（Esc）">
          关闭
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {预设.map((p) => (
          <button
            key={p.id}
            type="button"
            className={预设id === p.id ? btn + " bg-active text-fg" : btn}
            disabled={busy}
            onClick={() => {
              set预设id(p.id);
              set指令(p.指令);
            }}
          >
            {p.标签}
          </button>
        ))}
      </div>
      <input
        autoFocus
        className="w-full rounded-md border border-line bg-page px-2 py-1 text-sm text-fg"
        value={指令}
        disabled={busy}
        maxLength={500}
        placeholder="比如：润色，保持原意"
        onChange={(e) => {
          set指令(e.target.value);
          set预设id("custom");
        }}
        onKeyDown={(e) => {
          if (是回车提交(e) && !busy && 指令.trim()) {
            e.preventDefault();
            void 生成();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !指令.trim()}
          onClick={() => void 生成()}
        >
          {busy ? "生成中…" : 回稿 ? "重新生成" : "改写"}
        </button>
        {busy ? (
          <span className="text-xs text-fg-2">
            {想字 ? `正在思考…（${想字} 字）` : "正在等待回应…"}
            {回稿 ? `｜已到 ${字数(回稿)} 字` : ""}
          </span>
        ) : 用量 ? (
          <span className="font-mono text-xs text-fg-2">{用量}</span>
        ) : null}
      </div>
      {错误 ? <p className="text-xs text-danger">{错误}</p> : null}
      {原文 ? (
        <div className="rounded-md border border-line bg-sunken px-2 py-1">
          <div className="text-xs text-fg-2">原文</div>
          <p className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap text-xs text-fg-2">
            {原文}
          </p>
        </div>
      ) : null}
      {回稿 || busy ? (
        <div className="rounded-md border border-line bg-raised px-2 py-1">
          <div className="text-xs text-fg-2">改写结果</div>
          <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-sm text-fg">
            {回稿}
            {busy ? (
              <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-fg-2 align-middle" />
            ) : null}
          </p>
        </div>
      ) : null}
      <p className="text-xs text-fg-2">
        只发送你选中的这段文字；替换后可以按 Ctrl+Z 撤销。
      </p>
      {/* 动作行贴在浮层底部：回稿把面板撑到 `maxHeight` 之后，用户不必滚到底也能点「替换选中」 */}
      <div className="rewrite-actions flex justify-end gap-2">
        <button type="button" className={btn} onClick={关}>
          丢弃
        </button>
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !回稿}
          onClick={应用}
        >
          替换选中
        </button>
      </div>
    </div>
  );
}
