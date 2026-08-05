import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "ui");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: "ui-demo", backend: "not-connected" }));
    return;
  }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(root, requested));
  if (!path.startsWith(root)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(body);
  }
});

const port = Number(process.env.PORT || 5173);
server.listen(port, "127.0.0.1", () => {
  console.log("Web Security Observatory UI: http://127.0.0.1:" + port);
});
