import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AssetOut,
  CapturedOut,
  EditDoc,
  HybridResult,
  ImportEntry,
  ImportReport,
  ListNotes,
  LinkPanel,
  NoteSource,
  SiblingOrder,
  SnapshotRow,
  AiProbeReport,
  AiView,
  TrashRow,
} from "./types";

/**
 * 写命令失败时给的是结构化负载 `{kind, message}`（冲突要能分支出来），
 * 其余命令还是裸字符串。两种都从这里过一遍，别在调用点匹配文案。
 */
export function describeError(e: unknown): { kind: string; message: string } {
  if (e && typeof e === "object" && "kind" in e) {
    const o = e as { kind?: unknown; message?: unknown };
    return { kind: String(o.kind ?? "error"), message: String(o.message ?? "") };
  }
  return { kind: "error", message: String(e) };
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * 所有跨边界调用都收在这里。返回值类型与 Rust 侧 `ipc.rs` 的 DTO 一一对应——
 * M1 会换成 ts-rs 自动生成，届时删掉手写声明（docs/03 §IPC 契约：禁止前端手写接口类型）。
 */
export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listNotes: (limit = 200) => invoke<ListNotes>("list_notes", { limit }),
  vaultOpen: (path: string) => invoke<AppInfo>("vault_open", { path }),
  /** 默认 Vault 路径由 Rust 侧算：哪块盘可用来决定，前端猜不出来 */
  vaultDefaultPath: () => invoke<string>("vault_default_path"),
  /** 只等落盘（含 fsync，实测 p95 5.9ms）。索引在 Rust 侧后台补，别等它 */
  captureText: (text: string, sourceUrl?: string) =>
    invoke<CapturedOut>("capture_text", { text, sourceUrl: sourceUrl ?? null }),
  searchKeyword: (query: string, limit = 20) =>
    invoke<{ blockId: string; noteId: string; path: string; title: string; snippet: string; score: number }[]>(
      "search_keyword",
      { query, limit }
    ),
  /** 行内编辑器要的块结构：每块带精确源切片，未改动的块由前端原样回写 */
  noteEditDoc: (rel: string) => invoke<EditDoc>("note_edit_doc", { rel }),
  /** 反链面板：一篇的入链与出链（含悬空的，带原始写法） */
  noteLinks: (rel: string, limit = 40) => invoke<LinkPanel>("note_links", { rel, limit }),
  /** 原文 + hash。hash 要原样带回 saveNote，服务端才判得出"磁盘这份还是不是你看到的那份" */
  readRaw: (rel: string) => invoke<NoteSource>("read_raw", { rel }),
  saveNote: (rel: string, content: string, expectHash?: string) =>
    invoke<string>("save_note", { rel, content, expectHash: expectHash ?? null }),
  /** 返回新建笔记的相对路径 */
  noteCreate: (title: string) => invoke<string>("note_create", { title }),
  /**
   * 把剪贴板来的图片字节存进 `attachments/`，拿回内容寻址路径。
   *
   * 第二参数直接给 `Uint8Array`：Tauri 会把整个负载当 **raw body** 送过去，
   * 而不是 JSON。一张 2MB 的截图用 JSON 传要么 base64 膨胀到 2.7MB，要么十进制数组
   * 膨胀到 8MB 以上，而这条调用就压在"按下 Ctrl+V"那一刻。扩展名与 mime 由 Rust
   * 从字节本身判（剪贴板给的文件名永远是 `image.png`，没有信息量）。
   */
  attachmentSave: (bytes: Uint8Array) => invoke<AssetOut>("attachment_save", bytes),
  noteRename: (rel: string, newStem: string) =>
    invoke<string>("note_rename", { rel, newStem }),
  noteMove: (rel: string, newRel: string) => invoke<void>("note_move", { rel, newRel }),
  /**
   * 侧栏自定义顺序。读的是 `.note/tree.toml` 而不是索引，所以库里一篇没有也返回空表。
   * 保存交的是**整层的全序列**（一次拖拽最多涉及两层），不碰 SQLite、不触发重索引。
   */
  treeOrder: () => invoke<SiblingOrder[]>("tree_order"),
  treeOrderSave: (orders: SiblingOrder[]) => invoke<void>("tree_order_save", { orders }),
  noteTrash: (rel: string) => invoke<void>("note_trash", { rel }),
  listTrash: () => invoke<TrashRow[]>("list_trash"),
  noteRestore: (batch: string, rel: string) =>
    invoke<void>("note_restore", { batch, rel }),
  /** 备份：设目录（path=null + disabled=true 是"我不备份"），返回新的 app_info */
  backupSet: (path: string | null, disabled: boolean) =>
    invoke<AppInfo>("backup_set", { path, disabled }),
  backupRun: () => invoke<SnapshotRow | null>("backup_run"),
  backupRecent: (limit = 10) => invoke<SnapshotRow[]>("backup_recent", { limit }),
  backupHistory: (rel: string) => invoke<SnapshotRow[]>("backup_history", { rel }),
  /** 恢复只等落盘，索引照旧在后台补；被覆盖的那份会先进 .note/conflicts/ */
  backupRestore: (rel: string, id: string) => invoke<string>("backup_restore", { rel, id }),
  /** 导入：预览只算计划，apply 才写盘并逐篇索引（走第二条连接，不挡读） */
  importPreview: (src: string) => invoke<ImportEntry[]>("import_preview", { src }),
  importApply: (src: string) => invoke<ImportReport>("import_apply", { src }),
  /**
   * AI 档 0。**三条命令都返回同一份视图 `AiView`，里面没有 Key**——明文一旦回到 WebView
   * 就再也收不回来（任意页面脚本可读），所以界面上只能显示末 4 位（docs/03 §后端调用纪律）。
   */
  aiView: () => invoke<AiView>("ai_view"),
  /**
   * 参数名走 camelCase：Tauri 的 derive 把 Rust 侧的 `base_url` 认成 JS 侧的 `baseUrl`，
   * 传下划线会直接报 `missing required key baseUrl`（真机照出来的，不是猜的）。
   * 空串 = 清空这一项。地址与模型名的裁剪、`/` 收尾都在 Rust 侧一份判据里做。
   */
  aiSaveConfig: (baseUrl: string, chatModel: string, embeddingModel: string) =>
    invoke<AiView>("ai_save_config", { baseUrl, chatModel, embeddingModel }),
  /** 空串 = 删掉这把 Key */
  aiSaveKey: (key: string) => invoke<AiView>("ai_save_key", { key }),
  /** 两个最小探针请求。发出去的是固定文本 "ping"，不含任何笔记内容 */
  aiTest: () => invoke<AiProbeReport>("ai_test"),
  /**
   * 混合检索（关键词 + 语义）。**含一次网络往返**，所以它是异步的补充结果：
   * 侧栏那条关键词搜索照旧走 8ms 同步通路，这一路晚一点到就晚一点到。
   */
  searchHybrid: (query: string) => invoke<HybridResult>("search_hybrid", { query }),
};

/**
 * 当前 Vault 的绝对路径。图片块要把它拼成 `asset:` URL 才能显示，而它是**会话状态**
 * （用户可以换库），不属于任何一个节点，所以存在这里而不是塞进节点 attrs——
 * attrs 会被复制、会被存进 JSON，一个绝对路径躺在里面就是"换台机器图就坏了"。
 */
let 库根 = "";

/** 由界面层在拿到 app_info / 换库之后调用。空串代表"还没选库"，读取处自己退化。 */
export function 设库根(路径: string | null): void {
  库根 = 路径 ?? "";
}

/**
 * Vault 根相对的资产路径 → `<img>` 能用的地址。
 *
 * 三条退化都是**故意的**：不在 Tauri 里（测试）、还没选库、或目标根本不是库内资产，
 * 一律给空串，让调用方走"显示文件名"的兜底，而不是画一个注定 404 的 `<img>`。
 *
 * 分隔符跟着库根走：这个产品只有 Windows（docs/01），Rust 侧 `display()` 给的是
 * `D:\Notes`，而正文里的引用按 docs/02 永远写 `/`。两边强行拼在一起没问题，
 * 但让 scope 的 glob 去匹配混合分隔符是给自己找事，所以统一成库根自己那一种。
 */
export function 资产地址(目标: string): string {
  if (!库根 || !inTauri()) return "";
  const 干 = 目标.replace(/^\/+/, "");
  const 用反斜杠 = 库根.includes("\\");
  const 绝 = 库根 + (用反斜杠 ? "\\" : "/") + (用反斜杠 ? 干.replace(/\//g, "\\") : 干);
  return convertFileSrc(绝);
}
