import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { FirstRun } from "./FirstRun";
import { api, describeError, inTauri } from "./ipc/commands";
import type { AppInfo, ListNotes, NoteDetail, TrashRow } from "./ipc/types";

type Theme = "system" | "light" | "dark";
/** 主区当前在干什么。同一时刻只能有一个，切换前必须先离开上一个。 */
type Mode = "view" | "edit" | "rename" | "trash";

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

const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
/** 文件名去掉扩展名——改名框里不该让用户自己处理 `.md` */
const stemOf = (rel: string) => baseOf(rel).replace(/\.markdown$/, "").replace(/\.md$/, "");

const btn =
  "rounded-md border border-line px-2 py-1 text-xs text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover";
const btnPrimary =
  "rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover disabled:bg-active disabled:text-fg-disabled";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [notes, setNotes] = useState<ListNotes | null>(null);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.searchKeyword>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [trash, setTrash] = useState<TrashRow[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [baseHash, setBaseHash] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [saveState, setSaveState] = useState<"clean" | "saving" | "saved" | "conflict">("clean");
  const { theme, setTheme } = useTheme();
  const searchTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const unsaved = mode === "edit" && draft !== savedDraft;

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

  // 提示是过路信息，不该赖在界面上
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(t);
  }, [flash]);

  const list = notes?.notes ?? [];  const searching = query.trim().length > 0;
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

  /**
   * 把当前草稿写盘。自动保存、Ctrl+S、失焦、切笔记前都走这一个入口。
   * 带 `baseHash` 去存，磁盘上已经不是那份就报冲突——**冲突时不覆盖**，
   * 让用户选留哪份（docs/02 §写入与外部修改：绝不静默覆盖）。
   */
  const persist = useCallback(async (force = false): Promise<boolean> => {
    if (!selected || draft === savedDraft) return true;
    setSaveState("saving");
    try {
      const h = await api.saveNote(selected.rel, draft, force ? undefined : baseHash);
      setBaseHash(h);
      setSavedDraft(draft);
      setSaveState("saved");
      return true;
    } catch (e) {
      const { kind, message } = describeError(e);
      if (kind === "conflict") setSaveState("conflict");
      else setError(message);
      return false;
    }
  }, [selected, draft, savedDraft, baseHash]);

  // 停手 800ms 就存。手动 Ctrl+S 仍然留着——有人不信自动保存
  useEffect(() => {
    if (mode !== "edit" || draft === savedDraft) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(), 800);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [draft, savedDraft, mode, persist]);

  const openNote = async (rel: string) => {
    if (mode === "edit" && !(await persist())) {
      setFlash("这篇还没存下来——先处理冲突提示");
      return;
    }
    setMode("view");
    setFlash(null);
    try {
      setSelected(await api.readNote(rel));
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  /** 管理动作之后：列表 + 当前篇都要跟着变（改名会换 rel，所以传进来） */
  const afterChange = async (rel?: string | null) => {
    await refresh();
    setFlash(null);
    if (!rel) {
      setSelected(null);
      setMode("view");
      return;
    }
    setSelected(await api.readNote(rel));
  };

  const startEdit = async (rel?: string) => {
    const target = rel ?? selected?.rel;
    if (!target) return;
    try {
      const src = await api.readRaw(target);
      setDraft(src.content);
      setSavedDraft(src.content);
      setBaseHash(src.hash);
      setSaveState("clean");
      setMode("edit");
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  /** 离开编辑态：先确保存下来了，存不下就不离开（不静默丢用户写的东西） */
  const leaveEdit = async () => {
    if (!(await persist())) return;
    const rel = selected?.rel;
    setMode("view");
    if (rel) await afterChange(rel);
  };

  const reloadDisk = async () => {
    if (!selected) return;
    try {
      const src = await api.readRaw(selected.rel);
      setDraft(src.content);
      setSavedDraft(src.content);
      setBaseHash(src.hash);
      setSaveState("clean");
      setFlash("已换成磁盘上的版本，你的草稿被丢弃了");
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const commitRename = async () => {
    if (!selected) return;
    const next = nameDraft.trim();
    if (!next) {
      setMode("view");
      return;
    }
    try {
      const newRel = await api.noteRename(selected.rel, next);
      setMode("view");
      await afterChange(newRel);
    } catch (e) {
      const { kind, message } = describeError(e);
      setError(kind === "conflict" ? `「${next}」这个位置已经有笔记了，没动你的文件` : message);
    }
  };

  const toggleArchive = async () => {
    if (!selected) return;
    const from = selected.rel;
    const target = from.startsWith("archive/")
      ? `notes/${baseOf(from)}`
      : `archive/${baseOf(from)}`;
    try {
      await api.noteMove(from, target);
      await afterChange(target);
      setFlash(from.startsWith("archive/") ? "已移出归档" : "已归档");
    } catch (e) {
      const { kind, message } = describeError(e);
      setError(kind === "conflict" ? "目标目录里已经有同名笔记了，没动你的文件" : message);
    }
  };

  const trashNote = async () => {
    if (!selected) return;
    const gone = selected.title;
    try {
      await api.noteTrash(selected.rel);
      await afterChange(null);
      setFlash(`「${gone}」已移入回收站`);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const createNote = async () => {
    const title = newTitle.trim();
    if (!title) return;
    if (mode === "edit" && !(await persist())) return;
    try {
      const rel = await api.noteCreate(title);
      setNewTitle("");
      setCreating(false);
      setQuery("");
      setSelected(await api.readNote(rel));
      // 建笔记是为了写，不是为了看一个空壳：直接进正文编辑态
      await startEdit(rel);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const openTrash = async () => {
    if (mode === "edit" && !(await persist())) return;
    try {
      setTrash(await api.listTrash());
      setMode("trash");
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const restore = async (t: TrashRow) => {
    try {
      await api.noteRestore(t.batch, t.rel);
      await refresh();
      setFlash(`已恢复 ${t.rel}`);
    } catch (e) {
      const { kind, message } = describeError(e);
      // 原位被同名笔记占住是正常结果，报出来就行
      setError(kind === "conflict" ? `原位已经有 ${t.rel} 了，先给那边改名或删掉` : message);
    } finally {
      setTrash(await api.listTrash().catch(() => []));
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
            <div className="flex gap-2 p-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-line bg-base px-2 py-1.5 text-sm focus-visible:border-accent"
                placeholder="搜索笔记（全文）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className={btn}
                title="新建笔记"
                onClick={() => setCreating((c) => !c)}
              >
                ＋
              </button>
            </div>
            {creating ? (
              <div className="px-2 pb-2">
                <input
                  autoFocus
                  className="w-full rounded-md border border-accent bg-base px-2 py-1.5 text-sm"
                  placeholder="标题，回车创建"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createNote();
                    else if (e.key === "Escape") {
                      setNewTitle("");
                      setCreating(false);
                    }
                  }}
                />
              </div>
            ) : null}
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
            <div className="border-t border-line p-2">
              <button
                className={btn + (mode === "trash" ? " bg-active" : "")}
                onClick={() => void (mode === "trash" ? setMode("view") : openTrash())}
              >
                回收站
              </button>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            {mode === "trash" ? (
              <div className="px-6 py-8">
                <h2 className="text-xl text-fg">回收站</h2>
                <p className="mt-2 text-sm text-fg-2">
                  删掉的笔记存在 <span className="font-mono text-mono">.note/trash/</span>，恢复即移回原路径。清空这个目录才是真删。
                </p>
                <div className="mt-6 flex flex-col gap-1">
                  {trash.length === 0 ? (
                    <div className="text-sm text-fg-disabled">是空的。</div>
                  ) : null}
                  {trash.map((t) => (
                    <div
                      key={t.batch + t.rel}
                      className="flex items-baseline gap-3 rounded-md border border-line bg-raised px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{stemOf(t.rel)}</span>
                      <span className="shrink-0 font-mono text-xs text-fg-disabled">
                        {t.rel} · {relativeTime(t.updatedMs)}
                      </span>
                      <button className={btnPrimary} onClick={() => void restore(t)}>
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="prose-note measure px-6 py-8">
                {selected ? (
                  <>
                    <div className="mb-4 flex items-center gap-2 text-xs">
                      {mode === "edit" ? (
                        <>
                          <button className={btnPrimary} onClick={() => void leaveEdit()}>
                            完成 (Esc)
                          </button>
                          <span
                            className={
                              saveState === "conflict"
                                ? "text-danger"
                                : unsaved
                                  ? "text-fg-2"
                                  : "text-fg-disabled"
                            }
                          >
                            {saveState === "conflict"
                              ? "这篇在别处被改过，你的修改还没落盘"
                              : saveState === "saving" || unsaved
                                ? "未保存的修改"
                                : "已自动保存"}
                          </span>
                          <span className="text-fg-disabled">整篇 Markdown 源码</span>
                        </>
                      ) : mode === "rename" ? (
                        <>
                          <input
                            autoFocus
                            className="min-w-0 flex-1 rounded-md border border-accent bg-base px-2 py-1 text-sm"
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitRename();
                              else if (e.key === "Escape") setMode("view");
                            }}
                          />
                          <button className={btnPrimary} onClick={() => void commitRename()}>
                            改名
                          </button>
                        </>
                      ) : (
                        <>
                          <button className={btnPrimary} onClick={() => void startEdit()}>
                            编辑
                          </button>
                          <button
                            className={btn}
                            onClick={() => {
                              setNameDraft(stemOf(selected.rel));
                              setMode("rename");
                            }}
                          >
                            改名
                          </button>
                          <button className={btn} onClick={() => void toggleArchive()}>
                            {selected.rel.startsWith("archive/") ? "取消归档" : "归档"}
                          </button>
                          <button className={btn + " text-danger"} onClick={() => void trashNote()}>
                            删除
                          </button>
                        </>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-xs text-fg-disabled">
                        {selected.rel}
                      </span>
                    </div>
                    {saveState === "conflict" ? (
                      <div className="mb-4 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm">
                        这篇在你编辑期间被别处改过（Obsidian、另一个窗口，或同步）。
                        你写的还在框里，但还没落盘——选一个：
                        <div className="mt-3 flex gap-2">
                          <button className={btn} onClick={() => void reloadDisk()}>
                            丢掉我的，用磁盘版本
                          </button>
                          <button className={btn} onClick={() => void persist(true)}>
                            仍然存我这份
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {flash ? <p className="mb-4 text-xs text-fg-2">{flash}</p> : null}

                    {mode === "edit" ? (
                      <textarea
                        autoFocus
                        spellCheck={false}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void persist()}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                            e.preventDefault();
                            void persist();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            void leaveEdit();
                          }
                        }}
                        className="h-[60vh] w-full resize-y rounded-md border border-line bg-sunken p-4 font-mono text-mono leading-body text-fg"
                      />
                    ) : (
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
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-start gap-2 text-fg-2">
                    <div className="text-lg">
                      {flash ? (
                        flash
                      ) : notes && notes.notes.length === 0 ? (
                        "还没有笔记。按 Alt+Shift+N 记一条，或用左上的 ＋ 建一篇。"
                      ) : (
                        "选一篇笔记，或者从左边搜一个词。"
                      )}
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
            )}
          </main>
        </div>
      )}
    </div>
  );
}
