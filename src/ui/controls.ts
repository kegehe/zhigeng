/**
 * 按钮基线。两条来自 [06] §3 而以前没落地的：
 * - **禁用态降透明度，不降对比**——`disabled:text-fg-disabled` 那套写法把字与底一起调淡，
 *   实测 2.88:1，比"降透明度"更糟的是它看着像"能点但很弱"而不是"不能点"。
 * - **按下去要有 `translateY(1px)`**：动的是 transform，不触发布局（§动效那条允许）。
 *
 * 从 `App.tsx` 搬出来只为一件事：设置页要用同一副按钮，而这里再抄一份字符串常量，
 * [06] §3 那张"Button 变体体系"的欠账就从"两份"变成"三份"。尺寸与变体仍未成体系，
 * 这一层只保证**同一副按钮在两个文件里是同一串字**。
 */
const btnBase =
  "cursor-pointer rounded-md border border-line px-2 py-1 text-xs transition-colors duration-(--dur-1) hover:bg-hover active:translate-y-px disabled:cursor-default disabled:opacity-55";

export const btn = btnBase + " text-fg-2";

/**
 * 危险动作（永久删除 / 移进回收站）。
 *
 * **不能写成 `btn + " text-danger"`**：两者都是同层单类 utility，生成顺序里
 * `text-fg-2` 排在 `text-danger` 之后，红色会被压回次要色。基线只留一份，
 * 颜色在这里分叉。
 */
export const btnDanger = btnBase + " text-danger";

export const btnPrimary =
  "cursor-pointer rounded-md bg-accent px-3 py-1 text-xs text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:cursor-default disabled:opacity-55";
/**
 * 侧栏底栏那一排入口的"当前开着哪一格"。选中那一格连字一起提到主色：
 * 底色加深之后次要色压上去实测 6.2:1、主色 14.5:1——过线是过线，但"这一格开着"
 * 是这一排唯一的定位信息，不该靠一层 1.46:1 的底色去猜。
 */
export const btnOn = (开着: boolean) => btn + (开着 ? " bg-active text-fg" : "");
/** 一行里那几个等宽输入框（路径、模型名）。设置页与备份/导入面板同一副样子 */
export const 路径框 =
  "min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg";
