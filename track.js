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

// ---------- daily cheat sheets (same rules as the app's NBA Streaks tab) ----------
// Each run rebuilds the rows for games that haven't started, so a row is kept as it stood at tip-off; once the game is final
// it's marked: W = cleared the line, L = missed, V = didn't play. Team streaks: W = the streak kept going.
const LINES = { pts: [10, 15, 20, 25, 30, 35, 40], reb: [4, 6, 8, 10, 12, 14], ast: [3, 4, 6, 8, 10, 12], tpm: [2, 3, 4, 5, 6], pra: [20, 25, 30, 35, 40, 45, 50], stl: [2, 3], blk: [2, 3, 4] };
const LAB = { pts: "PTS", reb: "REB", ast: "AST", tpm: "3PM", pra: "PRA", stl: "STL", blk: "BLK" }, IX = { pts: 4, reb: 5, ast: 6, tpm: 7, stl: 8, blk: 9 };
const val = (x, k) => k === "pra" ? x[4] + x[5] + x[6] : x[IX[k]];
const Phi = z => { const t = 1 / (1 + .2316419 * Math.abs(z)), d = .3989423 * Math.exp(-z * z / 2), p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function chance(p, k, n) {   // P(at least n) tonight, as on the phone
  const mu = (p.lam || {})[k] || 0, sd = (p.sd || {})[k] || 1;
  if (["tpm", "stl", "blk"].includes(k) || mu < 4) { let q = Math.exp(-mu), c = q; for (let i = 1; i < n; i++) { q *= mu / i; c += q; } return Math.max(0, Math.min(1, 1 - c)); }
  return 1 - Phi((n - .5 - mu) / Math.max(sd, .5));
}
function best(p, L, min) {
  let b = null;
  for (const k of Object.keys(LINES)) for (const t of LINES[k]) {
    let n = 0; while (n < L.length && val(L[n], k) >= t) n++;
    if (n < min) continue;
    const ch = chance(p, k, t);
    if (!b || n > b.n || (n === b.n && ch < b.ch)) b = { prop: k, lab: LAB[k], t, n, ch: r3(ch), ls: L.slice(0, n).some(x => x[0] === 1) };
  }
  return b;
}
async function sheets(rec, date, now) {
  const D = (rec.sheets = rec.sheets || {})[date] = (rec.sheets || {})[date] || { vso: [], streaks: [], teams: [] };
  let P = null;
  try { P = await nba.props(date); } catch (e) { console.error("sheets props:", e.message); }
  if (P && P.players.length) {
    const fut = new Set((P.teams || []).filter(t => t.state === "FUT" && Date.parse(t.start) > now).map(t => String(t.id)));
    const keep = list => list.filter(e => !fut.has(String(e.gid)));   // rows for games already under way stay as they were
    const row = (p, b) => ({ id: p.id, name: p.name, team: p.team, opp: p.opp, home: p.home, gid: String(p.gid), start: p.start, ...b });
    const vso = [], st = [];
    for (const p of P.players) {
      if (!fut.has(String(p.gid))) continue;
      const a = best(p, p.vs || [], 5); if (a) vso.push(row(p, { ...a, ls: false }));
      const b = best(p, p.games || [], 5); if (b) st.push(row(p, b));
    }
    const rank = l => l.sort((x, y) => y.n - x.n || x.ch - y.ch).map((e, i) => ({ ...e, rank: i + 1 }));
    D.vso = rank(keep(D.vso).concat(vso)); D.streaks = rank(keep(D.streaks).concat(st));
    const tm = [];
    for (const t of P.teams || []) if (fut.has(String(t.id))) for (const s of ["home", "away"]) { const x = t.streak && t.streak[s]; if (x && x.n >= 3) tm.push({ a: t[s].abbr, opp: t[s === "home" ? "away" : "home"].abbr, home: s === "home", code: x.code, n: x.n, gid: String(t.id), start: t.start }); }
    D.teams = keep(D.teams).concat(tm);
  }
  // mark finished games
  const gs = await nba.games(date).catch(() => []), fin = {};
  gs.forEach(g => { if (g.state === "FINAL") fin[String(g.id)] = g; else if (g.state === "PPD") fin[String(g.id)] = { ppd: true }; });
  for (const e of [...D.vso, ...D.streaks]) {
    if (e.r || !fin[e.gid]) continue;
    if (fin[e.gid].ppd) { e.r = "V"; continue; }
    const b = await nba.box(e.gid).catch(() => null); if (!b) continue;
    const x = (b.p[e.team] || []).find(z => z[0] === e.id);
    if (!x) { e.r = "V"; continue; }
    const v = e.prop === "pra" ? x[5] + x[6] + x[7] : x[{ pts: 5, reb: 6, ast: 7, tpm: 8, stl: 9, blk: 10 }[e.prop]];
    e.v = v; e.r = v >= e.t ? "W" : "L";
  }
  for (const e of D.teams) {
    const g = fin[e.gid]; if (e.r || !g) continue;
    if (g.ppd) { e.r = "V"; continue; }
    const me = e.home ? g.home : g.away, op = e.home ? g.away : g.home, won = me.score > op.score;
    e.out = won ? "W" : "L"; e.sc = [me.score, op.score]; e.r = (e.code === "W") === won ? "W" : "L";
  }
  if (!D.vso.length && !D.streaks.length && !D.teams.length) delete rec.sheets[date];
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
  for (const date of dates) { if (date === today || (rec.sheets || {})[date]) { try { await sheets(rec, date, now); } catch (e) { console.error(date, "sheets:", e.message); } } }
  rec.updated = new Date().toISOString();
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(rec));
  fs.mkdirSync(CDIR, { recursive: true }); fs.writeFileSync(BOXF, JSON.stringify(nba.dumpBoxes()));
  console.log(`snapshots ${snaps}, graded ${graded}, missed ${missed}`);
})().catch(e => { console.error(e); process.exit(1); });
