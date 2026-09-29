// Local stand-in for Netlify: serves the site, runs /api/* through the real function,
// and stores data in a local Netlify Blobs sandbox (.netlify/local-blobs).
//   npm run dev                       → http://localhost:8888 (admin at /admin)
//   open http://localhost:8888/__remind → run the reminder job right now
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalBlobs } from "./blobs-local.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT) || 8888;
const BLOBS_PORT = PORT + 1;

await startLocalBlobs({ directory: join(ROOT, ".netlify/local-blobs"), port: BLOBS_PORT });
process.env.URL ||= `http://localhost:${PORT}`;

const api = (await import("../netlify/functions/api.mjs")).default;
const reminders = (await import("../netlify/functions/reminders.mjs")).default;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, process.env.URL);
  try {
    if (url.pathname === "/__remind") {
      await reminders();
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("Reminder job ran — see the terminal for what was sent.\n");
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await api(new Request(url, {
        method: req.method, headers: req.headers,
        body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : Buffer.concat(chunks),
      }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) throw Object.assign(new Error(), { code: "ENOENT" });
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (e.code !== "ENOENT") console.error(e);
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(e.code === "ENOENT" ? "Not found" : "Server error");
  }
}).listen(PORT, () => {
  console.log(`\n  Wishly running at  http://localhost:${PORT}`);
  console.log(`  Admin panel        http://localhost:${PORT}/admin`);
  console.log(`  Run reminders now  http://localhost:${PORT}/__remind\n`);
});
