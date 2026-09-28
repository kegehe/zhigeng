import { useEffect, useMemo, useRef, useState } from "react";
import { 匹配, type PaletteItem } from "./palette";

/**
 * 命令面板：`Ctrl+K` 唤起，一次输入同时解决"跳到哪篇"和"做个动作"。
 *
 * 三条不显然的：
 * - **破坏性动作不进面板**。改名 / 归档 / 删除在界面上都带着确认或后续处理（冲突要选留哪份），
 *   放进一个"打字 + 回车"的入口等于绕过那道确认。面板里只放不需要二次确认的事。
 * - **Esc 关掉之后焦点要回到开它之前的地方**。它是个临时浮层，不是新页面；回不去就等于
 *   键盘用户每开一次面板都要重新找光标。
 * - 列表只画前 20 条（`匹配` 的上限）。库里 300 篇全渲染进一个浮层，打字那一下就是白付的。
 */
/**
 * 按 `group` 把结果切成连续段（保留全局序号，`aria-activedescendant` 与键盘导航都按序号走）。
 * 段就是 ARIA 的 `role=group`：listbox 允许 group 作为直接后代，group 里才是 option。
 */
function 分段(items: PaletteItem[]): { 名: string; 项: { c: PaletteItem; i: number }[] }[] {
  const 出: { 名: string; 项: { c: PaletteItem; i: number }[] }[] = [];
  items.forEach((c, i) => {
    const 末项 = 出[出.length - 1];
    if (末项 && 末项.名 === c.group) 末项.项.push({ c, i });
    else 出.push({ 名: c.group, 项: [{ c, i }] });
  });
  return 出;
}

export function CommandPalette({
  标题,
  items,
  新建,
  onClose,
}: {
  标题: string;
  items: PaletteItem[];
  /** 给了就在列表顶上多一条"新建笔记「输入的内容」"——打字没找到就是要建 */
  新建?: (标题: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [选, set选] = useState(0);
  const 表 = useRef<HTMLDivElement>(null);
  const 出 = useMemo(() => {
    const 列 = 匹配(q, items, 20);
    const 词 = q.trim();
    if (新建 && 词 && !items.some((i) => i.label === 词)) {
      列.unshift({ id: "新建", group: "新建", label: `新建笔记「${词}」`, run: () => 新建(词) });
    }
    return 列;
  }, [q, items, 新建]);
  // 打字之后原来的第 3 条可能已经不是第 3 条了，越界就贴到末尾
  const 中 = Math.min(选, Math.max(0, 出.length - 1));

  useEffect(() => {
    set选(0);
  }, [q]);

  useEffect(() => {
    表.current?.querySelectorAll('[role="option"]')[中]?.scrollIntoView({ block: "nearest" });
  }, [中, 出.length]);

  const 执行 = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div
      className="palette-scrim fixed inset-0 z-(--z-modal) flex justify-center bg-backdrop px-4 pt-[12vh]"
      onMouseDown={(e) => {
        // 点在遮罩上关，点在面板里不关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={表}
        role="dialog"
        aria-modal="true"
        aria-label={标题}
        className="palette-panel flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-raised shadow-3"
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={中 >= 0 && 出.length ? `palette-opt-${中}` : undefined}
          value={q}
          placeholder="搜笔记，或打个动作…"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              set选((i) => Math.min(i + 1, 出.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              set选((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              执行(出[中]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-base text-fg outline-none placeholder:text-fg-disabled"
        />
        {/* ARIA 的 owned-by 规则：option 必须是 listbox 的**直接**后代（中间只允许 role=group）。
            原先 option 挂在 li 里的 button 上，读屏按 ARIA 走树的时候找不到它——
            看着有 role 标记，实际不播报。焦点留在输入框，靠 aria-activedescendant 指过去。 */}
        <div
          id="palette-list"
          role="listbox"
          aria-label="结果"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {出.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-fg-disabled">没有匹配的笔记或动作</p>
          ) : null}
          {分段(出).map((段) => (
            <div key={段.名} role="group" aria-label={段.名}>
              <div className="px-3 pt-2 pb-1 text-xs text-fg-disabled">{段.名}</div>
              {段.项.map(({ c, i }) => (
                <div
                  key={c.id}
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === 中}
                  onMouseEnter={() => set选(i)}
                  onClick={() => 执行(c)}
                  className={
                    "block w-full cursor-default rounded-md px-3 py-2 text-left text-sm " +
                    (i === 中 ? "bg-accent-soft text-fg" : "text-fg-2")
                  }
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint ? (
                      <span className="shrink-0 truncate font-mono text-xs text-fg-disabled">
                        {c.hint}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
