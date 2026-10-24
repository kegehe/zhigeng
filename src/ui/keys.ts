import type { KeyboardEvent } from "react";

/**
 * "这一下回车该不该提交"的判据只有这一份。
 *
 * 中文输入法里**回车确认候选词也会发 keydown**（Chromium 带 `isComposing`，
 * 更老的内核只给 keyCode 229）。不挡这一下，用户选词那一下就会把拼音当成
 * 目录名 / 标题 / 指令提交出去。真机验证走的是 `Input.insertText`，绕开了
 * 输入法，这条路只有人用真输入法才照得出来。
 */
export function 是回车提交(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229;
}
