import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { activeHeadingOf, outlineKey, outlineOf, type OutlineItem } from "./outline";

/**
 * 大纲栏（布局三）：列出前三级标题，当前节高亮，点一条跳过去。**只在有标题时渲染**——
 * 一篇没有标题的短笔记挂一条空栏，是"为了布局而布局"，直接不出现。
 *
 * 两种形态（2026-10-30 起，方案 G）：
 * - `edge`（默认不传则是旧的侧栏形态，测试与既有样式都走它）：贴着正文**左缘**的悬停
 *   浮层，由 `OutlineEdge` 包着外壳与把手；本组件只管列表与跳转，宽度和边框交给
 *   外壳的 CSS 改写（`.outline-as-flyout`）。
 *
 * 与 `Toolbar` 同一条纪律：**自己订阅编辑器事件、自己 bump**。要是把选区变化往上传，
 * 每次击键都会连带重渲染整棵 main 子树——打字路径上凭空多一次整页协调，这条预算
 * 花不起（[06] G6）。
 *
 * 活动节跟着**光标**走而不是跟着滚动走：滚动是浏览，光标是"我在哪儿"，
 * 两者不一致时以光标为准，和命令面板 / 目录树的当前项是同一套语义。
 * 顺带的好处是不用在滚动路径上做 IntersectionObserver——那又是一份每帧的几何账。
 */
export function OutlinePanel({
  editor,
  variant,
}: {
  editor: Editor;
  /** 不传 = 旧的右缘侧栏形态（宽 200px 的常驻列）；`"edge"` = 左缘浮层里的列表 */
  variant?: "edge";
}) {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [active, setActive] = useState(-1);
  /** 订阅闭包里读的"最新条目"：setState 是异步的，直接读 state 会停在上一帧 */
  const itemsRef = useRef<OutlineItem[]>([]);
  const 条目键 = useRef("");

  useEffect(() => {
    // 只在**条目签名**变了时才换列表：文档每改一次 pos 都会平移，
    // 但"哪几级标题、叫什么"没变的那几次，不值得一次重渲染
    const 同步条目 = () => {
      const 列 = outlineOf(editor.state.doc);
      const 键 = outlineKey(列);
      if (键 !== 条目键.current) {
        条目键.current = 键;
        itemsRef.current = 列;
        setItems(列);
      }
      同步活动();
    };
    const 同步活动 = () => {
      const 序 = activeHeadingOf(itemsRef.current, editor.state.selection.from);
      setActive((旧) => (旧 === 序 ? 旧 : 序));
    };
    同步条目();
    editor.on("update", 同步条目);
    editor.on("selectionUpdate", 同步活动);
    return () => {
      editor.off("update", 同步条目);
      editor.off("selectionUpdate", 同步活动);
    };
  }, [editor]);

  // 换一篇 / 编辑器重建时清掉旧签名：不然新文档开头恰好同签名时列表不刷新
  useEffect(
    () => () => {
      条目键.current = "";
      itemsRef.current = [];
    },
    [],
  );

  if (items.length === 0) return null;

  /** 点一条 = 光标落到那个标题块里 + 把它滚到滚动口上沿。不发文档事务：改选区不标脏 */
  const 跳 = (item: OutlineItem) => {
    const { state, view } = editor;
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(item.pos), 1)));
    // `tr.scrollIntoView()` 只滚"最少够看到"，标题会贴在视口底沿——
    // 大纲跳转的预期是"到这一节的开头"，按 DOM 几何顶到上沿（即时，不做平滑：
    // 动效规则只认 transform/opacity，且 reduced-motion 下本就该归零）
    const dom = view.nodeDOM(item.pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView?.({ block: "start" });
    view.focus();
  };

  return (
    // w-50 = 200px（--spacing: 4px × 50，4px 栅格上）：栏宽是布局契约，必须钉死——
    // 不给宽度的话它会被最长的那条标题撑开，正文列宽就跟着标题长度抖。
    // edge 形态不带这份契约：宽度与边框由浮层外壳给，这里只铺满
    <nav
      className={
        variant === "edge" ? "outline-panel outline-as-flyout" : "outline-panel w-50 shrink-0"
      }
      aria-label="大纲"
    >
      <div className="outline-title">大纲</div>
      {items.map((item, i) => (
        <button
          key={`${item.pos}:${i}`}
          type="button"
          className={i === active ? "outline-item on" : "outline-item"}
          style={{
            paddingInlineStart: `calc(var(--space-2) + var(--space-4) * ${item.level - 1})`,
          }}
          title={item.text}
          aria-current={i === active ? "true" : undefined}
          onClick={() => 跳(item)}
        >
          <span className="outline-text">{item.text || "（空标题）"}</span>
        </button>
      ))}
    </nav>
  );
}
