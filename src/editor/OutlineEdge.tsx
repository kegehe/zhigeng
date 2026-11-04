import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";

import { outlineKey, outlineOf } from "./outline";
import { 工具图标 } from "./icons";
import { OutlinePanel } from "./OutlinePanel";

/**
 * 大纲的**正文列左缘把手 + 悬停滑出浮层**（方案 G，2026-10-30；11-02 改挂正文列）。
 *
 * 交互契约（设计稿 G1–G3 钉住的）：
 *
 * 1. **默认零占地**：把手落在正文列左侧那 24px 页边里、垂直居中（不是面板最左缘——
 *    宽窗时那会离正文隔着一整片空白）。没有标题的短笔记连把手都不出现——
 *    OutlinePanel「没标题不渲染」的老纪律照搬，不为布局而布局。
 * 2. **悬停滑出，移开收起**：鼠标移到把手上即滑出（120ms 展开、300ms 收起）；
 *    **正在拖动滚动条时不收**——收起判据里没有这一条之外的例外。
 *    与 AiDock 同一套时序参数与指针判据，两处浮层的手感一致。
 * 3. **点击跳转，不抢焦点**：展开不夺光标（正文还在用）；列表与跳转全部复用
 *    `OutlinePanel`（活动节跟光标走、点击顶到上沿），这里不另写一份。
 *
 * 外壳结构与 `.ai-dock` 同款：外壳 pointer-events:none 不挡正文，把手与浮层才吃事件。
 * 定时器只在这里，列表组件保持纯展示。
 */
export function OutlineEdge({ editor }: { editor: Editor }) {
  /** 有没有标题。签名变了才 setState：打字平移位置不改签名，不值得重渲染 */
  const [有标题, set有标题] = useState(false);
  const [开, set开] = useState(false);

  const 盒 = useRef<HTMLDivElement | null>(null);
  const 把手 = useRef<HTMLButtonElement | null>(null);
  const 收钟 = useRef<number | null>(null);
  const 开钟 = useRef<number | null>(null);
  /** 焦点在浮层里时指针移开不许收：键盘用户还在列表里 */
  const 焦点在 = useRef(false);
  /** 用 Esc 收起时把焦点交回把手 */
  const 想焦点把手 = useRef(false);

  useEffect(() => {
    const 同步 = () => {
      const 键 = outlineKey(outlineOf(editor.state.doc));
      set有标题((旧) => (旧 === (键 !== "") ? 旧 : 键 !== ""));
    };
    同步();
    editor.on("update", 同步);
    return () => {
      editor.off("update", 同步);
    };
  }, [editor]);

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

  /** 与 AiDock 的「移开就收」同一条判据形状：焦点还在里面就不收 */
  const 安排收 = () => {
    清开();
    清收();
    收钟.current = window.setTimeout(() => {
      收钟.current = null;
      if (焦点在.current) return;
      set开(false);
    }, 300);
  };
  const 悬入 = () => {
    清收();
    清开();
    if (开) return;
    开钟.current = window.setTimeout(() => {
      开钟.current = null;
      set开(true);
    }, 120);
  };
  const 悬出 = () => {
    安排收();
  };

  useEffect(() => {
    if (!开) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
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

  // 收起后焦点交回把手：列表按钮随浮层一起卸载，不接住就落到 body 上
  useEffect(() => {
    if (开 || !想焦点把手.current) return;
    想焦点把手.current = false;
    把手.current?.focus();
  }, [开]);

  if (!有标题) return null;

  return (
    <div
      className="outline-edge"
      ref={盒}
      onPointerEnter={悬入}
      onPointerLeave={悬出}
      onFocusCapture={() => {
        焦点在.current = true;
        清收();
      }}
      onBlurCapture={(e) => {
        焦点在.current = 盒.current?.contains(e.relatedTarget as Node | null) ?? false;
        if (!焦点在.current) 安排收();
      }}
    >
      {开 ? (
        <div className="outline-flyout" role="dialog" aria-label="大纲导航">
          <OutlinePanel editor={editor} variant="edge" />
        </div>
      ) : (
        <button
          type="button"
          ref={把手}
          className="outline-edge-handle"
          title="大纲（鼠标移到正文左侧的把手即滑出）"
          aria-haspopup="dialog"
          aria-label="展开大纲"
          aria-expanded={false}
          onClick={() => set开(true)}
        >
          <工具图标.chevronRight />
        </button>
      )}
    </div>
  );
}
