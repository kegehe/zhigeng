import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { FirstRun } from "./FirstRun";
import { BlockEditor } from "./editor/BlockEditor";
import { api, describeError, inTauri } from "./ipc/commands";
import type {
  AppInfo,
  EditDoc,
  ImportEntry,
  ImportReport,
  ListNotes,
  SnapshotRow,
  TrashRow,
} from "./ipc/types";

type Theme = "system" | "light" | "dark";
/** 主区当前在干什么。同一时刻只能有一个，切换前必须先离开上一个。 */
type Mode = "view" | "inline" | "source" | "rename" | "trash" | "backup" | "import";
/** 打开着的那一篇。正文由块编辑器自己渲染，所以这里只留标识与标题，不再带块列表 */
type Opened = { rel: string; title: string };

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
  const [selected, setSelected] = useState<Opened | null>(null);
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
  const [editDoc, setEditDoc] = useState<EditDoc | null>(null);
  const [editEpoch, setEditEpoch] = useState(0);
  const [inlineRev, setInlineRev] = useState(0);
  const [saveState, setSaveState] = useState<"clean" | "saving" | "saved" | "conflict">("clean");
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [history, setHistory] = useState<SnapshotRow[]>([]);
  const [backupDraft, setBackupDraft] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [importSrc, setImportSrc] = useState("");
  const [importPlan, setImportPlan] = useState<ImportEntry[] | null>(null);
  const [importResult, setImportResult] = useState<ImportReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const { theme, setTheme } = useTheme();
  const searchTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  /** 行内模式的 Markdown 只在落盘那一刻取一次：整篇序列化是 O(块数) 的 */
  const editApi = useRef<(() => string) | null>(null);
  const editing = mode === "source" || mode === "inline";
  const dirty = inlineRev > 0 || draft !== savedDraft;
  const unsaved = editing && dirty;

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

  // 索引是异步补的。速记落盘后主窗必须自己长回来，否则新笔记要重启才看得见。
  // 事件负载是"变了哪些路径"：正在看的那一篇如果被外部（Obsidian、同步盘）改了，
  // 浏览态要整个重装载——停在旧内容上是验收 ⑤ 没通过的样子。**编辑态不动**：
  // 那时框里是用户还没落盘的东西，覆盖它比显示旧内容更糟。
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    let un: (() => void) | undefined;
    void listen<string[]>("note://indexed", (e) => {
      if (!alive) return;
      void refresh();
      const rels = e.payload ?? [];
      if (mode === "view" && selected && rels.includes(selected.rel)) {
        void loadNote(selected.rel).catch((err) => setError(describeError(err).message));
      }
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
    // 少了 mode / selected 就是白订阅一次：闭包永远停在挂载时那份 selected = null，
    // 外部改动的事件到了、列表也刷了，只有正文不动。速记窗那个"连按守卫"踩过同一类坑。
  }, [refresh, mode, selected]);

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
    // 浏览态永不落盘：打开一篇看看就写文件，等于把"看"变成"改"。读一篇笔记永远不该动它
    if (mode === "view") return true;
    // 行内模式现取现拼：击键路径上不做整篇序列化（3000 块实测 29ms，会把 G6 顶穿）
    const md = mode === "inline" && editApi.current ? editApi.current() : draft;
    if (!selected || md === savedDraft) return true;
    setSaveState("saving");
    try {
      const h = await api.saveNote(selected.rel, md, force ? undefined : baseHash);
      setBaseHash(h);
      setDraft(md);
      setSavedDraft(md);
      setInlineRev(0);
      setSaveState("saved");
      return true;
    } catch (e) {
      const { kind, message } = describeError(e);
      if (kind === "conflict") setSaveState("conflict");
      else setError(message);
      return false;
    }
  }, [selected, mode, draft, savedDraft, baseHash]);

  // 停手 800ms 就存。手动 Ctrl+S 仍然留着——有人不信自动保存
  useEffect(() => {
    if (!editing || !dirty) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(), 800);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [inlineRev, draft, dirty, editing, persist]);

  /**
   * 打开一篇要备齐两样：正文要的块树，与落盘要的 `baseHash`。
   *
   * 浏览用的就是块编辑器本身（同一份渲染、同一套排版），所以块树不能等点"编辑"时才现取——
   * 那样每进一次编辑都要付"整篇解析 + 重挂载"，3000 块实测 297ms，直接把 G7 的 100ms 顶穿。
   * `editEpoch` 同时递增：编辑器只在换篇或磁盘内容变了时才重挂载。
   *
   * **不再调 `readNote`**：那份按索引平铺的块列表在界面上已经没人用了（正文由编辑器渲染），
   * 留着等于每开一篇白付一次 IPC。标题只用于一条提示文案，由列表行带进来。
   */
  const loadNote = async (rel: string, title?: string) => {
    const [src, blocks] = await Promise.all([api.readRaw(rel), api.noteEditDoc(rel)]);
    setSelected({
      rel,
      title: title ?? (selected?.rel === rel ? selected.title : undefined) ?? stemOf(rel),
    });
    setDraft(src.content);
    setSavedDraft(src.content);
    setBaseHash(src.hash);
    setSaveState("clean");
    setEditDoc(blocks);
    setInlineRev(0);
    setEditEpoch((n) => n + 1);
  };

  const openNote = async (rel: string, title?: string) => {
    if (editing && !(await persist())) {
      setFlash("这篇还没存下来——先处理冲突提示");
      return;
    }
    setMode("view");
    setFlash(null);
    try {
      await loadNote(rel, title);
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
    await loadNote(rel);
  };

  /**
   * 进编辑态。行内模式下编辑器浏览时就挂好了，盘没变过就只翻 `editable`。
   *
   * 判断"变没变"只能问磁盘的 hash：浏览期间 Obsidian 或另一个窗口可能改过盘。
   * 这时**不能只把 baseHash 更新成新值**——那等于让过期的一份盖掉外部改动，
   * 违反 docs/02 的"绝不静默覆盖"。浏览态没有用户写的东西可丢，所以直接重装载。
   */
  const startEdit = async (rel?: string, surface: "inline" | "source" = "inline") => {
    const target = rel ?? selected?.rel;
    if (!target) return;
    try {
      if (surface === "inline" && editDoc && selected?.rel === target) {
        const src = await api.readRaw(target);
        if (src.hash === baseHash) {
          setDraft(src.content);
          setSavedDraft(src.content);
          setBaseHash(src.hash);
          setSaveState("clean");
          setMode("inline");
          return;
        }
      }
      await loadNote(target);
      setMode(surface);
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

  /** 行内 ↔ 源码：同一个草稿、同一条自动保存链路，只是换个写法。存不下就不切。 */
  const switchSurface = async () => {
    if (!(await persist())) return;
    if (mode === "inline") {
      setMode("source");
      return;
    }
    if (!selected) return;
    // 源码框那份刚落过盘：块树得按磁盘上的新内容重算，不能拿旧的挂载顶着
    await loadNote(selected.rel);
    setMode("inline");
  };

  const reloadDisk = async () => {
    if (!selected) return;
    try {
      await loadNote(selected.rel);
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
    if (editing && !(await persist())) return;
    try {
      const rel = await api.noteCreate(title);
      setNewTitle("");
      setCreating(false);
      setQuery("");
      // 建笔记是为了写，不是为了看一个空壳：直接进正文编辑态。
      // 装载交给 startEdit——它会把列表元信息、块树与 baseHash 一次取齐
      await startEdit(rel);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const openTrash = async () => {
    if (editing && !(await persist())) return;
    try {
      setTrash(await api.listTrash());
      setMode("trash");
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const openImport = async () => {
    if (editing && !(await persist())) return;
    setMode("import");
    setImportPlan(null);
    setImportResult(null);
  };

  const previewImport = async () => {
    setImportBusy(true);
    setError(null);
    try {
      setImportPlan(await api.importPreview(importSrc.trim()));
      setImportResult(null);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setImportBusy(false);
    }
  };

  const applyImport = async () => {
    setImportBusy(true);
    setError(null);
    try {
      const r = await api.importApply(importSrc.trim());
      setImportResult(r);
      setImportPlan(null);
      await refresh();
      setFlash("导入 " + r.notes.length + " 篇，已重新索引");
      setMode("view");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setImportBusy(false);
    }
  };

  /** 备份面板：状态 + 最近几份 + 当前这篇的历史，一次拉齐 */
  const openBackup = async () => {
    if (editing && !(await persist())) return;
    setMode("backup");
    setBackupDraft(info?.backupDir ?? "");
    try {
      setSnapshots(await api.backupRecent(20));
      setHistory(selected ? await api.backupHistory(selected.rel) : []);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const applyBackup = async (dir: string | null) => {
    setBackupBusy(true);
    setError(null);
    try {
      setInfo(await api.backupSet(dir, dir === null));
      setSnapshots(await api.backupRecent(20));
      setHistory(selected ? await api.backupHistory(selected.rel) : []);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBackupBusy(false);
    }
  };

  const runBackup = async () => {
    setBackupBusy(true);
    setError(null);
    try {
      const made = await api.backupRun();
      await refresh();
      setSnapshots(await api.backupRecent(20));
      // 当前这篇的历史也要跟着刷：不刷的话"立即备份"之后列表还是旧的，
      // 刚备份完却看不到那一份，用户只会以为没备份上
      setHistory(selected ? await api.backupHistory(selected.rel) : []);
      setFlash(made ? `已备份，这次收了 ${made.copiedFiles} 个文件` : "今天已经备份过了，什么都没做");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreFrom = async (id: string) => {
    if (!selected) return;
    const rel = selected.rel;
    setBackupBusy(true);
    setError(null);
    try {
      await api.backupRestore(rel, id);
      await loadNote(rel);
      await refresh();
      setFlash(`已从 ${id} 恢复。被覆盖的那份留在 .note/conflicts/ 里`);
      setMode("view");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBackupBusy(false);
    }
  };

  /** 正文区（行内与源码共用）的两个键。浏览态按 Esc 什么都不做：那时没有编辑态要离开 */
  const bodyKeys = <T extends HTMLElement>(e: ReactKeyboardEvent<T>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void persist();
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      void leaveEdit();
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
                    onClick={() => void openNote(n.rel, n.title)}
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
              <button
                className={btn + (mode === "import" ? " bg-active" : "")}
                onClick={() => void (mode === "import" ? setMode("view") : openImport())}
              >
                导入
              </button>
              {/* 没备份是产品最坏的状态（docs/03：唯一副本 = 没有副本），入口上要看得见 */}
              <button
                className={btn + (mode === "backup" ? " bg-active" : "")}
                onClick={() => void (mode === "backup" ? setMode("view") : openBackup())}
              >
                备份
                {info && (info.backupUnconfigured || info.backupDisabled) ? (
                  <span className="ml-1 text-danger">· 没开</span>
                ) : null}
              </button>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            {mode === "import" ? (
              <div className="px-6 py-8">
                <h2 className="text-xl text-fg">导入外部笔记</h2>
                <p className="mt-2 text-sm text-fg-2">
                  把一个目录里的 <span className="font-mono text-mono">.md</span>{" "}
                  搬进这个库（Obsidian 库、别的文件夹都行）。内容一个字节都不改，子目录结构保留在{" "}
                  <span className="font-mono text-mono">notes/</span>{" "}
                  下面；库里已有同名但内容不同的一篇时自动避让，
                  <span className="text-fg">绝不覆盖</span>你已有的笔记。
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-64 flex-1 rounded-md border border-line bg-base px-3 py-1.5 font-mono text-mono text-fg"
                    value={importSrc}
                    spellCheck={false}
                    placeholder="D:\\我的 Obsidian 库"
                    onChange={(e) => setImportSrc(e.target.value)}
                  />
                  <button
                    className={btn}
                    disabled={importBusy || !importSrc.trim()}
                    onClick={() => void previewImport()}
                  >
                    先看计划
                  </button>
                  <button
                    className={btnPrimary}
                    disabled={importBusy || !importSrc.trim()}
                    onClick={() => void applyImport()}
                  >
                    导入
                  </button>
                </div>

                {importPlan ? (
                  <div className="mt-6">
                    <p className="text-sm text-fg-2">
                      {importPlan.filter((e) => !e.alreadyThere).length} 个要新写 / 共 {importPlan.length}{" "}
                      个文件，库里已有的会跳过。
                      {importPlan.filter((e) => !e.alreadyThere && e.destRel !== "notes/" + e.srcRel)
                        .length > 0
                        ? " 带「改名」的那几篇，笔记里指向它们的 [[链接]] 需要你自己核对。"
                        : ""}
                    </p>
                    <div className="mt-2 flex flex-col gap-1">
                      {importPlan.slice(0, 40).map((e) => (
                        <div
                          key={e.srcRel}
                          className="flex items-baseline gap-3 rounded-md border border-line px-3 py-1.5 text-xs"
                        >
                          <span className="w-14 shrink-0 text-fg-disabled">
                            {e.alreadyThere ? "已存在" : e.markdown ? "笔记" : "附件"}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono">{e.srcRel}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
                            → {e.destRel}
                          </span>
                        </div>
                      ))}
                      {importPlan.length > 40 ? (
                        <div className="text-xs text-fg-disabled">… 只列前 40 项</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {importResult ? (
                  <div className="mt-6 rounded-md border border-line bg-raised px-4 py-3 text-sm">
                    导入 {importResult.notes.length} 篇、附件 {importResult.assets.length} 个，跳过{" "}
                    {importResult.skipped.length} 个，共 {Math.round(importResult.bytes / 1024)} KB。
                    {importResult.renamed.length > 0 ? (
                      <ul className="mt-2 list-disc pl-5 text-xs text-fg-2">
                        {importResult.renamed.map(([from, to]) => (
                          <li key={from}>
                            <span className="font-mono">{from}</span> →{" "}
                            <span className="font-mono">{to}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : mode === "backup" ? (
              <div className="px-6 py-8">
                {/* flash 原本只在正文那一支渲染：结果"立即备份"的反馈在它自己的面板里看不见 */}
                {flash ? <p className="mb-4 text-sm text-fg-2">{flash}</p> : null}
                <h2 className="text-xl text-fg">备份与快照</h2>
                <p className="mt-2 text-sm text-fg-2">
                  每天第一次启动时，把库里<span className="text-fg">变化过的文件</span>增量快照到另一个目录，保留最近
                  30 份。文件原样存着，不压缩：备份要能被资源管理器直接看懂。
                </p>
                <div className="mt-4 rounded-md border border-line bg-raised px-4 py-3 text-sm">
                  {info?.backupDisabled ? (
                    <span className="text-danger">备份已关闭：你的笔记只存在一块盘上。</span>
                  ) : info?.backupUnconfigured ? (
                    <span className="text-danger">还没配置备份目录：同上。</span>
                  ) : (
                    <span>
                      备份到{" "}
                      <span className="font-mono text-mono">{info?.backupDir}</span>
                      {info?.backupLastAt
                        ? ` · 最近一次 ${new Date(info.backupLastAt).toLocaleString()}`
                        : " · 还没做过快照"}
                    </span>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    className={btnPrimary}
                    disabled={backupBusy}
                    onClick={() => void runBackup()}
                  >
                    立即备份
                  </button>
                  <input
                    className="min-w-64 flex-1 rounded-md border border-line bg-base px-3 py-1.5 font-mono text-mono text-fg"
                    value={backupDraft}
                    spellCheck={false}
                    placeholder="E:\\笔记备份"
                    onChange={(e) => setBackupDraft(e.target.value)}
                  />
                  <button
                    className={btn}
                    disabled={backupBusy || !backupDraft.trim()}
                    onClick={() => void applyBackup(backupDraft.trim())}
                  >
                    用这个目录
                  </button>
                  <button className={btn} disabled={backupBusy} onClick={() => void applyBackup(null)}>
                    不备份
                  </button>
                </div>

                <h3 className="mt-8 text-sm text-fg-2">
                  {selected ? `这篇的快照 · ${selected.title}` : "选一篇笔记，就能看它的历史版本"}
                </h3>
                <div className="mt-2 flex flex-col gap-1">
                  {selected && history.length === 0 ? (
                    <div className="text-sm text-fg-disabled">快照里还没有这一篇。</div>
                  ) : null}
                  {selected
                    ? history.map((r) => (
                        <div
                          key={r.id}
                          className="flex items-baseline gap-3 rounded-md border border-line bg-raised px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.id}</span>
                          <span className="shrink-0 text-xs text-fg-disabled">
                            {new Date(r.takenAt).toLocaleString()}
                          </span>
                          <button
                            className={btnPrimary}
                            disabled={backupBusy}
                            onClick={() => void restoreFrom(r.id)}
                          >
                            恢复成这一版
                          </button>
                        </div>
                      ))
                    : null}
                </div>

                <h3 className="mt-8 text-sm text-fg-2">最近的快照</h3>
                <div className="mt-2 flex flex-col gap-1">
                  {snapshots.length === 0 ? (
                    <div className="text-sm text-fg-disabled">还没有快照。</div>
                  ) : null}
                  {snapshots.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-baseline gap-3 rounded-md border border-line px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.id}</span>
                      <span className="shrink-0 text-xs text-fg-disabled">
                        {new Date(r.takenAt).toLocaleString()} · 增量 {r.copiedFiles} / 全库 {r.totalFiles}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : mode === "trash" ? (
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
                      {editing ? (
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
                          <span className="text-fg-disabled">
                            {mode === "inline"
                              ? "所见即所得 · 没改动的块按原文落盘"
                              : "整篇 Markdown 源码"}
                          </span>
                          <button className={btn} onClick={() => void switchSurface()}>
                            {mode === "inline" ? "改源码" : "行内编辑"}
                          </button>
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

                    {mode !== "source" && editDoc ? (
                      <div
                        className="block-editor"
                        onBlur={() => void persist()}
                        onKeyDown={bodyKeys}
                      >
                        <BlockEditor
                          key={`${selected.rel}:${editEpoch}`}
                          doc={editDoc}
                          editable={mode === "inline"}
                          onEditStart={() => setMode("inline")}
                          onEdit={() => setInlineRev((n) => n + 1)}
                          editApi={editApi}
                        />
                      </div>
                    ) : mode === "source" ? (
                      <textarea
                        autoFocus
                        spellCheck={false}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void persist()}
                        onKeyDown={bodyKeys}
                        className="h-[60vh] w-full resize-y rounded-md border border-line bg-sunken p-4 font-mono text-mono leading-body text-fg"
                      />
                    ) : (
                      // 装载中：既不给上一篇留着，也不闪一个空框——骨架意味着"路上有东西"
                      <div className="flex flex-col gap-2">
                        <div className="skeleton h-4 w-2/3" />
                        <div className="skeleton h-3 w-full" />
                        <div className="skeleton h-3 w-5/6" />
                      </div>
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
