import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import type { CapturedOut } from "./ipc/types";
import { 是回车提交 } from "./ui/keys";
import { 套主题, 盯主题变化, 读主题 } from "./ui/theme";

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

  /**
   * 速记窗以前**从来没被问过主题**：主窗是暗的，它永远套浅色 token（用户原话
   * "为什么没有跟随系统颜色"）。这里跟着同一份偏好走；主窗改了会通过 `storage` 事件过来。
   */
  useEffect(() => 盯主题变化(() => 套主题(读主题())), []);

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
        if (!ev.payload) setErr("已保存，但搜索还没更新；下次打开会自动补上。");
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
        <button
          className="grid place-items-center rounded-sm px-1 hover:bg-hover"
          onClick={close}
          title="隐藏（Esc）"
        >
          <X aria-hidden="true" />
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
          if (是回车提交(e) && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="min-h-0 flex-1 resize-none bg-raised px-4 pt-2 pb-2 font-ui text-base text-fg placeholder:text-fg-disabled"
      />

      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-xs">
        <span className={phase === "error" ? "text-danger" : "text-fg-disabled"}>
          {phase === "error" ? (err ?? "保存失败") : phase === "saved" ? `已保存 ${saved?.rel ?? ""}` : "Alt+Shift+N 随时唤起"}
        </span>
        <button
          className="rounded-sm border border-line px-2 py-1 hover:bg-hover disabled:opacity-55"
          disabled={phase === "saving" || !text.trim()}
          onClick={() => void submit()}
        >
          {phase === "saving" ? "保存中…" : "保存 (Enter)"}
        </button>
      </div>
    </div>
  );
}
