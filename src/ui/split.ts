/**
 * 文件树与正文之间那条分隔的纯判定，外加本机记忆。
 *
 * 拖动期间不进 React：App 每一拍重渲染都会把编辑器和底部对话一起画一遍。
 * 组件只在指针移动时改 `--split-w`，松手才把结果写进 state 与 localStorage。
 *
 * 折起只发生在左边。右边那一列是正文和对话，卸掉就会丢掉轮次与未发送草稿，
 * 所以这里没有「右栏折起」这一档——窄窗只是把左栏画窄，记忆里的宽度留着。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** 与原来的 `w-72` 同一档：18rem = 288px */
export const 默认宽 = 288;
/** 折起后留下的轨，放得下一枚展开按钮 */
export const 轨宽 = 32;
/** 松手时窄于这条就折起。再窄搜索框和两枚新建按钮就挤在一起 */
export const 折起线 = 160;
/** 右栏尽量留下的宽度。窗比这更窄时让步，不把整行撑出视口 */
export const 右栏下限 = 320;
/** 文件树再宽，长路径也够看了，剩下的留给正文 */
export const 左栏上限 = 480;
/** 从细轨往右拖过这么多才算要展开，避免手抖一下把树弹开 */
export const 展开死区 = 16;
/** 方向键一档，对齐 `--space-4` */
export const 步进 = 16;

const 键 = "note.split";

export type 分栏 = {
  /** 展开时的宽度。折起后仍留着，点轨或把分隔条拖回来用它 */
  宽: number;
  折起: boolean;
};

export type 分栏帧 = {
  /** 松手后要记住的状态 */
  状态: 分栏;
  /** 这一帧画出来的列宽。折起时是轨宽，不是 `状态.宽` */
  宽: number;
  折起: boolean;
};

export const 初始分栏: 分栏 = { 宽: 默认宽, 折起: false };

/** 记忆里的宽度只落在「还能展开」的区间。读到坏数就回默认 */
export function 夹记忆(宽: number): number {
  if (!Number.isFinite(宽)) return 默认宽;
  return Math.min(左栏上限, Math.max(折起线, Math.round(宽)));
}

/**
 * 这一刻左栏最多能画多宽。容器量不到（0 / 非数）时不夹，
 * 免得首帧把用户的宽度削掉。
 */
export function 显示上限(容器: number): number {
  if (!Number.isFinite(容器) || 容器 <= 0) return 左栏上限;
  return Math.max(0, Math.min(左栏上限, 容器 - 右栏下限));
}

/**
 * 由「按下时的状态 + 指针位移」得出这一帧。位移相对按下那一点，
 * 不相对上一帧——拖过折起线再拖回来，树会重新打开，而不是粘在轨上。
 */
export function 拖动帧(起点: 分栏, 位移: number, 容器: number): 分栏帧 {
  const 帽 = 显示上限(容器);
  if (起点.折起) {
    if (!(位移 >= 展开死区)) return { 状态: 起点, 宽: 轨宽, 折起: true };
    return 放开(起点.宽, 起点.宽 + (位移 - 展开死区), 帽);
  }
  const 目标 = 起点.宽 + 位移;
  if (目标 < 折起线) return { 状态: { 宽: 起点.宽, 折起: true }, 宽: 轨宽, 折起: true };
  return 放开(起点.宽, 目标, 帽);
}

export function 按键分栏(今: 分栏, 键: "左" | "右" | "复位", 容器: number): 分栏 {
  if (键 === "复位") return { 宽: 默认宽, 折起: false };
  if (今.折起) return 键 === "右" ? { 宽: 今.宽, 折起: false } : 今;
  const 帽 = 显示上限(容器);
  const 可见 = 帽 > 0 ? Math.min(今.宽, 帽) : 今.宽;
  const 目标 = 可见 + (键 === "左" ? -步进 : 步进);
  if (目标 < 折起线) return { 宽: 今.宽, 折起: true };
  if (!(帽 > 0)) return 今;
  return 放开(今.宽, 目标, 帽).状态;
}

/**
 * 打开着的那一档。窗比记忆窄时，分隔条已经顶在帽上：
 * 往更宽拖不能把记忆削成帽，往更窄拖到分隔条真的动了才记下新宽度。
 */
function 放开(记忆: number, 目标: number, 帽: number): 分栏帧 {
  const 想要 = 夹记忆(目标);
  if (!(帽 > 0)) return { 状态: { 宽: 记忆, 折起: false }, 宽: 0, 折起: false };
  const 画 = Math.min(想要, 帽);
  const 原先画 = Math.min(记忆, 帽);
  if (画 === 原先画 && 想要 >= 画) return { 状态: { 宽: 记忆, 折起: false }, 宽: 画, 折起: false };
  return { 状态: { 宽: 夹记忆(画), 折起: false }, 宽: 画, 折起: false };
}

export function 读分栏(): 分栏 {
  try {
    const 存 = localStorage.getItem(键);
    if (!存) return 初始分栏;
    const v = JSON.parse(存) as { w?: unknown; c?: unknown };
    if (typeof v?.w !== "number" || typeof v?.c !== "boolean") return 初始分栏;
    return { 宽: 夹记忆(v.w), 折起: v.c };
  } catch {
    return 初始分栏;
  }
}

export function 写分栏(v: 分栏): void {
  try {
    localStorage.setItem(键, JSON.stringify({ w: v.宽, c: v.折起 }));
  } catch {
    /* 存不下也要当场生效，重启回到默认宽度 */
  }
}

/** 别的窗口改了同一条偏好。本窗口自己写不会收到这个事件 */
export function 盯分栏变化(重算: () => void): () => void {
  const 串窗 = (e: StorageEvent) => {
    if (e.key === 键 || e.key === null) 重算();
  };
  window.addEventListener("storage", 串窗);
  return () => window.removeEventListener("storage", 串窗);
}

function 同(a: 分栏, b: 分栏): boolean {
  return a.宽 === b.宽 && a.折起 === b.折起;
}

function 画到(根: HTMLElement, 帧: 分栏帧) {
  根.style.setProperty("--split-w", `${帧.宽}px`);
  根.dataset.tree = 帧.折起 ? "closed" : "open";
}

/**
 * 主窗那一条分栏。拖动只改 DOM；松手、方向键、点轨才 `setState`。
 * 折起时若焦点还停在被藏起来的那一栏里，把它送到分隔条上——
 * `display: none` 里面的焦点，键盘用户出不来。
 */
export function use分栏() {
  const [分栏, set分栏] = useState(读分栏);
  const 分栏Ref = useRef(分栏);
  const 预览Ref = useRef<分栏帧 | null>(null);
  const 根Ref = useRef<HTMLDivElement>(null);
  const 分隔Ref = useRef<HTMLDivElement>(null);
  const 拖着 = useRef(false);
  const 焦点帧 = useRef<number | null>(null);
  /** 手势还没松手组件就卸了时，把监听拆掉，免得分隔条粘在拖动态 */
  const 卸手势 = useRef<(() => void) | null>(null);
  分栏Ref.current = 分栏;

  useEffect(() => {
    return 盯分栏变化(() => {
      if (拖着.current) return;
      const 下 = 读分栏();
      预览Ref.current = null;
      分栏Ref.current = 下;
      set分栏(下);
    });
  }, []);

  useEffect(
    () => () => {
      卸手势.current?.();
      if (焦点帧.current !== null) cancelAnimationFrame(焦点帧.current);
    },
    [],
  );

  const 活 = 预览Ref.current;
  const 折起 = 活 ? 活.折起 : 分栏.折起;
  const 列宽 = 活 ? 活.宽 : 分栏.折起 ? 轨宽 : 分栏.宽;

  const 焦点归位 = (下: 分栏) => {
    if (焦点帧.current !== null) cancelAnimationFrame(焦点帧.current);
    焦点帧.current = requestAnimationFrame(() => {
      焦点帧.current = null;
      const 根 = 根Ref.current;
      const 分隔 = 分隔Ref.current;
      if (!根 || !分隔) return;
      const 藏 = 下.折起
        ? 根.querySelector(".split-side-open")
        : 根.querySelector(".split-side-shut");
      if (藏?.contains(document.activeElement)) 分隔.focus();
    });
  };

  const 提交 = (下: 分栏) => {
    const 根 = 根Ref.current;
    const 帧: 分栏帧 = { 状态: 下, 宽: 下.折起 ? 轨宽 : 下.宽, 折起: 下.折起 };
    if (同(下, 分栏Ref.current)) {
      预览Ref.current = null;
      if (根) 画到(根, 帧);
      return;
    }
    预览Ref.current = 帧;
    分栏Ref.current = 下;
    if (根) 画到(根, 帧);
    写分栏(下);
    set分栏(下);
    焦点归位(下);
  };

  // 状态追上预览之后清掉，下一次无关的重渲染就以落盘值为准
  useEffect(() => {
    预览Ref.current = null;
  }, [分栏]);

  const 按下 = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 第二根手指 / 笔的侧键不另开一路。button 挡右键，isPrimary 挡多点
    if (!e.isPrimary || e.button !== 0) return;
    const 根 = 根Ref.current;
    const 分隔 = e.currentTarget;
    if (!根) return;
    // 默认行为会把焦点送进分隔条。正文、大纲浮层、AI 坞都按失焦收起，
    // 拖一下宽度不该把正在打的字和开着的浮层一起收走
    e.preventDefault();
    卸手势.current?.();
    try {
      分隔.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获不成，监听仍挂在分隔条上；指针留在窗内时这一下还在 */
    }
    const 起点 = 分栏Ref.current;
    const 容器 = 根.getBoundingClientRect().width;
    const 起x = e.clientX;
    const id = e.pointerId;
    拖着.current = true;
    根.dataset.dragging = "1";
    let 收过 = false;

    const 收场 = () => {
      window.removeEventListener("pointermove", 移动);
      window.removeEventListener("pointerup", 结束);
      window.removeEventListener("pointercancel", 取消);
      分隔.removeEventListener("lostpointercapture", 丢失);
      拖着.current = false;
      delete 根.dataset.dragging;
      if (卸手势.current === 收场) 卸手势.current = null;
    };
    const 移动 = (ev: PointerEvent) => {
      if (ev.pointerId !== id || 收过) return;
      const 帧 = 拖动帧(起点, ev.clientX - 起x, 容器);
      预览Ref.current = 帧;
      画到(根, 帧);
    };
    const 结束 = (ev: PointerEvent) => {
      if (ev.pointerId !== id || 收过) return;
      收过 = true;
      收场();
      提交(拖动帧(起点, ev.clientX - 起x, 容器).状态);
    };
    const 取消 = (ev: PointerEvent) => {
      if (ev.pointerId !== id || 收过) return;
      收过 = true;
      收场();
      预览Ref.current = null;
      画到(根, {
        状态: 分栏Ref.current,
        宽: 分栏Ref.current.折起 ? 轨宽 : 分栏Ref.current.宽,
        折起: 分栏Ref.current.折起,
      });
    };
    // 捕获被系统收走时往往只有 lostpointercapture，没有 pointerup。
    // 松手那一拍会先把 收过 置上再拆监听，所以正常松手不会被这条当成取消
    const 丢失 = (ev: PointerEvent) => {
      if (ev.pointerId !== id || 收过) return;
      取消(ev);
    };
    卸手势.current = 收场;
    // 挂在 window 上，和目录树拖拽同一条理由：捕获失败时指针一离开 8px 的条子，
    // 元素上的 pointerup 就收不到，拖动态会粘住
    window.addEventListener("pointermove", 移动);
    window.addEventListener("pointerup", 结束);
    window.addEventListener("pointercancel", 取消);
    分隔.addEventListener("lostpointercapture", 丢失);
  };

  const 按键 = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const 名 = e.key === "ArrowLeft" ? "左" : e.key === "ArrowRight" ? "右" : e.key === "Home" ? "复位" : null;
    if (!名) return;
    e.preventDefault();
    const 容器 = 根Ref.current?.getBoundingClientRect().width ?? 0;
    提交(按键分栏(分栏Ref.current, 名, 容器));
  };

  const 展开 = () => {
    if (!分栏Ref.current.折起) return;
    提交({ 宽: 分栏Ref.current.宽, 折起: false });
  };

  return { 根: 根Ref, 分隔: 分隔Ref, 折起, 列宽, 按下, 按键, 展开 };
}
