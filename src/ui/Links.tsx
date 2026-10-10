import type { LinkPanel, LinkRow } from "../ipc/types";
import { 面板判定 } from "./backlinks";

/**
 * 反链面板：正文下面那两段——谁链到我，以及我链到谁（含链空的）。
 *
 * 五条口径：
 * 1. **空了就不占位**。两半都空时整个面板不出现，正文下面不该永远挂两个空标题。
 * 2. **按对方分组**。真库里有一篇把同一个 `[[悬空写法]]` 重复了几十次（长文档性能夹具），
 *    不分组就是一屏重复行；Obsidian 也是按来源笔记归并的。
 * 3. **悬空的那条排前并且带原文**。面板要说的正是"这篇链到了一个不存在的东西"，
 *    `target` 就是为此才进 `links` 表（schema v3）的。它没有可打开的笔记，所以不做成按钮。
 * 4. 归档的来源照收，但标出来。归档是"不主动想起它"，不是"它不存在"。
 * 5. **资产链接（`![[…]]`）说的是盘上的事实**：图在 `attachments/` 里就写"附件在库内"，
 *    真没了才写"文件丢了"。哪一档都不许点开成一篇笔记——它没有对方笔记。
 *    "在不在"由后端查盘算（`note_core::assets::exists`），这儿只负责措辞（`面板判定`）。
 */
export function LinkPanelView({
  panel,
  onOpen,
}: {
  panel: LinkPanel;
  onOpen: (rel: string, title: string) => void;
}) {
  const 入 = 分组(panel.incoming);
  const 出 = 分组(panel.outgoing);
  if (!入.length && !出.length) return null;
  return (
    <section className="mt-10 flex flex-col gap-5 border-t border-line pt-4">
      <LinkGroup label="反向链接" rows={入} 截断={panel.incomingTruncated} onOpen={onOpen} />
      <LinkGroup label="我链到" rows={出} 截断={panel.outgoingTruncated} onOpen={onOpen} />
    </section>
  );
}

/** 归并后的面板行：一条 = 一个对方（或一种写法），带重复次数 */
type 面板行 = { key: string; row: LinkRow; 次数: number; 全到块: boolean };

/**
 * 按"对方是谁"归并。键用 `rel`，悬空的没有 rel 就用原始写法——同一种写法反复出现
 * 是同一件事，分成十条会说谎。
 *
 * `全到块` 而不是"看第一条"：一篇里既有 `[[乙]]` 又有 `[[乙#某标题]]` 时归并成一行，
 * 拿第一条的 toBlock 当徽章会在"第一条是整篇"时把到块那条藏掉，反过来则是在说谎。
 */
function 分组(rows: LinkRow[]): 面板行[] {
  const 有 = new Map<string, 面板行>();
  for (const r of rows) {
    const k = r.rel || `?${r.target}`;
    const 现 = 有.get(k);
    if (现) {
      现.次数++;
      现.全到块 = 现.全到块 && r.toBlock;
    } else 有.set(k, { key: k, row: r, 次数: 1, 全到块: r.toBlock });
  }
  // 悬空排前：那才是需要处理的；其余保持后端给的相关度次序
  return [...有.values()].sort((a, b) => Number(b.row.broken) - Number(a.row.broken));
}

function LinkGroup({
  label,
  rows,
  截断,
  onOpen,
}: {
  label: string;
  rows: 面板行[];
  /** 后端多取一条探到的"还有没有"。不说就等于把截断藏起来 */
  截断?: boolean;
  onOpen: (rel: string, title: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="text-sm text-fg-2">
        {label}
        <span className="ml-1.5 font-mono text-xs text-fg-disabled">{rows.length}</span>
      </h3>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {rows.map((g) => {
          const l = g.row;
          const 判 = 面板判定(l);
          return (
            <li key={g.key}>
              <button
                // 悬空的那条没有笔记可开，资产那一条开的不是笔记。
                // 给它一个"点了没反应"的按钮比不给按钮更坏
                disabled={!判.可打开}
                onClick={() => onOpen(l.rel, l.title)}
                className={
                  "block w-full rounded-md border px-3 py-2 text-left text-sm transition-colors duration-(--dur-1) " +
                  (判.标红
                    ? "cursor-default border-danger bg-danger-soft"
                    : "border-line hover:bg-hover focus-visible:border-accent")
                }
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg">{l.title}</span>
                  {g.次数 > 1 ? (
                    <span className="shrink-0 font-mono text-xs text-fg-disabled">×{g.次数}</span>
                  ) : null}
                  {判.尾注 ? (
                    <span
                      className={
                        "shrink-0 text-xs " + (判.标红 ? "text-danger" : "text-fg-disabled")
                      }
                    >
                      {判.尾注}
                    </span>
                  ) : null}
                  {g.全到块 ? (
                    <span className="shrink-0 text-xs text-fg-disabled">到块</span>
                  ) : null}
                  {l.status === "archived" ? (
                    <span className="shrink-0 text-xs text-fg-disabled">已归档</span>
                  ) : null}
                  {l.status === "inbox" ? (
                    <span className="shrink-0 text-xs text-fg-disabled">待整理</span>
                  ) : null}
                </span>
                {(() => {
                  // 资产行的标题已经是那个路径了，再抄一遍就是两行一样的字
                  const 副 = 判.是资产
                    ? (l.rel === l.title ? "" : l.rel)
                    : l.broken
                      ? `[[${l.target}]]`
                      : l.snippet || l.rel;
                  return 副 ? (
                    <span className="mt-0.5 block truncate text-xs text-fg-2">{副}</span>
                  ) : null;
                })()}
              </button>
            </li>
          );
        })}
      </ul>
      {截断 ? (
        <p className="mt-1.5 px-3 text-xs text-fg-disabled">还有更多没列出来。</p>
      ) : null}
    </div>
  );
}
