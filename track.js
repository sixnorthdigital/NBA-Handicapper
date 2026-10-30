// Results tracker: saves every game's picks before tip-off and grades them once the game is final.
// Run by GitHub Actions every 30 minutes (.github/workflows/track.yml), so it works even while the Render app is asleep
// and uses none of Render's free hours. Records live in records.json on the "nba-data" branch; the app reads them from there.
//
//   node track.js <data dir> <cache dir>
//
// Before tip-off each run re-saves the picks with the latest lines, so what's kept is the last snapshot before the game
// (close to the closing line). A game that starts before any snapshot was taken is marked "missed" and left out of the record.
const fs = require("fs"), path = require("path");
const DIR = process.argv[2] || "data", CDIR = process.argv[3] || ".cache";
const FILE = path.join(DIR, "records.json"), BOXF = path.join(CDIR, "boxes.json");

const cache = new Map();
async function getJSON(url, ttl = 600) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.data;
  let r, err;
  for (let i = 0; i < 3; i++) {   // ESPN can hiccup; try a few times
    try { r = await fetch(url, { headers: { "User-Agent": "nba-handicapper-tracker/0.1" } }); if (r.ok || r.status === 404) break; err = new Error(`${r.status} ${url}`); }
    catch (e) { err = e; }
    await new Promise(z => setTimeout(z, 1500 * (i + 1)));
  }
  if (!r || !r.ok) throw err || new Error(`${r && r.status} ${url}`);
  const data = await r.json();
  cache.set(url, { data, exp: Date.now() + ttl * 1000 });
  return data;
}
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const nba = require("./nba")({ getJSON, r2 });
const etDay = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ---------- grading ----------
const dec = a => a > 0 ? 1 + a / 100 : 1 + 100 / -a;
function grade(k, x, hs, as) {   // -> "win" | "loss" | "push"
  if (!x) return null;
  const me = x.side === "home" ? hs : as, op = x.side === "home" ? as : hs;
  let d;
  if (k === "ml") d = me - op;
  else if (k === "spread") d = me - op + x.point;
  else if (k === "total") d = x.pick === "over" ? hs + as - x.line : x.line - (hs + as);
  else return null;
  return d > 0 ? "win" : d < 0 ? "loss" : "push";
}
const units = (r, price) => r === "win" ? r2(dec(price != null ? price : -110) - 1) : r === "loss" ? -1 : 0;

// ---------- picks snapshot from the matchup model ----------
function snapshot(m) {
  const md = m.model, g = m.game, o = g.odds || {};
  if (!md) return null;
  const L = md.lean || {}, w = L.winner, sp = L.spread, t = L.total, b = md.best;
  const price = (s, k) => o[s] ? (k === "ml" ? o[s].ml : o[s].spread && o[s].spread.price) : null;
  return {
    at: new Date().toISOString(),
    odds: { book: o.book || null, homeMl: o.home ? o.home.ml : null, awayMl: o.away ? o.away.ml : null, homeSpread: o.home && o.home.spread ? o.home.spread.point : null,
      total: o.total ? o.total.point : null },
    model: { home: md.home, away: md.away, margin: md.margin, total: md.total, rest: md.adj.rest, injHome: md.adj.injHome, injAway: md.adj.injAway, games: md.league.games, lgRtg: md.league.rtg, lgPace: md.league.pace, poss: md.poss },
    best: b ? { kind: b.type, side: b.side, pick: b.side === "over" || b.side === "under" ? b.side : undefined, label: b.label, price: b.price, point: b.point, line: b.line,
      p: b.p, edge: b.edge, strength: b.strength } : null,
    winner: w ? { kind: "ml", side: w.side, abbr: w.abbr, price: price(w.side, "ml"), p: w.p, strength: w.strength, score: w.score, underdog: !!w.underdog } : null,
    spread: sp ? { kind: "spread", side: sp.side, abbr: sp.abbr, point: sp.point, price: price(sp.side, "spread"), p: sp.p, strength: sp.strength, score: sp.score } : null,
    total: t ? { kind: "total", pick: t.pick, line: t.line, price: o.total ? o.total[t.pick] : null, p: t.p, strength: t.strength, score: t.score } : null,
  };
}
function settle(G) {   // grade every pick of a final game
  const s = G.snap, R = G.result;
  if (!s || !R || R.void) return;
  const one = x => { if (!x) return null; const r = grade(x.kind, x, R.hs, R.as); return { r, u: units(r, x.price) }; };
  G.grades = { best: one(s.best), winner: one(s.winner), spread: one(s.spread), total: one(s.total) };
}

(async () => {
  let rec = { v: 1, days: {} };
  try { rec = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
  try { console.log("box cache:", nba.loadBoxes(JSON.parse(fs.readFileSync(BOXF, "utf8"))), "games"); } catch (e) { console.log("box cache: empty"); }
  const today = etDay(), now = Date.now(), dates = [addDays(today, -3), addDays(today, -2), addDays(today, -1), today];
  let snaps = 0, graded = 0, missed = 0;
  for (const date of dates) {
    let gs;
    try { gs = await nba.games(date); } catch (e) { console.error(date, "scoreboard:", e.message); continue; }
    if (!gs.length) continue;
    const day = rec.days[date] = rec.days[date] || { games: {} };
    for (const g of gs) {
      const G = day.games[g.id] = day.games[g.id] || { home: g.home.abbr, away: g.away.abbr, start: g.start };
      G.start = g.start;
      if (g.state === "FUT" && Date.parse(g.start) > now) {   // still to play: (re)take the snapshot with the latest lines
        try { const m = await nba.matchup(g.home.abbr, g.away.abbr, date); const s = snapshot(m); if (s) { G.snap = s; snaps++; } }
        catch (e) { console.error(g.away.abbr, "@", g.home.abbr, e.message); }
      } else if (g.state === "FINAL") {
        G.result = { hs: g.home.score, as: g.away.score };
        if (!G.snap) { G.missed = true; missed++; } else if (!G.grades) { settle(G); graded++; }
      } else if (g.state === "PPD") { G.result = { void: true }; }
      else if (!G.snap && Date.parse(g.start) <= now) G.missed = true;   // tipped off before the first snapshot
    }
  }
  rec.updated = new Date().toISOString();
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(rec));
  fs.mkdirSync(CDIR, { recursive: true }); fs.writeFileSync(BOXF, JSON.stringify(nba.dumpBoxes()));
  console.log(`snapshots ${snaps}, graded ${graded}, missed ${missed}`);
})().catch(e => { console.error(e); process.exit(1); });
