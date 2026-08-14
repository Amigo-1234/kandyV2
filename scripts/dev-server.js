/* Minimal static file server for local development and verification.
   Not part of the deployed site — Firebase Hosting serves the real thing.
       node scripts/dev-server.js [port]                                    */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2]) || 5501;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);

  /* Dev-only sink so a browser tab can hand a JSON export back to disk
     without it round-tripping through the terminal. Writes one fixed path
     inside the project and nothing else. */
  if (req.method === "POST" && url === "/_export") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const dest = path.join(ROOT, "supabase", "seed", "firestore-export.json");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: body.length, path: dest }));
    });
    return;
  }

  let file = path.join(ROOT, url === "/" ? "index.html" : url);

  if (!file.startsWith(ROOT)) {           // no traversal out of the project
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, "index.html");
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log("Kandy's Treats dev server on http://127.0.0.1:" + PORT);
});
