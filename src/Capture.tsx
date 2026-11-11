import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import type { CapturedOut } from "./ipc/types";
import { 回执属于本笔, type 索引回执 } from "./ui/capture";
import { 是回车提交 } from "./ui/keys";
import { 套主题, 盯主题变化, 读主题 } from "./ui/theme";

type Phase = "idle" | "saving" | "saved" | "error";

/**
 * 刚落盘、还在等后台索引回执的那一篇。`rel` 在命令返回前是空串。
 *
 * 回执本身带 `rel`，所以"上一笔的回执"不会算到这一笔头上：`rel` 已知时严格按路径
 * 比；还不知道时先存进 `回执表`，等命令返回用 `res.rel` 认领。
 */
type 待索引 = {
  rel: string;
  /** 命令已经返回。用来判断"放开保存守卫"该由谁来收尾 */
  已返回: boolean;
};

/**
 * 速记窗专用索引事件。`note://indexed` 的空数组可能是任何窗口的失败，听了就会
 * 把别人的错算到刚存这一条头上；后端只在 `capture_text` 里发这个事件。
 */
const 索引事件 = "note://capture-indexed";

/**
 * 速记窗。整条交互就一个目标：**从想到到记下来不超过 3 秒，且任何时候都不卡**。
 * 因此这里刻意不做的事：不等索引完成才关窗（落盘返回即算成功）、不显示进度条、
 * 不做花哨入场动画（G7 只要求 100ms 内有反馈，这个窗口本身就是反馈）。
 */
export function Capture() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [saved, setSaved] = useState<CapturedOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const 待 = useRef<待索引 | null>(null);
  /** 回执可能比命令先到：按 rel 先存着，命令返回后用 `res.rel` 认领。每次提交清空 */
  const 回执表 = useRef(new Map<string, boolean>());
  /** 输入框此刻的内容。保存还没返回时用户可能接着敲，返回值不能拿旧 state 去清 */
  const 文字 = useRef("");
  /** 这一笔还在飞的时候用户又改了框里的字：返回后不清空、也不自动收起 */
  const 存后改过 = useRef(false);
  /**
   * 自动收起的定时器。**不放进 `待索引`**：成功回执一到 `待索引` 就被清空，
   * 而定时器还挂着——分开持有，用户这时接着打字才撤得掉它。
   */
  const 关窗 = useRef<number | null>(null);

  const 撤关窗 = useCallback(() => {
    if (关窗.current !== null) {
      window.clearTimeout(关窗.current);
      关窗.current = null;
    }
  }, []);

  useEffect(() => {
    // 窗口是复用的：收起再唤出时不会重新挂载，DOM 焦点得自己还回去
    ta.current?.focus();
    const 回焦 = () => ta.current?.focus();
    window.addEventListener("focus", 回焦);
    return () => window.removeEventListener("focus", 回焦);
  }, []);

  /**
   * 速记窗以前**从来没被问过主题**：主窗是暗的，它永远套浅色 token（用户原话
   * "为什么没有跟随系统颜色"）。这里跟着同一份偏好走；主窗改了会通过 `storage` 事件过来。
   */
  useEffect(() => 盯主题变化(() => 套主题(读主题())), []);

  const close = useCallback(() => {
    // 手动收起也要撤掉 450ms 的自动收起：窗口是复用的，不撤的话用户收起后
    // 马上再唤起，先前那枚定时器到点会把他正要写的第二条收走。
    撤关窗();
    void getCurrentWindow().hide();
  }, [撤关窗]);

  /**
   * 这篇没补上索引：撤掉还在计时的收起，把提醒留在状态行，并放开 `saved` 守卫。
   * 只放 `saved` 这一档——回执可能晚于收起，那时屏幕上已经是新的 idle / error，
   * 不能被一条旧回执改回 idle。
   */
  const 报索引失败 = useCallback(
    (记: 待索引) => {
      撤关窗();
      setNotice("已保存，但搜索还没更新，这条暂时搜不到。");
      if (记.已返回) setPhase((p) => (p === "saved" ? "idle" : p));
    },
    [撤关窗],
  );

  const submit = useCallback(async () => {
    // Enter 没有守卫的话，手快连按两下就会落两篇——按钮是禁用了，键盘路径也得禁。
    // 相应地 `phase` 必须在 useCallback 的依赖里，不然这里读到的是闭包里的旧值，守卫等于没加。
    if (phase === "saving" || phase === "saved") return;
    const body = text.trim();
    if (!body) {
      // 空内容不落盘，也不关窗——用户按回车多半是手滑
      setPhase("error");
      setErr("还没写内容");
      return;
    }
    setPhase("saving");
    setNotice(null);
    存后改过.current = false;
    // 上一笔的收起定时器若还挂着（窗口是复用的），现在必须撤掉：它到点会把
    // 这一笔正在保存的窗口收走，返回后的状态就没人接了。
    撤关窗();
    // 上一笔没认领的回执不再有意义：它属于上一次速记，不能算到这一笔头上
    回执表.current.clear();
    const 记: 待索引 = { rel: "", 已返回: false };
    待.current = 记;
    try {
      const { api } = await import("./ipc/commands");
      const res = await api.captureText(body);
      记.已返回 = true;
      记.rel = res.rel;
      // 回执可能比返回值先到：按 rel 取回那一笔。取不到就等它晚点来。
      const 回执 = 回执表.current.get(res.rel);
      回执表.current.delete(res.rel);
      setSaved(res);
      // 保存期间用户又写了字：那是下一条，不能清掉，也不能按"这一条已收"自动收起。
      // `文字` 是 ref——这时的 state 还停在提交那一刻。
      const 有后续 = 存后改过.current && 文字.current.trim().length > 0;
      if (!有后续) {
        setText("");
        文字.current = "";
      }
      if (回执 === false) {
        // 已经确认这篇没补上：不排自动收起，提醒留在状态行
        报索引失败(记);
        setPhase("idle");
      } else if (有后续) {
        // 已保存，但用户已经在写下一句：留在 idle 让他接着按 Enter
        setPhase("idle");
      } else {
        if (回执 === true) setNotice(null);
        setPhase("saved");
        // 450ms 足够看清"已存"，又不会让人觉得要被等。
        // **收起而不是销毁**：索引回执可能晚于这一下（后台那条连接被导入占着时尤其明显），
        // 销毁窗口会把监听器一起带走，晚到的"没补上"就永远说不出来。hide 之后 JS 还活着，
        // 回执照常落到状态里，下次唤出还能看见；`待` 也留着，别在这里清。
        关窗.current = window.setTimeout(() => {
          关窗.current = null;
          // 收起之后窗口还在（下次唤出是同一个实例）：把"已保存"这档清掉，
          // 下次打开看到的是默认提示或晚到的失败提醒，而不是上一次的旧状态。
          setPhase("idle");
          close();
        }, 450);
      }
    } catch (e) {
      撤关窗();
      待.current = null;
      回执表.current.clear();
      setNotice(null);
      setPhase("error");
      setErr(String(e));
    }
  }, [text, phase, 撤关窗, close, 报索引失败]);

  /**
   * 索引回执。负载是 `{ rel, ok }`：`ok=false` = 后台那一步失败。
   *
   * 带 `rel` 是为了分清"这一笔"和"上一笔还没落地的回执"——事件没有别的关联 id，
   * 只靠路径列表/空数组时只能猜，猜错就会把上一笔的失败报在这一条头上。
   *
   * 失败不自己好转（重启只在索引为空时才重建，不会重扫全库），所以不能静默：
   * 撤掉还没到点的收起，把那句话留在状态行上。窗口多半已经收起，但收起走的是 hide
   * 而不是销毁，监听器还活着——下次唤出仍看得见。直到这一篇真的补上索引、或者
   * 用户又存了一条才消失。
   */
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const f = await listen<索引回执>(索引事件, (ev) => {
        const 记 = 待.current;
        if (!记) return;
        const 回执 = ev.payload;
        // 上一笔的回执不能算到这一笔头上
        if (!回执属于本笔(记.rel, 回执.rel)) return;
        if (记.rel === "") {
          // 命令还没返回：先按 rel 存着，返回后按 res.rel 认领。
          // 现在报可能认错笔（上一笔的回执也会落进这个空档）。
          回执表.current.set(回执.rel, 回执.ok);
          return;
        }
        if (回执.ok) {
          待.current = null; // 这一篇已经可搜，后面的事件与它无关
          // 失败之后它又被补上了（比如用户在别处存了一次）：那句提醒不再成立
          setNotice(null);
          return;
        }
        报索引失败(记);
      });
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, [报索引失败]);

  const 状态 =
    phase === "error"
      ? { 色: "text-danger", 文: err ?? "保存失败" }
      : notice
        ? // `--warning` 作为 12px 正文只有 3.1:1，不过 AA；状态色留给圆点/图标，
          // 这句话按设置页同一口径用 danger（5.2:1），"已保存"这半句本身已经把状态说清
          { 色: "text-danger", 文: notice }
        : phase === "saved"
          ? // 文件路径是内容，不是占位符：docs/06 硬规定 2 点名它走次要色
            { 色: "text-fg-2", 文: `已保存 ${saved?.rel ?? ""}` }
          : { 色: "text-fg-disabled", 文: "Alt+Shift+N 随时唤起" };

  return (
    <div className="flex h-full flex-col bg-raised">
      <div
        className="flex h-8 shrink-0 items-center justify-between px-3 text-xs text-fg-2"
        data-tauri-drag-region
      >
        <span data-tauri-drag-region>速记 · 存到 inbox/</span>
        <button
          className="grid place-items-center rounded-sm px-1 hover:bg-hover"
          onClick={close}
          title="隐藏（Esc）"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <textarea
        ref={ta}
        value={text}
        placeholder="想到什么就写什么，Enter 存，Shift+Enter 换行"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          文字.current = e.target.value;
          if (phase === "saving") {
            // 这一笔还没落地：新字不能丢，返回后也不能自动收起
            存后改过.current = true;
          } else if (phase === "saved") {
            // 存完之后用户又接着写：这一窗不该再自动关（到点会把他刚打的带走）。
            // 只撤定时器，**不撤待确认**——这一篇的回执可能还没到，失败提醒不能因为
            // 又开始写下一句就丢掉。守卫放开，下一次 submit 会换上新的记录。
            撤关窗();
            setPhase("idle");
          } else if (phase === "error") {
            // 空内容按过回车的红字：接着写就把它收掉
            setPhase("idle");
          }
        }}
        onKeyDown={(e) => {
          if (是回车提交(e) && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="min-h-0 flex-1 resize-none bg-raised px-4 pt-2 pb-2 font-ui text-base text-fg placeholder:text-fg-disabled"
      />

      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-xs">
        <span className={状态.色}>{状态.文}</span>
        <button
          className="rounded-sm border border-line px-2 py-1 hover:bg-hover disabled:opacity-55"
          disabled={phase === "saving" || !text.trim()}
          onClick={() => void submit()}
        >
          {phase === "saving" ? "保存中…" : "保存 (Enter)"}
        </button>
      </div>
    </div>
  );
}
