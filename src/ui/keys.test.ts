import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { 是回车提交 } from "./keys";

function 键(e: { key?: string; isComposing?: boolean; keyCode?: number } = {}): KeyboardEvent {
  return {
    key: e.key ?? "Enter",
    nativeEvent: { isComposing: e.isComposing ?? false, keyCode: e.keyCode ?? 13 },
  } as unknown as KeyboardEvent;
}

describe("回车提交的判据", () => {
  it("普通回车算提交", () => {
    expect(是回车提交(键())).toBe(true);
  });

  it("输入法组词中的回车不算提交", () => {
    expect(是回车提交(键({ isComposing: true }))).toBe(false);
  });

  it("只给 keyCode 229 的老内核也不算提交", () => {
    expect(是回车提交(键({ keyCode: 229 }))).toBe(false);
  });

  it("别的键不算提交", () => {
    expect(是回车提交(键({ key: "a", keyCode: 65 }))).toBe(false);
  });
});
