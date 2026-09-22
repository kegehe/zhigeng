# Spike C 原型 · 3000 块长文档渲染成本

一次性验证代码，**不属于产品**（docs/05 §M0 拆解）。留着是因为结论会反复被引用，且需要能重跑。
结论已写入 [ADR-004](../../docs/adr/ADR-004-长文档策略.md)。

## 跑法

```bash
node probes/spike-c/serve.mjs 7788      # 零依赖静态服务
# 浏览器打开 http://127.0.0.1:7788/ ，或用自动化驱动：
#   window.probeMount('A' | 'B')        → 挂载并返回 DOM 节点数与挂载耗时
#   window.startRun3({ops:30})          → 纯重排测法（推荐的唯一可信测法）
#   window.readRun()                    → 读累积结果
#   window.probeSectionMountCost(8)     → 分节模式跨节的挂载/卸载成本
```

## 两种模式

| 模式 | 做法 | DOM 节点 |
|---|---|---|
| A | 3000 个块全部挂在单个 `contenteditable` 里（ProseMirror 今天的真实行为） | 3001 |
| B | 按标题切 30 节，可视节 + 相邻节为 `contenteditable`，其余节为静态文本，`IntersectionObserver` 切换 | 330 |

## 测法演进与踩到的坑（重要）

三轮测法，前两轮的数据**都不可信**，教训比数字值钱：

| 测法 | 做法 | 结果 |
|---|---|---|
| 1 `execCommand` + 等 2 个 rAF | 最像"输入到看到" | 出现 **43s** 的首键假尖峰 |
| 2 `execCommand` + 强制同步布局 | 想去掉帧依赖 | 仍有 **5.9s** 尖峰 |
| 3 `text.appendData()` + 强制同步布局 | 不产生选区滚动、不等合成帧 | 可用：A p50 4.8ms / B p50 0.7ms |

根因：自动化浏览器里页面是 **`visibilityState: hidden`**，rAF 被饿死；而 `execCommand` 插入文字会要求把 caret 滚入视野，需要一帧合成，于是就地等待数秒。
**任何浏览器侧性能测量都必须先断言 `visibilityState === 'visible'`**，否则测到的是窗口调度而不是代码。这条已写进 [03] §性能预算 的复测要求。

## 已知局限（不要把这份数据当最终结论）

1. 量的是**纯重排**，不含样式重算、绘制、合成
2. 原型是裸 `contenteditable`，**没有 ProseMirror 的装饰层、选区与事务开销**——真实编辑器每键成本必然高于 4.8ms，所以 4.8ms 是下界
3. 结论"分节不划算"依赖跨节 9–20ms 与节省 4ms 的对比；若真机上装饰层导致 A 模式 P95 远超 16ms，需要重开 ADR-004

因此定稿必须补一次真机复测：Tauri 可见窗口 + 真 TipTap + 3000 块文档。
