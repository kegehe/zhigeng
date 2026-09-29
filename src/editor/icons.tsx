import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Ban,
  Bold,
  Code,
  Italic,
  Link2,
  Minus,
  MoveDown,
  MoveUp,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table,
  Undo2,
  type LucideProps,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * 工具栏、选区气泡、`/` 菜单**共用这一张表**。三处各写一份的话，早晚有一处还是文字、
 * 另一处已经是图标——而那一排混着摆的时候，"有的画有的写字"比全都写字更难看。
 *
 * 图标走 [06] 第 13 行定的 Lucide，按需 import（打进包里，不发外部请求——离线优先产品
 * 连图标都不许联网取）。
 */
export type 图标名 =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "clear"
  | "divider"
  | "quote"
  | "table"
  | "rowAdd"
  | "rowRemove"
  | "colAdd"
  | "colRemove"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignNone"
  | "up"
  | "down"
  | "undo"
  | "redo";

/**
 * "动整行 / 整列"这四枚自己画：Lucide 1.48 没有 row-insert / column-insert 这类名字，
 * 而把 `Rows3` 与 `Plus` 拼在一起用户分不出加的是行还是列。画法照同一套参数：24 的视野、
 * `currentColor` 描边、线宽 2、圆头收尾——混在 Lucide 那排里看不出差级。**四枚共用同一个
 * 加减记号**，只差在横条还是竖条：学会一个就学会四个。
 */
function 画(横竖: ReactNode, 记号: "加" | "减") {
  return function 图标(p: LucideProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={24}
        height={24}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...p}
      >
        {横竖}
        <path d="M15.5 19.5h6" />
        {记号 === "加" ? <path d="M18.5 16.5v6" /> : null}
      </svg>
    );
  };
}

const 两横 = (
  <>
    <path d="M3.5 7h12" />
    <path d="M3.5 12.5h12" />
  </>
);
const 两竖 = (
  <>
    <path d="M7 3.5v12" />
    <path d="M12.5 3.5v12" />
  </>
);

export const 工具图标: Record<图标名, ComponentType<LucideProps>> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  code: Code,
  link: Link2,
  clear: RemoveFormatting,
  divider: Minus,
  quote: Quote,
  table: Table,
  rowAdd: 画(两横, "加"),
  rowRemove: 画(两横, "减"),
  colAdd: 画(两竖, "加"),
  colRemove: 画(两竖, "减"),
  alignLeft: AlignLeft,
  alignCenter: AlignCenter,
  alignRight: AlignRight,
  // 「取消对齐」是"这一列不留 `:`"，不是"清除格式"，所以不复用那个图标：
  // 一条斜杠划过的形状说的是"这里没有设定"，两个语义各占一枚才不打架。
  alignNone: Ban,
  up: MoveUp,
  down: MoveDown,
  undo: Undo2,
  redo: Redo2,
};
