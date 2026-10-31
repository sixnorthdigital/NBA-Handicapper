// Record tab: reads the tracker's records.json (nba-data branch) and adds up how the picks have done.
const RAW = process.env.RECORDS_URL || "https://raw.githubusercontent.com/sixnorthdigital/NBA-Handicapper/nba-data/records.json";
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;

let memo = null;
async function load() {
  if (memo && memo.exp > Date.now()) return memo.data;
  const r = await fetch(RAW + "?t=" + Math.floor(Date.now() / 120000), { headers: { "User-Agent": "nba-handicapper/0.2" } });
  if (r.status === 404) return { days: {} };   // tracker hasn't run yet
  if (!r.ok) throw new Error(`Couldn't load records (${r.status})`);
  const data = await r.json();
  memo = { data, exp: Date.now() + 120000 };
  return data;
}
function tally() { return { w: 0, l: 0, p: 0, u: 0, n: 0 }; }
function add(t, g) { if (!g || !g.r) return; t.n++; t[g.r[0]]++; t.u += g.u || 0; }
function out(t) { const dec = t.w + t.l; return { w: t.w, l: t.l, p: t.p, n: t.n, units: r2(t.u), roi: t.n ? r1(t.u / t.n * 100) : null, hit: dec ? r1(t.w / dec * 100) : null }; }

async function summary() {
  const rec = await load(), days = Object.keys(rec.days || {}).sort().reverse();
  const T = { best: tally(), winner: tally(), spread: tally(), total: tally() }, byStr = {}, bestByType = { ml: tally(), spread: tally(), total: tally() };
  const dog = tally(), err = { n: 0, mM: 0, kM: 0, mT: 0, kT: 0, nM: 0, nT: 0 };
  let missed = 0, pending = 0;
  const list = [];
  for (const d of days) {
    const gs = Object.entries(rec.days[d].games || {}).map(([id, G]) => ({ id, ...G })).sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const rows = [];
    for (const G of gs) {
      if (G.missed && !G.snap) { missed++; continue; }
      if (!G.snap) continue;
      const g = G.grades, s = G.snap;
      if (!g) { if (!(G.result && G.result.void)) pending++; }
      else {
        add(T.best, g.best); add(T.winner, g.winner); add(T.spread, g.spread); add(T.total, g.total);
        if (s.best && g.best) add(bestByType[s.best.kind] || tally(), g.best);
        if (s.winner && s.winner.underdog) add(dog, g.winner);
        for (const k of ["winner", "spread", "total"]) if (s[k] && g[k]) { const key = k + "|" + s[k].strength; add(byStr[key] = byStr[key] || tally(), g[k]); }
        // accuracy: how far the model's numbers and the market's numbers were from what happened
        const R = G.result, m = s.model, o = s.odds;
        if (R && m && !R.void) {
          const margin = R.hs - R.as, total = R.hs + R.as;
          if (o.homeSpread != null) { err.nM++; err.mM += Math.abs(m.margin - margin); err.kM += Math.abs(-o.homeSpread - margin); }
          if (o.total != null) { err.nT++; err.mT += Math.abs(m.total - total); err.kT += Math.abs(o.total - total); }
        }
      }
      rows.push({ id: G.id, home: G.home, away: G.away, start: G.start, result: G.result || null, snap: s, grades: g || null });
    }
    if (rows.length) list.push({ date: d, games: rows });
  }
  const strength = {};
  for (const [k, t] of Object.entries(byStr)) { const [type, s] = k.split("|"); (strength[type] = strength[type] || {})[s] = out(t); }
  return { updated: rec.updated || null, totals: { best: out(T.best), winner: out(T.winner), spread: out(T.spread), total: out(T.total) },
    bestByType: { ml: out(bestByType.ml), spread: out(bestByType.spread), total: out(bestByType.total) }, underdogs: out(dog), strength,
    accuracy: { margin: err.nM ? { n: err.nM, model: r1(err.mM / err.nM), market: r1(err.kM / err.nM) } : null, total: err.nT ? { n: err.nT, model: r1(err.mT / err.nT), market: r1(err.kT / err.nT) } : null },
    missed, pending, days: list.slice(0, 30),
    // daily cheat sheets as they stood at tip-off, marked W / L / V (didn't play) once final
    sheets: Object.keys(rec.sheets || {}).sort().reverse().slice(0, 30).map(d => ({ date: d, ...rec.sheets[d] })) };
}
module.exports = { summary };
