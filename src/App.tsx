import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { FirstRun } from "./FirstRun";
import { BlockEditor } from "./editor/BlockEditor";
import { api, describeError, inTauri, 设库根 } from "./ipc/commands";
import { 徽标, 徽标红, 可检索, 缺项, 步骤名, 探针结论 } from "./ui/ai";
import { 来源徽章, 走了哪几路, 面板标题 } from "./ui/search";
import {
  buildTree,
  dirsOf,
  flatten,
  parentOf,
  层名,
  层内名字,
  合并层,
  type Branch,
} from "./ui/tree";
import { 判落点, 算动作, type 行 as 拖行, type 落点 } from "./ui/dragdrop";
import { LinkPanelView } from "./ui/Links";
import { CommandPalette } from "./ui/CommandPalette";
import type { PaletteItem } from "./ui/palette";
import type {
  AppInfo,
  EditDoc,
  ImportEntry,
  AiDiscovery,
  AiProbeReport,
  AiRun,
  AiView,
  Answer,
  HybridHit,
  HybridResult,
  ImportReport,
  LinkPanel,
  ListNotes,
  SiblingOrder,
  SnapshotRow,
  TrashRow,
} from "./ipc/types";
import { 读主题, 套主题, 写主题, 盯主题变化, type Theme } from "./ui/theme";

/**
 * 主区当前在干什么。同一时刻只能有一个，切换前必须先离开上一个。
 *
 * `"view"` **不是"浏览态"**，是"主区没打开任何可编辑面"的空态（没选笔记，或面板刚关掉）。
 * 打开一篇笔记直接就是 `"inline"`：正文本来就是同一个编辑器实例，只翻 `editable`，
 * 所以"打开即可编辑"不多花一次解析、也不多一次挂载。"看一篇会不会写坏文件"这件事
 * 交给 `dirty` 判据守（没改过就不落盘），不再靠一个模式开关。
 */
type Mode =
  "view"
  | "inline"
  | "source"
  | "rename"
  | "trash"
  | "backup"
  | "import"
  | "ai"
  | "ask";
/** 打开着的那一篇。正文由块编辑器自己渲染，所以这里只留标识与标题，不再带块列表 */
type Opened = { rel: string; title: string };

function useTheme() {
  const [theme, set档] = useState<Theme>(读主题);
  useEffect(() => {
    /**
     * 这里**只套不存**。存只发生在用户真的点了一档那条路（下面的 `setTheme`）：
     * 挂载与"收到另一个窗口改了"都走这个 effect，跟着 `setItem` 会把外部清掉的那一条
     * （`removeItem` / `localStorage.clear()`）立刻补回去——"重置"永远不生效，
     * 而且两个窗口互相补写看着就像死循环。
     */
    套主题(theme);
    return 盯主题变化(() => {
      const 新 = 读主题();
      套主题(新);
      set档(新);
    });
  }, [theme]);
  const setTheme = (t: Theme) => {
    写主题(t); // 套 + 落 localStorage；另一个窗口靠 `storage` 事件跟上来
    set档(t);
  };
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

/**
 * 按钮基线。两条来自 [06] §3 而以前没落地的：
 * - **禁用态降透明度，不降对比**——`disabled:text-fg-disabled` 那套写法把字与底一起调淡，
 *   实测 2.88:1，比"降透明度"更糟的是它看着像"能点但很弱"而不是"不能点"。
 * - **按下去要有 `translateY(1px)`**：动的是 transform，不触发布局（§动效那条允许）。
 */
const btn =
  "rounded-md border border-line px-2 py-1 text-xs text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover active:translate-y-px";
const btnPrimary =
  "rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:opacity-55";
/**
 * 侧栏底栏那一排入口的"当前开着哪一格"。选中那一格连字一起提到主色：
 * 底色加深之后次要色压上去实测 6.2:1、主色 14.5:1——过线是过线，但"这一格开着"
 * 是这一排唯一的定位信息，不该靠一层 1.46:1 的底色去猜。
 */
const btnOn = (开着: boolean) => btn + (开着 ? " bg-active text-fg" : "");

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [notes, setNotes] = useState<ListNotes | null>(null);
  const [selected, setSelected] = useState<Opened | null>(null);
  const [query, setQuery] = useState("");
  /** 侧栏目录树折叠了哪些目录。记路径不记显示名（显示名会随顶层标签变） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 侧栏自定义顺序（`.note/tree.toml`）。空表 = 谁都没拖过，一切按默认规则 */
  const [order, setOrder] = useState<SiblingOrder[]>([]);
  /**
   * 正在拖的行、当前落点、指示线位置。`线顶` 用的是 nav 的**内容坐标**——
   * 线要跟着滚动内容走，拿视口坐标画会在滚动时飘掉。
   */
  const [drag, setDrag] = useState<{ 被拖: 拖行; 落: 落点; 线顶: number | null } | null>(null);
  const dragRef = useRef<{ 被拖: 拖行; 落: 落点; 线顶: number | null } | null>(null);
  /**
   * 拖完那一下浏览器还会补一个 click，不拦就会顺手折叠目录 / 打开笔记。
   *
   * 用"最后一次拖拽结束的时间戳"而不是布尔标记 + `setTimeout(0)`：真机照过那条时序不稳，
   * 定时器可能在 click 派发之前就跑完了，于是那一下折叠还是漏了进去。
   *
   * **只吞被拖的那一行**：按在 A 行、松在 B 行时浏览器把 click 发给两行的共同祖先，
   * B 行的 onClick 本来就不会跑。整棵树一起吞会吃掉"拖完立刻点开另一篇"的那一下（要点两次）。
   */
  const 刚拖过的行 = useRef<{ 键: string; 刻: number }>({ 键: "", 刻: 0 });
  const 刚拖过 = (键: string) =>
    键 === 刚拖过的行.current.键 && performance.now() - 刚拖过的行.current.刻 < 300;
  const navRef = useRef<HTMLElement | null>(null);
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
  /** 反链面板。null = 还没拿到或这篇没有链接；面板自己判空，不占位 */
  const [links, setLinks] = useState<LinkPanel | null>(null);
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
  /**
   * AI 设置面板。`aiView` 是后端给的视图（**里面没有 Key**）；`aiKey` 只是这一次按"存"
   * 要发出去的那串字，存完立刻清空——界面上永不回显明文。
   * `ai测过` 刻意不持久化：重启之后还挂着"已连通"，说的是上次开机时的事实。
   */
  const [aiView, setAiView] = useState<AiView | null>(null);
  const [aiForm, setAiForm] = useState({ baseUrl: "", chatModel: "", embeddingModel: "" });
  const [aiKey, setAiKey] = useState("");
  const [aiReport, setAiReport] = useState<AiProbeReport | null>(null);
  const [aiBusy, setAiBusy] = useState<"save" | "key" | "test" | "models" | null>(null);
  const [ai测过, setAi测过] = useState<boolean | null>(null);
  /** 「这家有哪些模型」的结果。它**不持久化**：清单是端点此刻的事实，重启就可能变了 */
  const [ai发现, setAi发现] = useState<AiDiscovery | null>(null);
  /**
   * 语义那一路的结果。它**永远比关键词晚到**（含一次网络往返），所以单独一块，
   * 不混进那张按 BM25 排的命中表——混进去会让人以为两批东西是同一把尺子量出来的。
   * `ai就绪` 只判地址 + 嵌入模型：对话模型是问答那一档的前提，不该挡检索。
   */
  const [sem, setSem] = useState<HybridResult | null>(null);
  const [semErr, setSemErr] = useState<string | null>(null);
  const [semBusy, setSemBusy] = useState(false);
  const [ai就绪, setAi就绪] = useState(false);
  /** 问答面板：一次一问，答案连同"这次采信了哪几块"一起摆在原地 */
  const [问, set问] = useState("");
  const [答, set答] = useState<Answer | null>(null);
  const [问busy, set问busy] = useState(false);
  const [runs, setRuns] = useState<AiRun[]>([]);
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
    // 图片块要它把 `attachments/…` 拼成能读的地址。存这一份而不是塞进节点 attrs：
    // 绝对路径是**会话状态**，跟着库走；躺在节点里就会被复制走、被写进 JSON，换台机器即坏
    设库根(app.vaultPath);
    if (!app.vaultPath) {
      // 没选库时不去调 list_notes——它会失败，把首启界面盖成报错条
      setNotes(null);
      return;
    }
    // AI 那一路的开关只问一次：读的是本地配置与凭据管理器，不在打字路径上。
    // 没配就别让搜索框每次敲字都去打一趟注定失败的请求
    api
      .aiView()
      .then((v) => {
        setAi就绪(可检索(v));
        setAiView(v);
        setAiForm({ baseUrl: v.baseUrl, chatModel: v.chatModel, embeddingModel: v.embeddingModel });
      })
      .catch(() => setAi就绪(false));
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

  /**
   * 自定义顺序**跟着库读一次**，不跟着 refresh 走。
   *
   * refresh 由 `note://indexed` 驱动（每存一篇都来一趟），而刚乐观更新的新序可能还没
   * 落进 tree.toml——跟着刷就会把界面打回旧序，用户看到的是"拖完自己又弹回去"。
   */
  useEffect(() => {
    const 库 = info?.vaultPath;
    if (!库 || !inTauri()) return;
    void api
      .treeOrder()
      .then(setOrder)
      .catch(() => setOrder([]));
  }, [info?.vaultPath]);

  /**
   * 反链面板的读命令。**不挡正文**：单独一趟，晚一点到就晚一点到。
   *
   * 回来时按 `panel.rel` 对一下当前要看的那一篇——快速连开两篇时，先发的请求可能后到，
   * 不判就会把上一篇的面板贴到这一篇下面。
   *
   * 保存之后**不**立刻调它：链接图是后台索引算出来的，那时问到的还是旧图。
   * 面板跟着 `note://indexed` 走，索引一落地就自己更新。
   */
  const loadLinks = useCallback((rel: string, 静默 = false) => {
    if (!静默) setLinks(null);
    void api
      .noteLinks(rel)
      .then((p) => setLinks(p.rel === rel ? p : null))
      // 静默刷新失败就留着手上那份：面板是辅助信息，一次读失败不该把它抹成空
      .catch(() => {
        if (!静默) setLinks(null);
      });
  }, []);

  // 索引是异步补的。速记捕获落盘后主窗必须自己长回来，否则新笔记要重启才看得见。
  // 事件负载是"变了哪些路径"：正在看的那一篇如果被外部（Obsidian、同步盘）改了，
  // 手里没有未落盘的东西就整个重装载——停在旧内容上是验收 ⑤ 没通过的样子。
  // **判据是 `unsaved`，不是"有没有在编辑态"**：现在打开就是可编辑的，"在编辑态"不再
  // 意味着"有东西会丢"；真正会丢的只有没存下来的改动。
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    let un: (() => void) | undefined;
    void listen<string[]>("note://indexed", (e) => {
      if (!alive) return;
      void refresh();
      const rels = e.payload ?? [];
      // 面板跟着索引走。**不按 rels 过滤**：改名 / 归档的负载里只有"被搬走的那一篇"，
      // 而它的一批入链方（可能正是眼前这篇）不在名单里——只认"库里刚补过索引"这件事。
      // 静默刷新：不清空重画，避免每存一次面板闪一下。
      if (selected) loadLinks(selected.rel, true);
      if (!unsaved && selected && rels.includes(selected.rel)) {
        // **先比内容，再决定要不要重装载**。自己按下保存也会绕一圈回到这里，而重装载是
        // 整棵编辑器重挂载：光标、撤销栈、正开着的菜单全丢。真机就是这么暴露的——
        // 打 `/` 唤出块菜单，1.5 秒后菜单自己没了，因为那次保存的事件回来了。
        void api
          .readRaw(selected.rel)
          .then((src) => {
            if (!alive) return;
            if (src.content === savedDraft) return; // 就是我们刚存下去的那份
            void loadNote(selected.rel).catch((err) => setError(describeError(err).message));
          })
          .catch((err) => setError(describeError(err).message));
      }
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
    // 少了 selected / unsaved 就是白订阅一次：闭包永远停在挂载时那份 selected = null，
    // 外部改动的事件到了、列表也刷了，只有正文不动。速记窗那个"连按守卫"踩过同一类坑。
  }, [refresh, selected, unsaved, savedDraft, loadLinks]);

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

  /** 晚到的响应要认自己问的是哪句：不认就会把上一次查询的语义结果贴在当前查询下面 */
  const 问的是 = useRef(query);
  问的是.current = query;

  /**
   * 混合检索那一路：比关键词再晚一档（700ms），因为它可能含一次网络往返，而且它只是补充——
   * 用户真正在等的永远是先出来的那批。
   *
   * 2026-10-18 起**不再被 `ai就绪` 挡着**：这一趟里图扩展那一路是纯本地的，
   * 不配任何 Key 也有东西可给。用它挡着，等于把唯一人人都有的一路藏起来，
   * 而设置面板那句"检索走关键词与链接"就成了当场可拆的谎。
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1 || !inTauri()) {
      setSem(null);
      setSemErr(null);
      setSemBusy(false);
      return;
    }
    const t = window.setTimeout(() => {
      setSemBusy(true);
      api
        .searchHybrid(q)
        .then((r) => {
          if (问的是.current.trim() !== q) return;
          setSem(r);
          setSemErr(null);
          setSemBusy(false);
        })
        .catch((e) => {
          if (问的是.current.trim() !== q) return;
          setSem(null);
          setSemErr(describeError(e).message);
          setSemBusy(false);
        });
    }, 700);
    return () => window.clearTimeout(t);
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
   * 目录树。搜索态**仍然是平铺命中**——命中带的是相关度，按目录分组会把"最像的那篇"
   * 埋进某个折叠目录里，那是把搜索变差。
   */
  const tree = useMemo(() => buildTree(list, order), [list, order]);
  const sidebarRows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);
  const toggleDir = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  /** 打开一篇就把它那条路径露出来：从搜索里点进折叠目录里的笔记，不该看见"找不到" */
  const revealPath = (rel: string) =>
    setCollapsed((c) => {
      const chain = dirsOf(rel);
      if (!chain.some((p) => c.has(p))) return c;
      const next = new Set(c);
      for (const p of chain) next.delete(p);
      return next;
    });

  /**
   * 一行 → 拖拽眼里的样子。数据全挂在 `data-*` 上、判落点时从 DOM 现读，
   * 因为"指针现在在哪一行"这件事只有渲染出来的东西说得准，再养一份状态就是第二真相。
   */
  const 行信息 = (b: Branch): 拖行 => {
    const 自身 = b.kind === "dir" ? b.path : b.rel;
    return {
      键: (b.kind === "dir" ? "d:" : "n:") + 自身,
      父: parentOf(自身),
      名: 层名(b),
      是目录: b.kind === "dir",
      自身,
    };
  };
  const 行of = (el: Element | null | undefined): 拖行 | null => {
    if (!(el instanceof HTMLElement)) return null;
    const 键 = el.dataset.treeKey;
    if (键 === undefined) return null;
    return {
      键,
      父: el.dataset.treeParent ?? "",
      名: el.dataset.treeName ?? "",
      是目录: el.dataset.treeDir === "1",
      自身: el.dataset.treeSelf ?? "",
    };
  };

  /** 此刻指针下的落点。判据本体在 `ui/dragdrop.ts`（那里测得到，这里只负责量像素） */
  const 落点在此刻 = (被拖: 拖行, x: number, y: number) => {
    const nav = navRef.current;
    const el = document.elementFromPoint(x, y)?.closest("[data-tree-key]");
    const 命中 = 行of(el);
    if (!nav || !el || !命中) return { 被拖, 落: null as 落点, 线顶: null };
    const r = el.getBoundingClientRect();
    const 落 = 判落点(被拖, 命中, 行of(el.nextElementSibling), y - r.top, r.height);
    const 原点 = nav.getBoundingClientRect().top - nav.scrollTop;
    const 线顶 =
      !落 || 落.kind === "into"
        ? null
        : (落.前 === 命中.名 ? r.top : r.bottom) - 原点;
    return { 被拖, 落, 线顶 };
  };

  const 设拖 = (v: { 被拖: 拖行; 落: 落点; 线顶: number | null } | null) => {
    dragRef.current = v;
    setDrag(v);
  };

  /**
   * 树行按下：挪动超过 5px 算拖拽，否则算点击打开。
   *
   * 与编辑器手柄同一套判据，也同一个理由——**用 pointer 事件而不是 HTML5 拖放**：
   * `dragstart` 那一套在真机验证里根本触发不了（CDP 只能发普通鼠标事件），
   * 验证不了的交互不该上生产。
   */
  const onRowDown = (e: ReactPointerEvent, 被拖: 拖行) => {
    if (e.button !== 0 || searching || !e.isPrimary) return; // 搜索态是平铺命中，没有层级可拖
    const 手 = e.pointerId;
    const 起 = { x: e.clientX, y: e.clientY };
    let 动过 = false;
    const 收 = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", 取消);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== 手) return;
      if (!动过) {
        if (Math.abs(ev.clientY - 起.y) < 5 && Math.abs(ev.clientX - 起.x) < 5) return;
        动过 = true;
      }
      设拖(落点在此刻(被拖, ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== 手) return;
      收();
      const 当前 = dragRef.current;
      设拖(null);
      if (!动过) return;
      刚拖过的行.current = { 键: 被拖.键, 刻: performance.now() };
      /**
       * 走 ref 拿**当下**那份 `落子`。按下到松手之间列表可能已经刷过一轮（索引事件、折叠、
       * 上一次落子的乐观更新），用按下那一刻的闭包就是拿旧树、旧顺序算整层序列——
       * 连着拖两次时，第一次刚写下去的序会被第二次用旧快照算出来的那份盖掉。
       */
      if (当前?.落) void 落子用.current(被拖, 当前.落);
    };
    /**
     * 触摸与笔会被浏览器抢去滚动（`nav` 是 `overflow-y-auto` 且没写 `touch-action`），
     * 那种手势只有 `pointercancel`、没有 `pointerup`。不接就等于拖拽粘住：指示线跟着手指跑，
     * 而下一次按下会再挂一对监听——一次手势落两次子、搬两次文件。编辑器那边同一套判据。
     */
    const 取消 = (ev: PointerEvent) => {
      if (ev.pointerId !== 手) return;
      收();
      设拖(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", 取消);
  };

  /** 落子。跨层那一跳先移动文件再改顺序：顺序里不该出现盘上还没有的路径 */
  const 落子 = async (被拖: 拖行, 落: 落点) => {
    const 作 = 算动作(被拖, 落, (父) => ({
      序列: 层内名字(tree, 父),
      存过: order.some((条) => 条.parent === 父),
    }));
    if (!作) return;
    const 层们 = 作.类型 === "移动" ? 作.层 : [作.层];
    if (作.类型 === "移动") {
      /**
       * 拖的正是眼前这篇、而且手上还有没落盘的改动：**先存回原路径再搬**。
       * 自动保存的定时器揣着旧 rel，移动之后它一触发就在原目录又写出一份——磁盘上没这个
       * 文件时后端是放行的（`save_note_write`：新建的文件没有旧版本可比对），于是一份笔记
       * 变两份、内容还不一样。顺带把待触发的定时器撤掉，别让它在 await 期间抢一次。
       */
      if (selected?.rel === 被拖.自身) {
        if (dirty && !(await persist())) {
          setFlash("这篇还没存下来——先处理冲突提示");
          return;
        }
        if (saveTimer.current !== null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
      }
      try {
        await api.noteMove(被拖.自身, 作.新路径);
      } catch (err) {
        setError(describeError(err).message);
        return;
      }
      revealPath(作.新路径); // 拖进折叠着的目录，就得让它当场露出来
      /**
       * 编辑器仍指着**旧路径**，得跟着搬过去：侧栏「归档」那个按钮走的就是
       * `afterChange(新路径)`，拖拽要同一处理，不然接着打的字还是往旧 rel 上写。
       */
      if (selected?.rel === 被拖.自身) await afterChange(作.新路径);
    }
    // 先按新序重画再写盘：G7 要"任何动作 100ms 内有反馈"，而落盘是另一趟往返
    setOrder((旧) => 合并层(旧, 层们));
    try {
      await api.treeOrderSave(层们);
    } catch (err) {
      setError(describeError(err).message);
      // 没写进去就别让界面停在盘上没有的那个顺序上：从盘上读回来
      void api
        .treeOrder()
        .then(setOrder)
        .catch(() => setOrder([]));
    }
  };
  /** 每渲染同步一次，让 `up` 拿到的是读着最新 tree / order / selected / dirty 的那一份 */
  const 落子用 = useRef(落子);
  useEffect(() => {
    落子用.current = 落子;
  });

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
    if (!selected) return true;
    if (md === savedDraft) {
      /**
       * 要写的字节与盘上那份一模一样 = **没有东西要存**，把状态归零。不归零就出不来：
       * `dirty` 判的是 `inlineRev > 0 || draft !== savedDraft`，走到这条分支说明只剩
       * `inlineRev` 在响，而它清不掉。真测过两例——文末的代码块按 `↓` 会补一个**不落盘**的
       * 空段落、纯光标移动会被账本守卫改一下邻居块的属性，两例字节都没变。
       * 卡住的不只是角标：`unsaved` 还挡着外部改动重载（Obsidian / 同步盘改这篇永远看不见）。
       */
      setInlineRev(0);
      setSaveState("clean");
      return true;
    }
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

  // "已自动保存"是一次性反馈，不是常驻状态：1.5s 后回 clean，右下角那条提示自己走
  useEffect(() => {
    if (saveState !== "saved") return;
    const t = window.setTimeout(() => setSaveState("clean"), 1500);
    return () => window.clearTimeout(t);
  }, [saveState]);

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
    loadLinks(rel);
  };

  const openNote = async (rel: string, title?: string) => {
    if (editing && !(await persist())) {
      setFlash("这篇还没存下来——先处理冲突提示");
      return;
    }
    // 打开即编辑：不再有"先看着，要改再按编辑"这一步
    setMode("inline");
    revealPath(rel);
    setFlash(null);
    try {
      await loadNote(rel, title);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  /** 关掉面板回正文：开着笔记就回到可编辑，没开才是空态 */
  const backToNote = () => setMode(selected ? "inline" : "view");

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
      backToNote();
      return;
    }
    try {
      const newRel = await api.noteRename(selected.rel, next);
      backToNote();
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

  const createNote = async (标题?: string) => {
    const title = (标题 ?? newTitle).trim();
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
      backToNote();
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
      backToNote();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBackupBusy(false);
    }
  };

  /**
   * 正文区的两个键。Esc **不再"退出编辑"**——现在没有编辑态可退出（打开就是可编辑的），
   * 把它做成"从源码框回到所见即所得"才是这个键在这里的含义。
   */
  const bodyKeys = <T extends HTMLElement>(e: ReactKeyboardEvent<T>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void persist();
    } else if (e.key === "Escape" && mode === "source") {
      e.preventDefault();
      void switchSurface();
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

  /**
   * 命令面板。`Ctrl+K` 唤起（Cmd 一并认，Mac 用户也在）。
   *
   * 只放**不需要二次确认**的动作：改名 / 归档 / 删除在界面上都带着确认或冲突处理，
   * 把它们塞进"打字 + 回车"的入口等于绕过那道确认。
   *
   * 列表**开着面板才现搭**：300 篇笔记的数组每次渲染都建一遍的话，正文里每敲一个字
   * 都要白付一次（App 因 inlineRev 而重渲染）。
   */
  const [palette, setPalette] = useState(false);
  const 焦点回 = useRef<Element | null>(null);
  const closePalette = () => {
    setPalette(false);
    // 浮层关掉要回到开它之前的地方，否则键盘用户每开一次都得重新找光标
    (焦点回.current as HTMLElement | null)?.focus?.();
  };
  useEffect(() => {
    const on键 = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (palette) closePalette();
        else {
          焦点回.current = document.activeElement;
          setPalette(true);
        }
      }
    };
    window.addEventListener("keydown", on键);
    return () => window.removeEventListener("keydown", on键);
  }, [palette]);
  const 填回 = (v: AiView) => {
    setAiView(v);
    setAiForm({ baseUrl: v.baseUrl, chatModel: v.chatModel, embeddingModel: v.embeddingModel });
  };

  const openAsk = async () => {
    setMode("ask");
    try {
      const [v, 录] = await Promise.all([api.aiView(), api.aiRuns(8)]);
      setAiView(v);
      setAiForm({ baseUrl: v.baseUrl, chatModel: v.chatModel, embeddingModel: v.embeddingModel });
      setRuns(录);
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  const ai问 = async () => {
    const q = 问.trim();
    if (!q) return;
    set问busy(true);
    set答(null);
    try {
      set答(await api.aiAsk(q));
      setRuns(await api.aiRuns(8));
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      set问busy(false);
    }
  };

  const openAi = async () => {
    setMode("ai");
    try {
      填回(await api.aiView());
    } catch (e) {
      setError(describeError(e).message);
    }
  };

  /** 保存三格。探针读的是**盘上那份配置**，所以"测试连通"之前得先保存 */
  const ai保存 = async () => {
    setAiBusy("save");
    try {
      填回(await api.aiSaveConfig(aiForm.baseUrl, aiForm.chatModel, aiForm.embeddingModel));
      setAiReport(null);
      setAi测过(null);
      // 地址可能变了，上一份清单不再作数——留着它会让人照着过时的候选填
      setAi发现(null);
      setFlash("配置已存进这个库的 .note/config.toml");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setAiBusy(null);
    }
  };

  const ai存Key = async () => {
    setAiBusy("key");
    try {
      const 是存 = aiKey.trim().length > 0;
      填回(await api.aiSaveKey(aiKey));
      setAiKey("");
      setAiReport(null);
      setAi测过(null);
      setFlash(是存 ? "Key 已存进 Windows 凭据管理器" : "Key 已删掉");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setAiBusy(null);
    }
  };

  const ai测试 = async () => {
    setAiBusy("test");
    try {
      const 报 = await api.aiTest();
      setAiReport(报);
      setAi测过(报.ok);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setAiBusy(null);
    }
  };

  /**
   * 问端点要一份模型清单，替用户把嵌入模型那一格填上。**读的是盘上那份地址**，
   * 所以和"测试连通"一样要先保存——这一条不藏，界面上写明。
   */
  const ai发现模型 = async () => {
    setAiBusy("models");
    try {
      setAi发现(await api.aiDiscover());
    } catch (e) {
      setAi发现(null);
      setError(describeError(e).message);
    } finally {
      setAiBusy(null);
    }
  };

  const 面板项 = (): PaletteItem[] => {
    const 动作: PaletteItem[] = [
      { id: "a-refresh", group: "动作", label: "重新读取索引与列表", run: () => void refresh() },
      { id: "a-trash", group: "动作", label: "打开回收站", run: () => void openTrash() },
      { id: "a-import", group: "动作", label: "导入外部 Markdown", run: () => void openImport() },
      { id: "a-backup", group: "动作", label: "打开备份面板", run: () => void openBackup() },
      { id: "a-ai", group: "动作", label: "接入模型（AI 设置）", run: () => void openAi() },
      { id: "a-ask", group: "动作", label: "问 AI（带引用）", run: () => void openAsk() },
      { id: "a-t1", group: "动作", label: "主题：跟随系统", run: () => setTheme("system") },
      { id: "a-t2", group: "动作", label: "主题：亮色", run: () => setTheme("light") },
      { id: "a-t3", group: "动作", label: "主题：暗色", run: () => setTheme("dark") },
    ];
    if (selected) {
      动作.unshift({
        id: "a-surface",
        group: "动作",
        label: mode === "source" ? "回到正文编辑" : "看这篇的源文本",
        hint: mode === "source" ? "Esc" : undefined,
        run: () => void switchSurface(),
      });
    }
    return [
      ...动作,
      ...list.map((n) => ({
        id: "n:" + n.rel,
        group: "笔记",
        label: n.title || stemOf(n.rel),
        hint: n.rel,
        run: () => void openNote(n.rel, n.title),
      })),
    ];
  };

  return (
    <div className="flex h-full flex-col bg-page text-fg">
      {palette ? (
        <CommandPalette
          标题="命令面板"
          items={面板项()}
          新建={(t) => void createNote(t)}
          onClose={closePalette}
        />
      ) : null}
      <header className="titlebar surface" data-tauri-drag-region>
        <span className="px-2 text-xs text-fg-2">知更 {info?.version}</span>
        <span className="title" data-tauri-drag-region>
          {info?.vaultPath ?? ""}
        </span>
        <label className="flex items-center gap-1 px-2 text-xs">
          <span>主题</span>
          <select
            className="rounded-md border border-line bg-raised px-2 py-1 text-xs"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            <option value="system">跟随系统</option>
            <option value="light">亮色</option>
            <option value="dark">暗色</option>
          </select>
        </label>
        <button className="win-btn" onClick={() => void refresh()} title="重新读取索引与列表">
          {busy ? "…" : <RotateCw aria-hidden="true" />}
        </button>
        {win ? (
          <>
            <button className="win-btn" onClick={() => void win.minimize()} title="最小化">
              <Minus aria-hidden="true" />
            </button>
            <button
              className="win-btn"
              onClick={() => void win.toggleMaximize()}
              title="最大化 / 还原"
            >
              <Square aria-hidden="true" />
            </button>
            <button className="win-btn close" onClick={() => void win.close()} title="关闭">
              <X aria-hidden="true" />
            </button>
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
                className="min-w-0 flex-1 rounded-md border border-line bg-page px-2 py-1 text-sm focus-visible:border-accent"
                placeholder="搜索笔记（全文）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className={btn + " grid place-items-center"}
                title="新建笔记"
                onClick={() => setCreating((c) => !c)}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            {creating ? (
              <div className="px-2 pb-2">
                <input
                  autoFocus
                  className="w-full rounded-md border border-accent bg-page px-2 py-1 text-sm"
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
            <nav ref={navRef} className="relative min-h-0 flex-1 overflow-y-auto pb-4">
              {/* 落位线。必须 pointer-events:none，否则它会吃掉 elementFromPoint，
                  指针一压到线上就量不到真正的行 */}
              {drag?.线顶 != null ? (
                <div className="tree-drop" style={{ top: drag.线顶 }} aria-hidden="true" />
              ) : null}
              {(searching ? rows : sidebarRows).length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-fg-disabled">
                  {searching ? "没有匹配的笔记" : notes ? "这个 Vault 还没有笔记" : "加载中"}
                </div>
              ) : null}
              {searching
                ? rows.map((n) => {
                    const active = selected?.rel === n.rel;
                    return (
                      <button
                        key={n.rel}
                        onClick={() => void openNote(n.rel, n.title)}
                        className={
                          "block w-full px-3 py-1 text-left text-sm transition-colors duration-(--dur-1) " +
                          (active ? "bg-accent-soft text-fg" : "hover:bg-hover")
                        }
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate">{n.title}</span>
                          <span className="shrink-0 font-mono text-xs text-fg-2">
                            {relativeTime(n.ms)}
                          </span>
                        </span>
                        <span className="block truncate font-mono text-xs text-fg-disabled">
                          {n.sub}
                        </span>
                      </button>
                    );
                  })
                : sidebarRows.map((b) => {
                    // 缩进走 token 而不是写死像素或 rem：[06] 定的是一级 16px，那个 16px
                    // 就是 --space-4；起手的 12px 同样取 --space-3，不押"根字号一定是 16px"
                    const pad = {
                      paddingInlineStart: `calc(var(--space-3) + ${b.depth} * var(--space-4))`,
                    };
                    if (b.kind === "dir") {
                      const folded = collapsed.has(b.path);
                      const 信 = 行信息(b);
                      const 落 = drag?.落;
                      const 移入 = !!落 && 落.kind === "into" && 落.目录 === b.path;
                      return (
                        <button
                          key={信.键}
                          onClick={() => {
                            if (刚拖过(信.键)) return;
                            toggleDir(b.path);
                          }}
                          onPointerDown={(e) => onRowDown(e, 信)}
                          data-tree-key={信.键}
                          data-tree-parent={信.父}
                          data-tree-name={信.名}
                          data-tree-dir="1"
                          data-tree-self={信.自身}
                          aria-expanded={!folded}
                          style={pad}
                          className={
                            "flex w-full cursor-grab items-baseline gap-1 px-3 py-1 text-left text-sm text-fg-2 transition-colors duration-(--dur-1) hover:bg-hover" +
                            (移入 ? " tree-into" : "")
                          }
                        >
                          <span className="flex w-3 shrink-0 items-center text-xs text-fg-disabled">
                            {folded ? (
                              <ChevronRight aria-hidden="true" />
                            ) : (
                              <ChevronDown aria-hidden="true" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          <span className="shrink-0 font-mono text-xs text-fg-2">
                            {b.notes}
                          </span>
                        </button>
                      );
                    }
                    const active = selected?.rel === b.rel;
                    const 信 = 行信息(b);
                    return (
                      <button
                        key={信.键}
                        onClick={() => {
                          if (刚拖过(信.键)) return;
                          void openNote(b.rel, b.title);
                        }}
                        onPointerDown={(e) => onRowDown(e, 信)}
                        data-tree-key={信.键}
                        data-tree-parent={信.父}
                        data-tree-name={信.名}
                        data-tree-dir="0"
                        data-tree-self={信.自身}
                        style={pad}
                        className={
                          "flex w-full cursor-grab items-baseline gap-1 px-3 py-1 text-left text-sm transition-colors duration-(--dur-1) " +
                          (active ? "bg-accent-soft text-fg" : "hover:bg-hover")
                        }
                      >
                        {/* 与目录行的箭头占同一格，标题才对得齐 */}
                        <span className="w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{b.title}</span>
                        <span className="shrink-0 font-mono text-xs text-fg-2">
                          {relativeTime(b.ms)}
                        </span>
                      </button>
                    );
                  })}
              {/*
                混合检索那一路（关键词 + 链接；配了嵌入模型再加语义）。四条口径：
                1. **单独一块，不混进上面那张表**——上面是 BM25 名次，这里是 RRF 名次，
                   混排会让人以为一把尺子量出来的；
                2. **按篇去重**：一个切片命中就把整篇列一次，同篇再来一个切片不占第二行；
                3. 失败说失败、没开说没开。"配了但连不上"要把错误原文摆出来——
                   那是"试过了"，不是"没这功能"；
                4. 右上角那句话由 `走了哪几路` 拼出来，不写死。这一整块以前被 `ai就绪`
                   挡着、叫「语义补充」，而链接那一路是纯本地的——不配 Key 也该看得见。
              */}
              {searching ? (
                <div className="mt-2 border-t border-line pt-1">
                  <div className="flex items-baseline justify-between px-3">
                    <span className="text-xs text-fg-2">{面板标题}</span>
                    <span className="text-xs text-fg-disabled">
                      {semErr
                        ? "这一路失败"
                        : semBusy
                          ? "检索中…"
                          : sem
                            ? 走了哪几路(sem.semantic, sem.graph)
                            : ""}
                    </span>
                  </div>
                  {semErr ? (
                    <div className="px-3 py-1 text-xs text-danger">{semErr}</div>
                  ) : null}
                  {sem && !semErr
                    ? (() => {
                        const 新篇: HybridHit[] = [];
                        const 见 = new Set(rows.map((r) => r.rel));
                        for (const h of sem.hits) {
                          if (见.has(h.path)) continue;
                          见.add(h.path);
                          新篇.push(h);
                        }
                        if (!新篇.length) {
                          return (
                            <div className="px-3 py-1 text-xs text-fg-disabled">
                              {sem.hits.length
                                ? "没有关键词之外的篇。"
                                : "这一路没给出任何候选。"}
                            </div>
                          );
                        }
                        return 新篇.slice(0, 5).map((h) => (
                          <button
                            key={h.chunkId}
                            onClick={() => void openNote(h.path, h.title)}
                            className="block w-full px-3 py-1 text-left text-sm transition-colors duration-(--dur-1) hover:bg-hover"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="min-w-0 flex-1 truncate">{h.title}</span>
                              <span className="shrink-0 text-xs text-fg-2">
                                {来源徽章(h.from)}
                              </span>
                            </span>
                            <span className="block truncate text-xs text-fg-2">
                              {h.headerPath ? h.headerPath + " › " : ""}
                              {h.snippet}
                            </span>
                          </button>
                        ));
                      })()
                    : null}
                  {sem?.hint ? (
                    <div className="px-3 py-1 text-xs text-fg-disabled">{sem.hint}</div>
                  ) : null}
                </div>
              ) : null}
              {/* 侧栏只吃 listNotes(300)。不说的话，目录树上那个篇数就是在少报——
                  树把"少了多少"藏进了某个折叠目录，比平铺列表更需要这句提示 */}
              {!searching && notes?.truncated ? (
                <div className="px-3 py-2 text-xs text-fg-disabled">
                  只列出了最近 {notes.notes.length} 篇（库里共 {notes.indexed} 篇）。
                  要找别的，直接在上面搜。
                </div>
              ) : null}
            </nav>
            {/* flex + gap：这一排以前是裸的 inline-block，JSX 换行的空白被 React 丢掉，
                五枚按钮之间实测 **0 间距**（边框两两贴合）。挂上徽标就换行，而换行后
                行间距同样是 0——两排方框粘成一张格子。 */}
            <div className="flex flex-wrap gap-1 border-t border-line p-2">
              <button
                className={btnOn(mode === "trash")}
                onClick={() => void (mode === "trash" ? backToNote() : openTrash())}
              >
                回收站
              </button>
              <button
                className={btnOn(mode === "import")}
                onClick={() => void (mode === "import" ? backToNote() : openImport())}
              >
                导入
              </button>
              {/* 没备份是产品最坏的状态（docs/03：唯一副本 = 没有副本），入口上要看得见 */}
              <button
                className={btnOn(mode === "backup")}
                onClick={() => void (mode === "backup" ? backToNote() : openBackup())}
              >
                备份
                {info && (info.backupUnconfigured || info.backupDisabled) ? (
                  <span className="ml-1 text-danger">· 没开</span>
                ) : null}
              </button>
              {/* AI 那一档的入口。角标只说"配齐没有 + 这次测过没有"，不吹成"能用了" */}
              <button
                className={btnOn(mode === "ai")}
                onClick={() => void (mode === "ai" ? backToNote() : openAi())}
              >
                AI
                {aiView && 徽标(aiForm, ai测过) ? (
                  <span
                    className={"ml-1 " + (徽标红(ai测过) ? "text-danger" : "text-fg-2")}
                  >
                    · {徽标(aiForm, ai测过)}
                  </span>
                ) : null}
              </button>
              <button
                className={btnOn(mode === "ask")}
                onClick={() => void (mode === "ask" ? backToNote() : openAsk())}
              >
                问答
              </button>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            {mode === "import" ? (
              <div className="measure-ui px-6 py-8">
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
                    className="min-w-64 flex-1 rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg"
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
                          className="flex items-baseline gap-3 rounded-md border border-line px-3 py-1 text-xs"
                        >
                          <span className="w-14 shrink-0 text-fg-2">
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
              <div className="measure-ui px-6 py-8">
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
                    className="min-w-64 flex-1 rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg"
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
                          <span className="shrink-0 text-xs text-fg-2">
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
                      <span className="shrink-0 text-xs text-fg-2">
                        {new Date(r.takenAt).toLocaleString()} · 增量 {r.copiedFiles} / 全库 {r.totalFiles}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : mode === "ai" ? (
              <div className="measure-ui px-6 py-8">
                <h2 className="text-xl text-fg">接入模型</h2>
                <p className="mt-2 text-sm text-fg-2">
                  填一个 <span className="font-mono text-mono">OpenAI 兼容</span>{" "}
                  端点就行：OpenAI、DeepSeek、Kimi、通义，或本机的 Ollama（
                  <span className="font-mono text-mono">http://localhost:11434/v1</span>
                  ）都走这一套。地址一般填到 <span className="font-mono text-mono">/v1</span>{" "}
                  为止。
                </p>
                <p className="mt-2 text-sm text-fg-2">
                  <span className="text-fg">Key 存在 Windows 凭据管理器里</span>
                  ：不落盘、不进这个库、也不回到界面脚本里，所以下面只显示末 4 位。换一台电脑要重输一次
                  Key，笔记本身跟着库走。
                </p>
                <div className="mt-5 flex max-w-2xl flex-col gap-3">
                  {(
                    [
                      ["接口地址 base_url", "baseUrl", "https://api.openai.com/v1"],
                      ["对话模型 chat_model", "chatModel", "gpt-4o-mini"],
                      ["嵌入模型 embedding_model（可留空）", "embeddingModel", "text-embedding-3-small"],
                    ] as const
                  ).map(([标签, 键, 占位]) => (
                    <label key={键} className="flex flex-col gap-1">
                      <span className="text-xs text-fg-2">{标签}</span>
                      <input
                        className="rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg"
                        value={aiForm[键]}
                        spellCheck={false}
                        placeholder={占位}
                        onChange={(e) => setAiForm({ ...aiForm, [键]: e.target.value })}
                      />
                    </label>
                  ))}
                  <label className="mt-1 flex flex-col gap-1">
                    <span className="text-xs text-fg-2">
                      API Key
                      {aiView?.keyHint ? (
                        <span className="ml-2 font-mono text-mono text-fg-2">
                          现在：{aiView.keyHint}
                        </span>
                      ) : (
                        <span className="ml-2 text-fg-disabled">
                          没填（本地模型不需要；云端多半会回 401）
                        </span>
                      )}
                    </span>
                    <div className="flex gap-2">
                      <input
                        className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg"
                        value={aiKey}
                        type="password"
                        spellCheck={false}
                        placeholder={aiView?.keySet ? "留空并按「存 Key」= 删掉这把" : "sk-…"}
                        onChange={(e) => setAiKey(e.target.value)}
                      />
                      <button
                        className={btn}
                        disabled={aiBusy !== null || !aiKey.trim()}
                        onClick={() => void ai存Key()}
                      >
                        存 Key
                      </button>
                    </div>
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      className={btnPrimary}
                      disabled={aiBusy !== null}
                      onClick={() => void ai保存()}
                    >
                      {aiBusy === "save" ? "保存中…" : "保存配置"}
                    </button>
                    <button
                      className={btn}
                      disabled={aiBusy !== null || 缺项(aiForm).length > 0}
                      onClick={() => void ai测试()}
                    >
                      {aiBusy === "test" ? "测试中…" : "测试连通"}
                    </button>
                    <button
                      className={btn}
                      disabled={aiBusy !== null || !aiForm.baseUrl.trim()}
                      title="问这个端点要一份模型清单，把能当嵌入模型用的那些列出来。它只发一个 GET 请求，你的笔记一个字节都不出去。"
                      onClick={() => void ai发现模型()}
                    >
                      {aiBusy === "models" ? "问端点中…" : "看看这家有哪些模型"}
                    </button>
                    {缺项(aiForm).length > 0 ? (
                      <span className="text-xs text-fg-disabled">
                        还差：{缺项(aiForm).join(" / ")}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-fg-disabled">
                    嵌入模型那一格<strong className="text-fg-2">可以留空</strong>
                    ：DeepSeek、Anthropic 这类只有对话端点，Kimi 的嵌入要单独申请。留空不是
                    "没配好"，是语义那一路不开、检索只走关键词与链接——问答照旧能用（它靠的是
                    检索回来的片段）。这一格与"测试连通"读的都是
                    <strong className="text-fg-2">已经存进盘上的那份地址</strong>
                    ，改完先按「保存配置」。
                  </p>
                </div>
                {ai发现 ? (
                  <div className="mt-5 max-w-2xl rounded-md border border-line bg-raised px-4 py-3">
                    <div className="font-mono text-xs text-fg-2">
                      端点给了 {ai发现.all.length} 个模型｜{ai发现.ms}ms｜其中含
                      <span className="mx-1">embed</span>的 {ai发现.embedCandidates.length} 个
                    </div>
                    {ai发现.embedCandidates.length > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-fg-2">可以填进嵌入模型那一格：</span>
                        {ai发现.embedCandidates.map((m) => (
                          <button
                            key={m}
                            className={
                              "rounded-md border px-3 py-1 font-mono text-xs transition-colors duration-(--dur-1) " +
                              (aiForm.embeddingModel === m
                                ? "border-accent text-fg"
                                : "border-line text-fg-2 hover:bg-hover")
                            }
                            title="点一下就填进上面那一格（还要按「保存配置」才落盘）"
                            onClick={() => setAiForm({ ...aiForm, embeddingModel: m })}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-fg-2">
                        这一家<strong className="text-fg">没有</strong>名字里含
                        <span className="mx-1 font-mono">embed</span>
                        的模型，多半确实不提供嵌入接口。那就把上面那一格空着——
                        检索走关键词与链接，问答照旧。
                      </p>
                    )}
                    {ai发现.all.length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-fg-2">
                          它给的全部模型（{ai发现.all.length}）
                        </summary>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {ai发现.all.map((m) => (
                            <span key={m} className="font-mono text-xs text-fg-2">
                              {m}
                            </span>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {aiReport ? (
                  <div className="mt-7 flex max-w-2xl flex-col gap-1">
                    <h3 className="text-sm text-fg-2">
                      测试结果
                      <span
                        className={
                          "ml-2 text-xs " + (aiReport.ok ? "text-success" : "text-danger")
                        }
                      >
                        {探针结论(aiReport.ok, aiReport.steps)}
                      </span>
                    </h3>
                    {aiReport.steps.map((r, i) => (
                      <div
                        key={i}
                        className={
                          "rounded-md border px-3 py-2 text-sm " +
                          (r.ok ? "border-line" : "border-danger bg-danger-soft")
                        }
                      >
                        <span className="text-fg">{步骤名(r.stage)}</span>
                        <span className="ml-2 font-mono text-xs text-fg-2">
                          {r.ms}ms
                        </span>
                        <div className="mt-1 break-words text-xs text-fg-2">{r.detail}</div>
                      </div>
                    ))}
                    <p className="mt-1 text-xs text-fg-disabled">
                      每个启用的探针只发一个最小请求，内容是一段固定文本{" "}
                      <span className="font-mono text-mono">ping</span>
                      ，不会把任何笔记内容发出去。
                    </p>
                  </div>
                ) : null}
                <p className="mt-8 max-w-2xl text-sm text-fg-2">
                  配好之后左下角「问答」那一格就能问了（<span className="font-mono text-mono">Ctrl+K</span>{" "}
                  里也有）。整理建议、自动打标还没做——那是 M3 的活。
                </p>
              </div>
            ) : mode === "ask" ? (
              <div className="measure-ui px-6 py-8">
                <h2 className="text-xl text-fg">问 AI</h2>
                <p className="mt-2 max-w-2xl text-sm text-fg-2">
                  答案只从检索出来的片段里组装：<span className="text-fg">模型引用了没给过的编号，
                  这一条就不采信</span>；库里找不到依据时一次模型都不打，直接说没有。
                  送出去的是片段摘录，不是整篇笔记；隐私位与视图根本不进候选。
                </p>
                <div className="mt-4 flex max-w-2xl gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1 text-fg"
                    value={问}
                    placeholder="比如：备份为什么要放到第二个目录？"
                    onChange={(e) => set问(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !问busy) void ai问();
                    }}
                  />
                  <button
                    className={btnPrimary}
                    disabled={问busy || !问.trim() || !(aiView?.chatModel ?? "").trim()}
                    onClick={() => void ai问()}
                  >
                    {问busy ? "生成中…" : "问"}
                  </button>
                </div>
                {!(aiView?.chatModel ?? "").trim() ? (
                  <p className="mt-2 text-xs text-fg-disabled">
                    没填对话模型名，问不了。左下角「AI」那一格里填上——
                    检索那一路不受它影响。
                  </p>
                ) : null}
                {答 ? (
                  <div
                    className={
                      "mt-5 max-w-2xl rounded-md border px-4 py-3 " +
                      (答.insufficient ? "border-danger bg-danger-soft" : "border-line bg-raised")
                    }
                  >
                    <div className="font-mono text-xs text-fg-2">
                      {答.model}｜候选 {答.candidates}｜in {答.inTokens} / out {答.outTokens}
                      {"｜"}
                      {答.ms}ms
                      {答.retried ? "｜引用违规后重生成过一次" : ""}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-fg">{答.text}</p>
                    {答.citations.length ? (
                      <div className="mt-3 flex flex-col gap-1">
                        <span className="text-xs text-fg-2">
                          采信的依据 {答.citations.length} 条
                        </span>
                        {答.citations.map((c) => (
                          <button
                            key={c.label}
                            onClick={() => void openNote(c.path, c.title)}
                            className="block rounded-md border border-line px-3 py-1 text-left text-sm transition-colors duration-(--dur-1) hover:bg-hover focus-visible:border-accent"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="shrink-0 font-mono text-xs text-fg-2">
                                {c.label}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-fg">{c.crumb}</span>
                            </span>
                            <span className="mt-1 block truncate text-xs text-fg-2">
                              {c.snippet}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-fg-disabled">
                        {答.insufficient ? "没有可采信的引用。" : "回答里没带片段编号。"}
                      </p>
                    )}
                  </div>
                ) : null}
                <h3 className="mt-8 text-sm text-fg-2">
                  最近的生成
                  <span className="ml-1 font-mono text-xs text-fg-2">{runs.length}</span>
                </h3>
                <div className="mt-2 flex max-w-2xl flex-col gap-1">
                  {runs.length === 0 ? (
                    <div className="text-sm text-fg-disabled">还没有记录。</div>
                  ) : null}
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-baseline gap-3 rounded-md border border-line px-3 py-1 text-xs"
                    >
                      <span className={r.ok ? "text-fg" : "text-danger"}>
                        {r.ok ? "采纳" : "未采纳"}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
                        {r.model}｜引用 {r.cited.length}/{r.candidates}
                        {r.retried ? "｜重试过" : ""}
                        {r.semantic && r.graph ? "" : `｜${走了哪几路(r.semantic, r.graph)}`}
                      </span>
                      <span className="shrink-0 font-mono text-fg-2">
                        {r.inTokens + r.outTokens} tok · {new Date(r.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-6 max-w-2xl text-xs text-fg-disabled">
                  审计记的是这个库问过什么、引用了哪几块、多少 token——失败与未采纳的那几次也在。
                  token 数按回包原样记，对方不给就记 0，不猜。
                </p>
              </div>
            ) : mode === "trash" ? (
              <div className="measure-ui px-6 py-8">
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
                      <span className="shrink-0 font-mono text-xs text-fg-2">
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
                    <div className="mb-3 flex items-center gap-2 text-xs">
                      {mode === "rename" ? (
                        <>
                          <input
                            autoFocus
                            className="min-w-0 flex-1 rounded-md border border-accent bg-page px-2 py-1 text-sm"
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitRename();
                              else if (e.key === "Escape") backToNote();
                            }}
                          />
                          <button className={btnPrimary} onClick={() => void commitRename()}>
                            改名
                          </button>
                          <button className={btn} onClick={backToNote}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 shrink truncate font-mono text-fg-2">
                            {selected.rel}
                          </span>
                          {/* 没有"编辑/完成"了：打开就是可编辑的。管理动作压在右上角，
                              平时半透明，指针靠近或拿到键盘焦点才实——它们不是正文的一部分，
                              但也不该在用户写字时占住注意力。 */}
                          <span className="ml-auto flex shrink-0 items-center gap-1 opacity-90 transition-opacity duration-(--dur-1) hover:opacity-100 focus-within:opacity-100">
                            <button className={btn} onClick={() => void switchSurface()}>
                              {mode === "source" ? "所见即所得" : "源码"}
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
                            <button
                              className={btn + " text-danger"}
                              onClick={() => void trashNote()}
                            >
                              删除
                            </button>
                          </span>
                        </>
                      )}
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
                          onNotice={(文) => setFlash(文)}
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
                      // 装载中：既不给上一篇留着，也不闪一个空框——骨架意味着"路上有东西"。
                      // 尺寸照真实内容：一级标题 28px×1.3≈36px → h-9，正文行 23.25px → h-6，
                      // 段间距 1.15em≈17.8px → gap-4（[06] §3"骨架抖动=布局错误的信号"）
                      <div className="flex flex-col gap-4">
                        <div className="skeleton h-9 w-2/3" />
                        <div className="skeleton h-6 w-full" />
                        <div className="skeleton h-6 w-5/6" />
                      </div>
                    )}
                    {links && selected ? (
                      <LinkPanelView
                        panel={links}
                        onOpen={(rel, title) => void openNote(rel, title)}
                      />
                    ) : null}
                    {/* 保存状态挪到右下角，1.5 秒自己消失。它以前是顶栏上的一行常驻文字，
                        和"完成"按钮一起把"我在编辑"念个不停——现在打开就是可编辑的，
                        没改动就不写盘，状态只需要在**真的存了东西**时说一声。
                        冲突不走这里：那是要用户做决定的，用上面那条横幅。 */}
                    {saveState === "saving" || saveState === "saved" ? (
                      <div
                        className="pointer-events-none fixed right-5 bottom-5 z-(--z-toast) rounded-full border border-line bg-raised px-3 py-1 text-xs text-fg-2 shadow-2"
                        aria-live="polite"
                      >
                        {saveState === "saving" ? "保存中…" : "已自动保存"}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="flex flex-col items-start gap-4 text-fg-2">
                    <div className="text-lg">
                      {flash ? (
                        flash
                      ) : notes && notes.notes.length === 0 ? (
                        "还没有笔记。按 Alt+Shift+N 记一条，或者建一篇来写。"
                      ) : (
                        "选一篇笔记，或者从左边搜一个词。"
                      )}
                    </div>
                    {/* [06] §3：空态是"文案 + 一个主操作"，不是插画满屏。空态是最容易被
                        忘掉的界面——这里以前只有一句话，用户站在这儿不知道下一步按什么 */}
                    {info && !flash ? (
                      <button className={btnPrimary} onClick={() => setCreating(true)}>
                        新建一篇
                      </button>
                    ) : null}
                    {/* 骨架屏只在真的有东西在路上时出现：常驻骨架=在骗人。
                        高度对齐一行正文（15.5px × 1.5 = 23.25px → h-6），以前是 h-3=12px，
                        装载完内容一落到原位就是一次跳 */}
                    {!info ? (
                      <>
                        <div className="skeleton h-6 w-64" />
                        <div className="skeleton h-6 w-80" />
                        <div className="skeleton h-6 w-48" />
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
