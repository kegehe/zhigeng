import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CapturedOut } from "./ipc/types";

type Phase = "idle" | "saving" | "saved" | "error";

/**
 * 速记窗。整条交互就一个目标：**从想到到记下来不超过 3 秒，且任何时候都不卡**。
 * 因此这里刻意不做的事：不等索引完成才关窗（落盘返回即算成功）、不显示进度条、
 * 不做花哨入场动画（G7 只要求 100ms 内有反馈，这个窗口本身就是反馈）。
 */
export function Capture() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [saved, setSaved] = useState<CapturedOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ta.current?.focus();
  }, []);

  const close = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  const submit = useCallback(async () => {
    // Enter 没有守卫的话，手快连按两下就会落两篇——按钮是禁用了，键盘路径也得禁。
    // 相应地 `phase` 必须在 useCallback 的依赖里，不然这里读到的是闭包里的旧值，守卫等于没加。
    if (phase === "saving" || phase === "saved") return;
    const body = text.trim();
    if (!body) {
      // 空内容不落盘，也不关窗——用户按回车多半是手滑
      setPhase("error");
      setErr("还没写内容");
      return;
    }
    setPhase("saving");
    try {
      const { api } = await import("./ipc/commands");
      const res = await api.captureText(body);
      setSaved(res);
      setPhase("saved");
      setText("");
      // 450ms 足够看清"已存"，又不会让人觉得要被等
      window.setTimeout(() => void getCurrentWindow().close(), 450);
    } catch (e) {
      setPhase("error");
      setErr(String(e));
    }
  }, [text, phase]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (!alive) return;
      const un = await listen<boolean>("note://indexed", (ev) => {
        if (!ev.payload) setErr("已落盘，但索引没跟上——下次打开会自愈");
      });
      return un;
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-raised">
      <div
        className="flex h-8 shrink-0 items-center justify-between px-3 text-xs text-fg-2"
        data-tauri-drag-region
      >
        <span data-tauri-drag-region>速记 · 存到 inbox/</span>
        <button className="rounded-sm px-1 hover:bg-hover" onClick={close} title="隐藏（Esc）">
          ✕
        </button>
      </div>

      <textarea
        ref={ta}
        value={text}
        placeholder="想到什么就写什么，Enter 存，Shift+Enter 换行"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (phase === "error") setPhase("idle");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="min-h-0 flex-1 resize-none bg-raised px-4 pb-2 font-ui text-base leading-body text-fg placeholder:text-fg-disabled"
      />

      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-xs">
        <span className={phase === "error" ? "text-danger" : "text-fg-disabled"}>
          {phase === "error" ? (err ?? "出错") : phase === "saved" ? `已存 ${saved?.rel ?? ""}` : "Alt+Shift+N 随时唤起"}
        </span>
        <button
          className="rounded-sm border border-line px-2 py-0.5 hover:bg-hover disabled:text-fg-disabled"
          disabled={phase === "saving" || !text.trim()}
          onClick={() => void submit()}
        >
          {phase === "saving" ? "存入中…" : "存入 (Enter)"}
        </button>
      </div>
    </div>
  );
}
