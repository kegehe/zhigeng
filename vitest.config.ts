import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 字节级往返测试必须走真的 ProseMirror Editor 实例：上一轮的坑正是
    // "手工拼的 JSON 看着对，装进 Editor 之后属性全空"。只测纯函数会漏掉它。
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
