// NBA Handicapper: game cards with odds and matchup pages (team form, rest, 2-year head-to-head), from ESPN's public feeds.
// Split out of the Hockey Handicapper so each sport runs as its own app.
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;

const cache = new Map();
async function getJSON(url, ttl = 600) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.data;
  const r = await fetch(url, { headers: { "User-Agent": "nba-handicapper/0.1" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const data = await r.json();
  cache.set(url, { data, exp: Date.now() + ttl * 1000 });
  if (cache.size > 2000) for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
  return data;
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const r2 = x => Math.round(x * 100) / 100;
const nba = require("./nba")({ getJSON, r2 });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const PUB = path.join(__dirname, "Public");
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), q = u.searchParams;
  try {
    if (u.pathname.startsWith("/api/nba/")) {
      const d = q.get("date") || today(); if (!/^\d{4}-\d\d-\d\d$/.test(d)) return send(res, 400, { error: "Bad date" });
      if (u.pathname === "/api/nba/games") return send(res, 200, await nba.games(d));
      if (u.pathname === "/api/nba/matchup") return send(res, 200, await nba.matchup(q.get("home"), q.get("away"), d));
      return send(res, 404, { error: "Not found" });
    }
    const f = path.normalize(path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f)) return send(res, 404, "Not found", "text/plain");
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || "text/plain");
  } catch (e) { send(res, e.code || 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`NBA Handicapper on http://localhost:${PORT}`);
  setTimeout(nba.warm, 3000); setInterval(nba.warm, 30 * 60000);   // league box scores: offense, defense and pace for every team
});
