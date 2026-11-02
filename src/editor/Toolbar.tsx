import { undo, redo, undoDepth, redoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { 是回车提交 } from "../ui/keys";
import {
  addColumn,
  addRow,
  applyBlockType,
  cellAt,
  INSERTABLE,
  insertSourceBlock,
  moveCurrentBlock,
  removeColumn,
  removeRow,
  setAlign,
  BLOCK_TYPES,
  tableAt,
  对所齐所选,
  填充所选,
  删所选列,
  删所选行,
  清场所选,
  type BlockTypeId,
} from "./blocks";
import { 批量, 矩形of } from "./tableSelectPlugin";
import { 关格式刷, 开格式刷, 能开格式刷, 格式刷状态of } from "./formatPainter";
import type { Align } from "./table";
import { 工具图标, type 图标名 } from "./icons";
import { 调色板, 底色of } from "./colors";

/**
 * 常驻顶部工具栏。
 *
 * **只放序列化器真能产出的操作**——这条限制不是偷懒，是产品的命根子：Markdown 是唯一
 * 真相（G1），编辑器与文件必须字节级往返（G5）。所以这里没有字号、居中、缩进：Markdown
 * 里没有语法，给了按钮就是给用户一个"点了会丢"的陷阱。
 *
 * 颜色与高亮是 2026-10-28 才放进来的一档，**不是因为"Markdown 有了语法"，是因为我们先
 * 定了一种能原样往返的写法**：高亮 `==文字==`，颜色 `<span style="color:#e5534b">文字</span>`
 * （见 docs/02 D35）。先有字节、再有按钮，顺序不能反。
 *
 * 单独一个组件、自己订阅编辑器事件：放在 `BlockEditor` 里 `setState` 的话，每次选区变化
 * 都会连带重渲染 `EditorContent`，等于在打字路径上凭空加一次整棵子树的协调。
 */
export function Toolbar({ editor }: { editor: Editor }) {
  const [, bump] = useState(0);
  const [linking, setLinking] = useState(false);
  /** 哪一档颜色的面板开着（两枚按钮各一个，同时只开一个） */
  const [面板, set面板] = useState<"textColor" | "bgColor" | null>(null);

  useEffect(() => {
    const on = () => bump((n) => n + 1);
    editor.on("selectionUpdate", on);
    editor.on("update", on);
    /**
     * 矩形选区走的是**只带 meta 的事务**（不动文档，所以不触发 `selectionUpdate`），
     * 只能挂 `transaction`。但这条每击一次键都会来——不比对就 `setState`，等于把 G6 的
     * 预算花在打字路径上多渲染一次工具栏，所以只在矩形真的变了时才重渲染。
     */
    let 键 = "";
    const 同步矩形 = () => {
      const 矩 = 矩形of(editor.state);
      const 新 = 矩 ? `${矩.r0},${矩.c0},${矩.r1},${矩.c1}` : "";
      if (新 === 键) return;
      键 = 新;
      bump((n) => n + 1);
    };
    /**
     * 格式刷的开 / 关同样是**只带 meta 的事务**。按引用比对插件 state：开关一次是
     * 新对象，其余事务拿回同一个旧对象，所以这条只在真的切换时才重渲染。
     */
    let 键刷 = 格式刷状态of(editor.state);
    const 同步格式刷 = () => {
      const 新 = 格式刷状态of(editor.state);
      if (新 === 键刷) return;
      键刷 = 新;
      bump((n) => n + 1);
    };
    editor.on("transaction", 同步矩形);
    editor.on("transaction", 同步格式刷);
    return () => {
      editor.off("selectionUpdate", on);
      editor.off("update", on);
      editor.off("transaction", 同步矩形);
      editor.off("transaction", 同步格式刷);
    };
  }, [editor]);

  const { $from } = editor.state.selection;
  const node = $from.depth > 0 ? $from.parent : null;
  /**
   * 整块被选中时（点到卡片头 / 行号栏、或图片那种原子块）`$from.depth` 是 0，
   * **那一块自己就是选区**。不接这一支，工具栏会在"明明选中了一块"的时候说
   * "没有可改的块"——那句话本来该留给"光标在两个块之间什么都没落"的情况。
   *
   * 只喂给下拉，不改 `node`：`node` 还管着"清除格式"的禁用态，整块选中时那一枚
   * 仍然该是灰的（对着一整块 unsetMark 没有一致的含义）。
   */
  const 整块 = editor.state.selection instanceof NodeSelection ? editor.state.selection.node : null;
  const typeName = 整块 ? 整块.type.name : node ? node.type.name : "";
  const opaque = typeName === "mdOpaque";
  const 当前类型: BlockTypeId =
    typeName === "mdHeading"
      ? (`heading${Math.min(6, Math.max(1, Number(node?.attrs.mdLevel ?? 1)))}` as BlockTypeId)
      : typeName === "mdItem"
        ? (String(node?.attrs.mdKind) as BlockTypeId)
        : "paragraph";
  const 可选块 = typeName === "mdParagraph" || typeName === "mdHeading" || typeName === "mdItem";
  // 光标在某张表里：这时工具栏该给的是"行列与对齐"这一组，不是块类型下拉
  const 表起点 = tableAt(editor.state);
  const 格 = cellAt(editor.state);
  /** 框了多格就换批量那一档：单格的"加一行/删这列"与批量的"删所选行"不是一回事 */
  const 矩 = 矩形of(editor.state);
  const 列数 = 表起点 === null ? 0 : (editor.state.doc.nodeAt(表起点)?.child(0)?.childCount ?? 0);
  const 当前对齐: string = 格
    ? String(
        editor.state.doc.nodeAt(表起点 ?? -1)?.child(格.行)?.child(格.列)?.attrs.align ?? "",
      )
    : "";

  const 改表 = (做: (state: typeof editor.state, 起点: number) => ReturnType<typeof addRow>) => {
    if (表起点 === null) return;
    const tr = 做(editor.state, 表起点);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };
  const 改对齐 = (对: Align) => {
    if (表起点 === null) return;
    const tr = setAlign(editor.state, 表起点, 对);
    // 已经是这一档时 setAlign 给 null：同一列连点两次"居中"不该把这篇标成待保存
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };
  /** 批量动作。判据（有没有框多格）在 `批量` 里，这里不重复判一次 */
  const 走批量 = (做: Parameters<typeof 批量>[1]) => {
    const tr = 批量(editor.state, 做);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };

  const setType = (id: BlockTypeId) => {
    if (!$from.depth) return;
    const tr = applyBlockType(editor.state, $from.before(1), id);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };
  const move = (delta: number) => {
    const tr = moveCurrentBlock(editor.state, delta);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };

  /**
   * 一个按钮 = 一枚图标 + 一句 `title`。
   *
   * **不再往按钮里写字**：`+行` / `链` / `清` 那种"文字当图标"在一排里既读不出层级也认不出
   * 动作，图标才是要扫的东西，文字交给 `title` 与 `aria-label`（鼠标悬停与读屏都从这一句来）。
   */
  const btn = (
    key: string,
    标签: string,
    图: 图标名,
    做: () => void,
    开着 = false,
    禁用 = false,
    双击?: () => void,
  ) => {
    const Icon = 工具图标[图];
    return (
      <button
        key={key}
        type="button"
        title={标签}
        aria-label={标签}
        aria-pressed={开着 || undefined}
        className={开着 ? "on" : ""}
        disabled={禁用}
        onClick={做}
        onDoubleClick={双击}
      >
        <Icon />
      </button>
    );
  };

  return (
    <div
      className="toolbar"
      // 点工具栏不该把正文的选区弄丢：焦点一走选区就空，按钮立刻变成"不知道在改谁"
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="格式与块操作"
    >
      {表起点 !== null ? (
        <select aria-label="块类型" value="table" disabled>
          <option value="table">表格（格子里直接打字）</option>
        </select>
      ) : 可选块 || opaque ? (
        <select
          aria-label="块类型"
          value={opaque ? "opaque" : 当前类型}
          disabled={opaque}
          onChange={(e) => setType(e.target.value as BlockTypeId)}
        >
          {opaque ? <option value="opaque">不透明块（引用 / 表格 / 代码）</option> : null}
          {BLOCK_TYPES.map((b) => (
            <option key={b.id} value={b.id}>
              {b.标签}
            </option>
          ))}
        </select>
      ) : typeName === "mdImage" ? (
        // 图片块没有"类型"可转：那一行引用整体就是它的字节，能改的只有图注
        <select aria-label="块类型" value="image" disabled>
          <option value="image">图片块（能改的只有图注）</option>
        </select>
      ) : (
        <select aria-label="块类型" value="none" disabled>
          <option value="none">没有可改的块</option>
        </select>
      )}
      <span className="sep" aria-hidden="true" />
      {btn("bold", "加粗 Ctrl+B", "bold", () => editor.chain().focus().toggleMark("bold").run(), editor.isActive("bold"))}
      {btn("italic", "斜体 Ctrl+I", "italic", () => editor.chain().focus().toggleMark("italic").run(), editor.isActive("italic"))}
      {btn("strike", "删除线", "strike", () => editor.chain().focus().toggleMark("strike").run(), editor.isActive("strike"))}
      {btn("code", "行内代码", "code", () => editor.chain().focus().toggleMark("code").run(), editor.isActive("code"))}
      {btn("link", "链接", "link", () => setLinking((v) => !v), editor.isActive("link"))}
      {linking ? <LinkEditor editor={editor} onDone={() => setLinking(false)} /> : null}
      {/*
        **文字颜色与底色是两枚按钮**（Word / Google Docs 那一路），不是一枚"调色板"里两行：
        换字色与换底是两件不同的事，合成一枚时用户每次都要先认出"我现在是在选哪一行"。
        按钮下沿那道色条画的是**光标处当前的颜色**——不打开面板也知道现在套着什么。
        高亮（`==…==`）收进底色面板的第一格：它本来就是"我们默认的那一档底色"，
        单独占一枚按钮等于把同一件事摆两个入口。
      */}
      {(["textColor", "bgColor"] as const).map((mark) => {
        const 当前 = String(editor.getAttributes(mark).color ?? "");
        const 高亮 = mark === "bgColor" && editor.isActive("highlight");
        const 开着 = 面板 === mark;
        return (
          <span className="color-cell" key={mark}>
            <button
              type="button"
              className={开着 || 当前 || 高亮 ? "color-btn on" : "color-btn"}
              title={mark === "textColor" ? "文字颜色" : "底色（高亮也在这档）"}
              aria-label={mark === "textColor" ? "文字颜色" : "底色"}
              aria-expanded={开着}
              onClick={() => set面板(开着 ? null : mark)}
            >
              {mark === "textColor" ? <工具图标.baseline /> : <工具图标.highlighter />}
              <span
                className="ink-bar"
                aria-hidden="true"
                style={{ background: 高亮 ? "var(--md-mark)" : 当前 || "var(--border-strong)" }}
              />
            </button>
            {开着 ? (
              <颜色面板 editor={editor} mark={mark} onDone={() => set面板(null)} />
            ) : null}
          </span>
        );
      })}
      {btn(
        "clear",
        "清除格式（回到正文，去掉加粗 / 斜体 / 删除线 / 行内码 / 高亮 / 颜色；链接保留）",
        "clear",
        () => {
          // 只去行内样式，**留着链接**：`unsetAllMarks` 会把 link 一起抹掉，而"清除格式"
          // 在 Notion / 语雀 里都不该顺手删掉用户挂上去的链接。
          // 颜色与高亮也算"行内样式"——它们写在文件里就是几个 span / 等号，不是用户的内容。
          editor
            .chain()
            .focus()
            .unsetMark("bold")
            .unsetMark("italic")
            .unsetMark("strike")
            .unsetMark("code")
            .unsetMark("highlight")
            .unsetMark("textColor")
            .unsetMark("bgColor")
            .run();
          setType("paragraph");
        },
        false,
        !node,
      )}
      {(() => {
        const 刷态 = 格式刷状态of(editor.state);
        const 可开 = editor.isEditable && 能开格式刷(editor.state);
        return btn(
          "paint",
          刷态
            ? "格式刷已开：拖选目标文字；Esc 取消"
            : "格式刷：先选中一段带格式的文字，再拖选目标（双击可连续刷，Esc 取消）",
          "paintbrush",
          () => (刷态 ? 关格式刷(editor) : 开格式刷(editor)),
          刷态 !== null,
          !刷态 && !可开,
          () => 开格式刷(editor, true),
        );
      })()}
      <span className="sep" aria-hidden="true" />
      {/* 结构块从 INSERTABLE 生成：加一种块只改那张表，工具栏与 `/` 菜单同时长出来 */}
      {INSERTABLE.map((b) =>
        btn(
          "ins-" + b.kind,
          `在下面插入${b.标签}`,
          // kind 与图标名同名（divider / quote / table）。对不上就是 undefined，React 当场炸，
          // 不静默画个加号——漏一个图标在界面上是"这个按钮没脸"，比编译失败更难查
          b.kind as 图标名,
          () => {
            const tr = insertSourceBlock(editor.state, b.kind, b.源文本);
            if (tr) editor.view.dispatch(tr);
          },
          false,
          !$from.depth,
        ),
      )}
      {表起点 !== null && 矩 ? (
        <>
          <span className="hint" aria-hidden="true">
            {`已选 ${((矩.r1 - 矩.r0 + 1) * (矩.c1 - 矩.c0 + 1)).toString()} 格`}
          </span>
          {btn("cells-clear", "清空所选的每一格（Delete）", "cellsClear", () =>
            走批量(清场所选)
          )}
          {btn("cells-fill", "把左上角的内容填到其余格（Ctrl+D）", "cellsFill", () =>
            走批量(填充所选)
          )}
          {btn(
            "cells-row-",
            "删掉所选的每一行（表头行不能删）",
            "rowRemove",
            () => 走批量(删所选行),
            false,
            矩.r1 === 0,
          )}
          {btn(
            "cells-col-",
            矩.c0 === 0 && 矩.c1 >= 列数 - 1 ? "整张表都是列，不能再删" : "删掉所选的每一列",
            "colRemove",
            () => 走批量(删所选列),
            false,
            矩.c0 === 0 && 矩.c1 >= 列数 - 1,
          )}
          {/* 对齐是**列**的属性，所以按覆盖到的每一列逐列生效（分隔行与格子一起改，同 setAlign） */}
          {btn("cal-l", "所选的列靠左", "alignLeft", () =>
            走批量((s, 表, 矩) => 对所齐所选(s, 表, 矩, "left"))
          )}
          {btn("cal-c", "所选的列居中", "alignCenter", () =>
            走批量((s, 表, 矩) => 对所齐所选(s, 表, 矩, "center"))
          )}
          {btn("cal-r", "所选的列靠右", "alignRight", () =>
            走批量((s, 表, 矩) => 对所齐所选(s, 表, 矩, "right"))
          )}
          {btn("cal-x", "取消所选的列对齐", "alignNone", () =>
            走批量((s, 表, 矩) => 对所齐所选(s, 表, 矩, ""))
          )}
        </>
      ) : null}
      {表起点 !== null && !矩 ? (
        <>
          {btn("row", "在下面加一行（末格按 Tab 也可以）", "rowAdd", () => 改表(addRow))}
          {btn(
            "row-",
            格 && 格.行 === 0 ? "表头行不能删：表格必须有表头" : "删掉这一行",
            "rowRemove",
            () => 改表(removeRow),
            false,
            !格 || 格.行 === 0 || 格.行数 <= 1,
          )}
          {btn("col", "在右边加一列", "colAdd", () => 改表(addColumn))}
          {btn(
            "col-",
            格 && 格.列数 <= 1 ? "最后一列不能删：表格至少要有一列" : "删掉这一列",
            "colRemove",
            () => 改表(removeColumn),
            false,
            !格 || 格.列数 <= 1,
          )}
          {/* 对齐是这一列的属性：分隔行与每格的样子必须一起改（见 setAlign） */}
          {btn("al-l", "本列靠左", "alignLeft", () => 改对齐("left"), 当前对齐 === "left")}
          {btn("al-c", "本列居中", "alignCenter", () => 改对齐("center"), 当前对齐 === "center")}
          {btn("al-r", "本列靠右", "alignRight", () => 改对齐("right"), 当前对齐 === "right")}
          {btn(
            "al-x",
            "取消本列的对齐",
            "alignNone",
            () => 改对齐(""),
            // 不做"开着"态：默认那档就是"没有对齐"，亮着它等于四个按钮里永远有一个是亮的，
            // 用户会以为点了它才有反应。左/中/右才是要显示"当前是哪一档"的
            false,
          )}
        </>
      ) : null}
      {btn("up", "上移这一块 Alt+↑", "up", () => move(-1), false, !$from.depth)}
      {btn("down", "下移这一块 Alt+↓", "down", () => move(1), false, !$from.depth)}
      <span className="sep" aria-hidden="true" />
      {btn("undo", "撤销", "undo", () => undo(editor.state, (tr) => editor.view.dispatch(tr)), false, undoDepth(editor.state) <= 0)}
      {btn("redo", "重做", "redo", () => redo(editor.state, (tr) => editor.view.dispatch(tr)), false, redoDepth(editor.state) <= 0)}
      <span className="sep" aria-hidden="true" />
    </div>
  );
}

/**
 * 链接输入框。工具栏与选区气泡**共用这一个实现**：两处各写一份的话，早晚一处改了
 * `extendMarkRange` 另一处没改，链接就会吃掉或漏掉半个词。
 */
export function LinkEditor({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [href, setHref] = useState("");
  const 应用 = () => {
    const url = href.trim();
    onDone();
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setMark("link", { href: url }).run();
  };
  return (
    <span className="link-input">
      <input
        autoFocus
        value={href}
        placeholder="https://…"
        spellCheck={false}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (是回车提交(e)) 应用();
          else if (e.key === "Escape") onDone();
        }}
      />
      <button type="button" onClick={应用}>
        好
      </button>
    </span>
  );
}

/**
 * 一档颜色的面板（文字色一个、底色一个，同一份实现）。
 *
 * **色块与文件里的色值同源**（`colors.ts`）：看到红色、存下去是另一个红这种事，
 * 只有打开 .md 才会发现。选中态用一圈 accent 描边而不是打个勾——色块只有 20px，
 * 勾会把颜色本身盖掉，而这一排要回答的就是"这是哪种颜色"。
 *
 * 底色这一档的第一格是**高亮**（`==…==`）：它就是"我们默认的那一档底色"，
 * 与后面六档互斥——两套底同时套在一段字上，文件里会出现
 * `<span style="background-color:…">==字==</span>` 这种谁看都莫名其妙的形状。
 */
function 颜色面板({
  editor,
  mark,
  onDone,
}: {
  editor: Editor;
  mark: "textColor" | "bgColor";
  onDone: () => void;
}) {
  const 框 = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const 点外 = (ev: MouseEvent) => {
      // 工具栏自身不关：再点一次那枚按钮就是"收起"，交给按钮的 toggle 去判
      const t = ev.target as Element | null;
      if (t?.closest?.(".toolbar")) return;
      onDone();
    };
    document.addEventListener("mousedown", 点外);
    return () => document.removeEventListener("mousedown", 点外);
  }, [onDone]);

  const 是底 = mark === "bgColor";
  const 值of = (hex: string) => (是底 ? 底色of(hex) : hex);

  const 设定 = (color?: string) => {
    const 链 = editor.chain().focus();
    if (!color) {
      // "去掉"对底色那一档要把高亮一起摘：两套底只能有一个
      链.unsetMark(mark);
      if (是底) 链.unsetMark("highlight");
      链.run();
    } else if (是底) {
      // 换了底色就不该再留着高亮（见上面那条注释）
      链.unsetMark("highlight").setMark(mark, { color }).run();
    } else {
      链.setMark(mark, { color }).run();
    }
    onDone();
  };

  const 高亮 = 是底 ? editor.isActive("highlight") : false;

  return (
    <div className="color-pop" ref={框} role="group" aria-label={是底 ? "底色" : "文字颜色"}>
      <span className="grp">{是底 ? "底色" : "文字颜色"}</span>
      <div className="swatches">
        {/* 高亮只有底色这一档有。它是"我们认的那一种底"，所以排在第一格、用 token 画 */}
        {是底 ? (
          <button
            type="button"
            className={高亮 ? "swatch mark on" : "swatch mark"}
            title="高亮（Ctrl+Shift+H）"
            aria-label="高亮"
            aria-pressed={高亮 || undefined}
            onClick={() => {
              editor.chain().focus().unsetMark("bgColor").setMark("highlight").run();
              onDone();
            }}
          />
        ) : null}
        {调色板.map((c) => {
          const 色值 = 值of(c.hex);
          const 选着 = editor.isActive(mark, { color: 色值 });
          return (
            <button
              key={c.id}
              type="button"
              className={选着 ? "swatch on" : "swatch"}
              style={{ background: 色值 }}
              title={c.名 + (是底 ? "色底" : "色文字")}
              aria-label={c.名 + (是底 ? "色底" : "色文字")}
              aria-pressed={选着 || undefined}
              onClick={() => 设定(色值)}
            />
          );
        })}
        <button
          type="button"
          className="swatch none"
          title={是底 ? "去掉底色" : "去掉文字颜色"}
          aria-label={是底 ? "去掉底色" : "去掉文字颜色"}
          onClick={() => 设定()}
        >
          <工具图标.alignNone />
        </button>
      </div>
    </div>
  );
}
