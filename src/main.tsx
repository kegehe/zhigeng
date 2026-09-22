import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Capture } from "./Capture";
import "./ui/base.css";

const host = document.getElementById("root");
if (!host) throw new Error("找不到 #root 挂载点");

// 速记窗与主窗共用同一份构建产物，靠窗口标签分流：多一个 HTML 入口就是冷启动
// 多一次请求，不值。Tauri 下用窗口标签，纯浏览器直开时落到 main。
const label = windowLabel();

function windowLabel(): string {
  const fromQuery = new URLSearchParams(location.search).get("window");
  if (fromQuery) return fromQuery;
  // @ts-expect-error Tauri 注入的内部对象，类型包里没声明标签字段
  return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "main";
}

createRoot(host).render(
  <StrictMode>{label === "capture" ? <Capture /> : <App />}</StrictMode>
);
