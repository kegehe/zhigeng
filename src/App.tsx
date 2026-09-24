import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { FirstRun } from "./FirstRun";
import { api, inTauri } from "./ipc/commands";
import type { AppInfo, ListNotes, NoteDetail } from "./ipc/types";

type Theme = "system" | "light" | "dark";

function useTheme() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return { theme, setTheme };
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [notes, setNotes] = useState<ListNotes | null>(null);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.searchKeyword>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { theme, setTheme } = useTheme();
  const searchTimer = useRef<number | null>(null);

  const apply = useCallback(async (app: AppInfo) => {
    setInfo(app);
    if (!app.vaultPath) {
      // 没选库时不去调 list_notes——它会失败，把首启界面盖成报错条
      setNotes(null);
      return;
    }
    try {
      setNotes(await api.listNotes(300));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!inTauri()) {
      setError("浏览器直开：没有 Tauri 运行时。用 pnpm tauri dev 启动。");
      return;
    }
    setBusy(true);
    try {
      await apply(await api.appInfo());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 索引是异步补的。速记落盘后主窗必须自己长回来，否则新笔记要重启才看得见
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    let un: (() => void) | undefined;
    void listen("note://indexed", () => {
      if (alive) void refresh();
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (query.trim().length < 1 || !inTauri()) {
      setHits([]);
      return;
    }
    // 300ms 防抖：每次按键都打后端会把 8ms 预算变成排队
    searchTimer.current = window.setTimeout(() => {
      api.searchKeyword(query, 30).then(setHits).catch((e) => setError(String(e)));
    }, 300);
  }, [query]);

  const list = notes?.notes ?? [];
  const searching = query.trim().length > 0;
  /**
   * 搜索态直接渲染命中，不能拿它去和启动时缓存的列表求交集——
   * 那样刚速记进来的笔记（列表里没有）永远搜不到。一块命中一条笔记，按笔记去重。
   */
  const rows = useMemo(() => {
    if (searching) {
      const seen = new Set<string>();
      const out: { rel: string; title: string; sub: string; ms: number }[] = [];
      for (const h of hits) {
        if (seen.has(h.path)) continue;
        seen.add(h.path);
        out.push({ rel: h.path, title: h.title, sub: h.snippet, ms: 0 });
      }
      return out;
    }
    return list.map((n) => ({ rel: n.rel, title: n.title, sub: n.rel, ms: n.updatedMs }));
  }, [searching, hits, list]);

  const openNote = async (rel: string) => {
    try {
      setSelected(await api.readNote(rel));
    } catch (e) {
      setError(String(e));
    }
  };

  const win = inTauri() ? getCurrentWindow() : null;

  return (
    <div className="flex h-full flex-col bg-base text-fg">
      <header className="titlebar surface" data-tauri-drag-region>
        <span className="px-2 font-mono text-xs text-fg-2">
          note<span className="text-fg-disabled"> {info?.version}</span>
        </span>
        <span className="title" data-tauri-drag-region>
          {info?.vaultPath ?? ""}
        </span>
        <label className="flex items-center gap-1 px-2 text-xs">
          <span>主题</span>
          <select
            className="rounded-md border border-line bg-raised px-1 py-0.5 text-xs"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            <option value="system">跟随系统</option>
            <option value="light">亮色</option>
            <option value="dark">暗色</option>
          </select>
        </label>
        <button className="win-btn" onClick={() => void refresh()} title="重新读取索引与列表">
          {busy ? "…" : "↻"}
        </button>
        {win ? (
          <>
            <button className="win-btn" onClick={() => void win.minimize()}>─</button>
            <button className="win-btn" onClick={() => void win.toggleMaximize()}>▢</button>
            <button className="win-btn close" onClick={() => void win.close()}>✕</button>
          </>
        ) : null}
      </header>

      {error ? (
        <div className="border-b border-line bg-danger-soft px-4 py-2 text-sm text-fg">
          {error}
        </div>
      ) : null}

      {info && !info.vaultPath ? (
        <FirstRun onOpened={(app) => void apply(app)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-raised">
            <div className="p-2">
              <input
                className="w-full rounded-md border border-line bg-base px-2 py-1.5 text-sm focus-visible:border-accent"
                placeholder="搜索笔记（全文）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto pb-4">
              {rows.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-fg-disabled">
                  {searching ? "没有匹配的笔记" : notes ? "这个 Vault 还没有笔记" : "加载中"}
                </div>
              ) : null}
              {rows.map((n) => {
                const active = selected?.rel === n.rel;
                return (
                  <button
                    key={n.rel}
                    onClick={() => void openNote(n.rel)}
                    className={
                      "block w-full px-3 py-1.5 text-left text-sm transition-colors duration-(--dur-1) " +
                      (active ? "bg-accent-soft text-fg" : "hover:bg-hover")
                    }
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{n.title}</span>
                      <span className="shrink-0 font-mono text-xs text-fg-disabled">
                        {relativeTime(n.ms)}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-xs text-fg-disabled">
                      {n.sub}
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="prose-note measure px-6 py-8">
              {selected ? (
                <>
                  <h1>{selected.title}</h1>
                  {selected.blocks
                    // 标题就是首行时（速记进来的笔记常见），首块标题不再重复渲染一遍
                    .filter(
                      (b, i) =>
                        !(
                          i === 0 &&
                          b.type === "heading" &&
                          b.text.trim() === selected.title.trim()
                        )
                    )
                    .map((b) => {
                      if (b.type === "heading") {
                        const level = b.headingLevel ?? 2;
                        const Tag = (`h${Math.min(6, Math.max(2, level))}`) as "h2";
                        return <Tag key={b.id}>{b.text}</Tag>;
                      }
                      return <p key={b.id}>{b.text}</p>;
                    })}
                </>
              ) : (
                <div className="flex flex-col items-start gap-2 text-fg-2">
                  <div className="text-lg">
                    {notes && notes.notes.length === 0
                      ? "还没有笔记。按 Alt+Shift+N 记第一条。"
                      : "选一篇笔记，或者从左边搜一个词。"}
                  </div>
                  {/* 骨架屏只在真的有东西在路上时出现：常驻骨架=在骗人 */}
                  {!info ? (
                    <>
                      <div className="skeleton h-3 w-64" />
                      <div className="skeleton h-3 w-80" />
                      <div className="skeleton h-3 w-48" />
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
