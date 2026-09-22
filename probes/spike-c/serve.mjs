// 零依赖静态服务器，只为 Spike C 原型服务。用完即可删。
// 用法：node probes/spike-c/serve.mjs [端口]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 7788);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer(async (req, res) => {
  const name = (req.url ?? "/").split("?")[0];
  const file = join(here, name === "/" ? "index.html" : name.replace(/^\/+/, ""));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[file.slice(-5)] ?? "text/plain; charset=utf-8" });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(e));
  }
}).listen(port, "127.0.0.1", () => console.log(`spike-c 原型: http://127.0.0.1:${port}/`));
