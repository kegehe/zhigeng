import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Capture } from "./Capture";
import { 套主题, 读主题 } from "./ui/theme";
import { 套行距, 读行距 } from "./ui/typography";
import "./ui/base.css";

const host = document.getElementById("root");
if (!host) throw new Error("找不到 #root 挂载点");

// 渲染之前先套上主题与行距：等 React 挂载完再改，暗色用户会先看到一帧白底界面，
// 紧凑档用户会先看到一帧 1.75 的行距再跳一下
套主题(读主题());
套行距(读行距());

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
