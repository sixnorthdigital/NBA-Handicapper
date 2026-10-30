// NBA game model, built on the same ideas as the hockey model:
//   offense vs defense (points per 100 possessions) and pace, home court, rest and travel, injuries and starting lineups,
//   then win / spread / total chances blended with the market, edges and leans.
// Everything comes from ESPN box scores (game summaries), so it works from Render without a paid feed.
// Box scores are cut down to a few numbers per team and player and kept in memory; finished games never change.
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

// ---------- assumptions (rules of thumb, to be checked against results while testing) ----------
const HCA = 2.4;          // home court, points of margin
const SD_MARGIN = 12.5;   // spread of final margins around the projection
const SD_TOTAL = 18;      // spread of final totals around the projection
const LG_RTG = 114.5, LG_PACE = 99.5;   // league fallbacks until enough box scores are in
const K_TEAM = 10;        // team rates: games of weight given to last season (or the league average)
const K_PACE = 8;
const REST_PTS = .7, REST_CAP = 2.5;   // points of margin per point of fatigue gap, and the most rest/travel can move a game
const ST_W = { out: 1, suspension: 1, doubtful: .8, questionable: .45, "day-to-day": .3, probable: .1 };

// arena [lat, lon, hours from Eastern]
const GEO = { ATL: [33.76, -84.40, 0], BOS: [42.37, -71.06, 0], BKN: [40.68, -73.98, 0], CHA: [35.23, -80.84, 0], CHI: [41.88, -87.67, -1], CLE: [41.50, -81.69, 0],
  DAL: [32.79, -96.81, -1], DEN: [39.75, -105.01, -2], DET: [42.34, -83.06, 0], GS: [37.77, -122.39, -3], HOU: [29.75, -95.36, -1], IND: [39.76, -86.16, 0],
  LAC: [33.95, -118.34, -3], LAL: [34.04, -118.27, -3], MEM: [35.14, -90.05, -1], MIA: [25.78, -80.19, 0], MIL: [43.05, -87.92, -1], MIN: [44.98, -93.28, -1],
  NO: [29.95, -90.08, -1], NY: [40.75, -73.99, 0], OKC: [35.46, -97.52, -1], ORL: [28.54, -81.38, 0], PHI: [39.90, -75.17, 0], PHX: [33.45, -112.07, -2],
  POR: [45.53, -122.67, -3], SAC: [38.58, -121.50, -3], SA: [29.43, -98.44, -1], TOR: [43.64, -79.38, 0], UTAH: [40.77, -111.90, -2], WSH: [38.90, -77.02, 0] };
const ALIAS = { GSW: "GS", NOP: "NO", NYK: "NY", SAS: "SA", UTA: "UTAH", WAS: "WSH", BRK: "BKN", PHO: "PHX" };
const ab = a => ALIAS[a] || a;
const HIGH = { DEN: 1, UTAH: 1 };   // altitude
// ESPN team ids, used when the standings don't carry them
const IDS = { ATL: 1, BOS: 2, NO: 3, CHI: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8, GS: 9, HOU: 10, IND: 11, LAC: 12, LAL: 13, MIA: 14, MIL: 15, MIN: 16,
  BKN: 17, NY: 18, ORL: 19, PHI: 20, PHX: 21, POR: 22, SAC: 23, SA: 24, OKC: 25, UTAH: 26, WSH: 27, TOR: 28, MEM: 29, CHA: 30 };

module.exports = ({ getJSON, r2, teamGames, pool, seasonYr, etDate }) => {
  const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;
  const cl = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mins = v => { const s = String(v == null ? "" : v); if (!s || s === "--") return 0; const p = s.split(":"); return (+p[0] || 0) + (p[1] ? (+p[1] || 0) / 60 : 0); };
  const made = v => { const p = String(v == null ? "" : v).split("-"); return [+p[0] || 0, +p[1] || 0]; };   // "13-24" -> [13, 24]

  // ---------- one game's box score, cut down ----------
  // team: [pts, fga, fta, oreb, tov, min, fgm, 3pm, 3pa, ftm, reb, ast]
  // player: [id, name, pos, starter, min, pts, reb, ast, 3pm, stl, blk, tov, fga, fta]
  const BOX = new Map(), boxBusy = new Map();
  async function fetchRaw(url) {
    const r = await fetch(url, { headers: { "User-Agent": "nba-handicapper/0.2" } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  function cutBox(id, j) {
    const comp = ((j.header || {}).competitions || [])[0] || {}, cs = comp.competitors || [];
    const side = k => cs.find(c => c.homeAway === k) || {};
    const H = side("home"), A = side("away"), home = ab((H.team || {}).abbreviation), away = ab((A.team || {}).abbreviation);
    const out = { id: String(id), date: comp.date || null, home, away, hs: +H.score || 0, as: +A.score || 0, t: {}, p: {} };
    for (const tp of ((j.boxscore || {}).players || [])) {
      const team = ab((tp.team || {}).abbreviation), st = (tp.statistics || [])[0] || {}, keys = st.keys || [];
      const ix = k => keys.indexOf(k);
      const I = { min: ix("minutes"), pts: ix("points"), fg: ix("fieldGoalsMade-fieldGoalsAttempted"), tp: ix("threePointFieldGoalsMade-threePointFieldGoalsAttempted"),
        ft: ix("freeThrowsMade-freeThrowsAttempted"), reb: ix("rebounds"), ast: ix("assists"), tov: ix("turnovers"), stl: ix("steals"), blk: ix("blocks"), oreb: ix("offensiveRebounds") };
      const T = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], P = [];
      for (const a of st.athletes || []) {
        const s = a.stats || [], at = a.athlete || {};
        if (!s.length || a.didNotPlay) continue;
        const g = k => I[k] >= 0 ? s[I[k]] : null, fg = made(g("fg")), tq = made(g("tp")), ft = made(g("ft"));
        const m = mins(g("min")), pts = +g("pts") || 0, reb = +g("reb") || 0, ast = +g("ast") || 0, tov = +g("tov") || 0, oreb = +g("oreb") || 0;
        if (m <= 0 && !pts) continue;
        T[0] += pts; T[1] += fg[1]; T[2] += ft[1]; T[3] += oreb; T[4] += tov; T[5] += m; T[6] += fg[0]; T[7] += tq[0]; T[8] += tq[1]; T[9] += ft[0]; T[10] += reb; T[11] += ast;
        P.push([String(at.id || ""), at.displayName || at.shortName || "", ((at.position || {}).abbreviation) || "", a.starter ? 1 : 0, r1(m), pts, reb, ast, tq[0], +g("stl") || 0, +g("blk") || 0, tov, fg[1], ft[1]]);
      }
      if (team && P.length) { out.t[team] = T.map(r1); out.p[team] = P; }
    }
    if (!out.t[home] || !out.t[away]) return null;
    return out;
  }
  async function box(id) {
    id = String(id);
    if (BOX.has(id)) return BOX.get(id);
    if (boxBusy.has(id)) return boxBusy.get(id);
    const p = (async () => {
      try { const b = cutBox(id, await fetchRaw(`${SITE}/summary?event=${id}`)); if (b) BOX.set(id, b); return b; }
      finally { boxBusy.delete(id); }
    })();
    boxBusy.set(id, p);
    return p;
  }
  const poss = t => t[1] - t[3] + t[4] + .44 * t[2];   // possessions = FGA - OREB + TOV + 0.44 x FTA

  // ---------- league: every team's games this season, built in the background ----------
  const LG = { yr: null, at: 0, games: 0, teams: {}, rtg: LG_RTG, pace: LG_PACE, busy: null, ready: false };
  function rate(list, abbr) {   // a team's per-100 ratings and pace from its box scores
    let pf = 0, pa = 0, ps = 0, mn = 0, n = 0;
    for (const b of list) {
      const me = b.t[abbr], op = b.t[abbr === b.home ? b.away : b.home];
      if (!me || !op) continue;
      const p = (poss(me) + poss(op)) / 2, m = me[5] || 240;
      pf += me[0]; pa += op[0]; ps += p; mn += m; n++;
    }
    return n ? { n, ortg: 100 * pf / ps, drtg: 100 * pa / ps, pace: ps * 240 / mn, ppg: pf / n, oppg: pa / n } : { n: 0 };
  }
  async function seasonIds(yr) {   // finished regular-season games this season, by team
    const by = {};
    await pool(Object.keys(IDS), 6, async a => {
      const gs = await teamGames(IDS[a], yr);
      by[a] = gs.filter(g => g.done && !g.playoff).map(g => String(g.id));
    });
    return by;
  }
  async function buildLeague(yr) {
    if (LG.busy) return LG.busy;
    LG.busy = (async () => {
      try {
        const by = await seasonIds(yr), ids = [...new Set(Object.values(by).flat())];
        await pool(ids, 4, id => box(id));
        const teams = {};
        let pts = 0, ps = 0, mn = 0;
        for (const a of Object.keys(IDS)) {
          const list = (by[a] || []).map(id => BOX.get(id)).filter(Boolean);
          teams[a] = rate(list, a);
          for (const b of list) if (b.home === a) for (const k of [b.home, b.away]) { const t = b.t[k], o = b.t[k === b.home ? b.away : b.home]; pts += t[0]; ps += (poss(t) + poss(o)) / 2; mn += t[5] || 240; }
        }
        Object.assign(LG, { yr, at: Date.now(), teams, games: ids.length, ready: true,
          rtg: ps > 2000 ? 100 * pts / ps : LG_RTG, pace: ps > 2000 ? ps * 240 / mn : LG_PACE });
        // ranks: 1 = best
        const rk = (k, low) => Object.keys(teams).filter(a => teams[a].n).sort((x, y) => low ? teams[x][k] - teams[y][k] : teams[y][k] - teams[x][k]).forEach((a, i) => (teams[a].rk = teams[a].rk || {})[k] = i + 1);
        Object.values(teams).forEach(t => { if (t.n) t.net = t.ortg - t.drtg; });
        rk("ortg"); rk("drtg", true); rk("pace"); rk("net");
      } catch (e) { console.error("league build:", e.message); }
      finally { LG.busy = null; }
      return LG;
    })();
    return LG.busy;
  }
  async function league(yr, waitMs) {   // fresh within 30 min; otherwise rebuild (wait up to waitMs for it)
    if (LG.yr === yr && Date.now() - LG.at < 1800e3) return LG;
    const p = buildLeague(yr);
    if (!LG.ready || LG.yr !== yr) await Promise.race([p, new Promise(r => setTimeout(r, waitMs || 25000))]);
    return LG;
  }

  // ---------- a team's recent box scores (this season, topped up with the end of last season for player values) ----------
  async function teamBoxes(abbr, yr, want = 20) {
    const id = IDS[abbr]; if (!id) return { cur: [], prev: [] };
    const [c, p] = await Promise.all([teamGames(id, yr), teamGames(id, yr - 1)]);
    const curIds = c.filter(g => g.done && !g.playoff).map(g => g.id).reverse();   // newest first
    const prevIds = curIds.length >= want ? [] : p.filter(g => g.done && !g.playoff).map(g => g.id).reverse().slice(0, want - curIds.length);
    const [cur, prev] = await Promise.all([pool(curIds, 4, box), pool(prevIds, 4, box)]);
    return { cur: cur.filter(Boolean), prev: prev.filter(Boolean) };
  }
  // per-player averages; value = pts + .7 ast + .35 reb + stl + blk - .7 tov
  function players(abbr, cur, prev) {
    const P = {};
    const add = (b, isCur) => (b.p[abbr] || []).forEach(x => {
      const q = P[x[0]] || (P[x[0]] = { id: x[0], name: x[1], pos: x[2], gC: 0, gP: 0, st: 0, min: 0, pts: 0, reb: 0, ast: 0, tpm: 0, stl: 0, blk: 0, tov: 0, n: 0, wMin: 0 });
      if (isCur) q.gC++; else q.gP++;
      const w = isCur ? 1 : .6;   // last season's games count a bit less
      q.n += w; q.min += w * x[4]; q.pts += w * x[5]; q.reb += w * x[6]; q.ast += w * x[7]; q.tpm += w * x[8]; q.stl += w * x[9]; q.blk += w * x[10]; q.tov += w * x[11];
      if (x[3]) q.st++;
      if (!q.pos && x[2]) q.pos = x[2];
    });
    cur.forEach(b => add(b, true)); prev.forEach(b => add(b, false));
    for (const q of Object.values(P)) {
      for (const k of ["min", "pts", "reb", "ast", "tpm", "stl", "blk", "tov"]) q[k] = r1(q[k] / q.n);
      q.value = r1(q.pts + .7 * q.ast + .35 * q.reb + q.stl + q.blk - .7 * q.tov);
      // points of margin he's worth over a replacement playing his minutes
      q.impact = r1(cl(.35 * (q.value - .42 * q.min), 0, 8));
      delete q.n; delete q.wMin;
    }
    return P;
  }

  // ---------- injuries (from the game's ESPN summary) ----------
  const stKey = s => { s = String(s || "").toLowerCase(); return /suspen/.test(s) ? "suspension" : /out/.test(s) ? "out" : /doubt/.test(s) ? "doubtful" : /question/.test(s) ? "questionable" : /day/.test(s) ? "day-to-day" : /probable/.test(s) ? "probable" : s || "out"; };
  async function injuries(eventId, abbrs) {
    const out = {}; abbrs.forEach(a => out[a] = []);
    let j = null;
    try { j = await getJSON(`${SITE}/summary?event=${eventId}`, 600); } catch (e) { return { list: out, ok: false }; }
    for (const t of j.injuries || []) {
      const tm = t.team || {}, a = ab(tm.abbreviation) || abbrs.find(x => IDS[x] === +tm.id);
      if (!a || !out[a]) continue;
      for (const x of t.injuries || []) {
        const at = x.athlete || {}, d = x.details || {}, fs = (d.fantasyStatus || {}).description;
        const status = x.status || fs || (x.type || {}).description || "Out";
        out[a].push({ id: String(at.id || ""), name: at.displayName || at.shortName || "", pos: ((at.position || {}).abbreviation) || "",
          status, key: stKey(status), detail: [d.type, d.detail, d.side && d.side !== "Not Specified" ? d.side : null].filter(Boolean).join(", ") || x.shortComment || "",
          note: x.shortComment || x.longComment || "", ret: d.returnDate || null, img: (at.headshot || {}).href || null });
      }
    }
    return { list: out, ok: true };
  }

  // ---------- projected starters: last game's starting five, injured players swapped for the next man up ----------
  const grp = p => /C/.test(p) ? "C" : /F/.test(p) ? "F" : "G";
  function lineup(abbr, cur, prev, P, inj) {
    const last = cur[0] || prev[0], injBy = {};
    (inj || []).forEach(x => { injBy[x.id] = x; injBy["n:" + x.name.toLowerCase()] = x; });
    const flag = q => injBy[q.id] || injBy["n:" + String(q.name).toLowerCase()];
    const outish = q => { const f = flag(q); return f && ["out", "suspension", "doubtful"].includes(f.key); };
    const card = (q, extra) => { const f = flag(q); return { id: q.id, name: q.name, pos: q.pos, min: q.min, pts: q.pts, reb: q.reb, ast: q.ast, tpm: q.tpm, value: q.value, impact: q.impact, gp: q.gC, ...(f ? { inj: f.key, injLabel: f.status, injNote: f.detail || f.note } : {}), ...(extra || {}) }; };
    if (!last) return { starters: [], bench: [], last: null };
    const lastStart = (last.p[abbr] || []).filter(x => x[3]).map(x => P[x[0]] || { id: x[0], name: x[1], pos: x[2], min: x[4], pts: x[5], reb: x[6], ast: x[7], value: 0, impact: 0, gC: 0 });
    const others = Object.values(P).filter(q => !lastStart.some(s => s.id === q.id) && (cur.length ? q.gC >= 1 : q.gP >= 1)).sort((a, b) => b.min - a.min);
    const used = new Set(), starters = [];
    for (const s of lastStart) {
      if (!outish(s)) { starters.push(card(s)); used.add(s.id); continue; }
      starters.push(card(s, { out: true }));   // shown crossed out, replaced by the next man up at his position
      const rep = others.find(q => !used.has(q.id) && !outish(q) && grp(q.pos) === grp(s.pos)) || others.find(q => !used.has(q.id) && !outish(q));
      if (rep) { used.add(rep.id); starters.push(card(rep, { sub: true, for: s.name })); }
    }
    const bench = others.filter(q => !used.has(q.id) && q.gC >= 1).slice(0, 5).map(q => card(q));
    const opp = last.home === abbr ? last.away : last.home;
    return { starters, bench, last: { date: last.date ? etDate(last.date) : null, opp, home: last.home === abbr, thisSeason: !!cur[0] } };
  }
  // injury cost in points of margin. A player who has missed most of the season is already priced into the team's numbers,
  // so his cost is scaled by how much of the (blended) sample he played in.
  function injCost(abbr, inj, P, teamGP) {
    let raw = 0; const rows = [];
    for (const x of inj || []) {
      const q = P[x.id] || Object.values(P).find(p => p.name.toLowerCase() === x.name.toLowerCase());
      const w = ST_W[x.key] != null ? ST_W[x.key] : .5;
      if (!q) { rows.push({ ...x, impact: 0, cost: 0, why: "No recent minutes" }); continue; }
      const share = (q.gC + K_TEAM * (q.gP ? 1 : 0)) / ((teamGP || 0) + K_TEAM);   // how much he's in the numbers the model uses
      const cost = q.impact * w * cl(share, 0, 1);
      raw += cost;
      rows.push({ ...x, min: q.min, pts: q.pts, reb: q.reb, ast: q.ast, impact: q.impact, weight: w, share: r2(cl(share, 0, 1)), cost: r1(cost) });
    }
    const total = 15 * (1 - Math.exp(-raw / 15));   // several missing players hurt, but not in a straight line
    return { pts: r1(total), rows: rows.sort((a, b) => (b.cost || 0) - (a.cost || 0)) };
  }

  // ---------- rest and travel ----------
  const miles = (a, b) => {
    if (!a || !b) return 0;
    const rad = x => x * Math.PI / 180, dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * 3958.8 * Math.asin(Math.sqrt(h)));
  };
  function fatigue(all, abbr, site, date) {   // higher = more tired; site = arena of tonight's game
    const gs = all.filter(g => g.done && etDate(g.date) < date).sort((a, b) => b.date.localeCompare(a.date));
    if (!gs.length) return { score: 0, grade: "A", days: null, miles: 0, tz: 0, trip: 0, games5: 0, notes: ["First game of the season"] };
    const day = 864e5, d0 = Date.parse(date + "T12:00:00Z"), dd = g => Math.round((d0 - Date.parse(etDate(g.date) + "T12:00:00Z")) / day);
    const st = g => ab(g.home), last = gs[0], days = dd(last), from = GEO[st(last)], to = GEO[site];
    const leg = miles(from, to), tz = from && to ? to[2] - from[2] : 0;
    let trip = 0; for (const g of gs) { if (st(g) === abbr) break; trip++; }
    const away = site !== abbr, in4 = gs.filter(g => dd(g) <= 3).length, in6 = gs.filter(g => dd(g) <= 5).length;
    const rec = days <= 1 ? 1 : days === 2 ? .7 : days === 3 ? .4 : .2;
    let sc = 0; const notes = [];
    if (days === 1) { sc += 1.5; notes.push("Played yesterday (back-to-back)"); }
    if (in4 >= 2) { sc += .75; notes.push("3rd game in 4 nights"); }
    if (in6 >= 3 && in4 < 2) { sc += .4; notes.push("4th game in 6 nights"); }
    sc += Math.min(1.5, leg / 1500) * rec;
    sc += (Math.abs(tz) >= 2 ? .6 : Math.abs(tz) === 1 ? .2 : 0) * (tz > 0 ? 1.25 : 1) * rec;   // flying east is harder
    if (away && trip >= 3) sc += Math.min(.75, .25 * (trip - 2));
    if (away && HIGH[site] && days <= 1) { sc += .5; notes.push(`Altitude in ${site === "DEN" ? "Denver" : "Utah"} on no rest`); }
    if (days >= 3) { sc -= .25; notes.push(`${days - 1} days of rest`); }
    if (leg >= 500) notes.push(`About ${leg} mi from ${st(last)}` + (tz ? `, ${Math.abs(tz)} time zone${Math.abs(tz) > 1 ? "s" : ""} ${tz > 0 ? "east" : "west"}` : ""));
    if (!away && trip >= 1) notes.push(`Home after a ${trip}-game road trip`); else if (away && trip >= 1) notes.push(`Game ${trip + 1} of a road trip`);
    if (!notes.length) notes.push(days === 2 ? "1 day of rest" : "Normal rest");
    sc = Math.max(0, sc);
    return { score: r2(sc), grade: sc < .5 ? "A" : sc < 1.25 ? "B" : sc < 2 ? "C" : sc < 2.75 ? "D" : "F", days, miles: leg, tz, trip, games4: in4 + 1, notes };
  }

  // ---------- the game model ----------
  const Phi = z => { const t = 1 / (1 + .2316419 * Math.abs(z)), d = .3989423 * Math.exp(-z * z / 2), p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  const dec = a => a > 0 ? 1 + a / 100 : 1 + 100 / -a, imp = a => a == null ? null : 1 / dec(a);
  const noVig = (a, b) => { const x = imp(a), y = imp(b); return x != null && y != null ? x / (x + y) : null; };
  function teamRates(abbr, lg, tb) {   // this season's rates pulled toward last season (points vs league) or league average
    const t = lg.teams[abbr] || { n: 0 }, s = (tb.T || {})[abbr] || {}, prevOff = s.pfPrev && tb.lgPrev ? s.pfPrev / tb.lgPrev : 1, prevDef = s.paPrev && tb.lgPrev ? s.paPrev / tb.lgPrev : 1;
    const n = t.n || 0, off = n ? t.ortg / lg.rtg : 1, def = n ? t.drtg / lg.rtg : 1, pace = n ? t.pace / lg.pace : 1;
    return { n, off: (n * off + K_TEAM * prevOff) / (n + K_TEAM), def: (n * def + K_TEAM * prevDef) / (n + K_TEAM), pace: (n * pace + K_PACE) / (n + K_PACE),
      ortg: n ? r1(t.ortg) : null, drtg: n ? r1(t.drtg) : null, paceRaw: n ? r1(t.pace) : null, net: n ? r1(t.ortg - t.drtg) : null, rk: t.rk || {}, prevW: r2(K_TEAM / (n + K_TEAM)) };
  }
  function project(g, lg, tb, fat, inj) {
    const H = teamRates(g.home.abbr, lg, tb), A = teamRates(g.away.abbr, lg, tb);
    const possG = lg.pace * H.pace * A.pace, base = lg.rtg / 100 * possG;
    let ph = base * H.off * A.def, pa = base * A.off * H.def;
    const hca = g.neutral ? 0 : HCA;
    const restEdge = cl(REST_PTS * ((fat.away.score || 0) - (fat.home.score || 0)), -REST_CAP, REST_CAP);   // + = home fresher
    const injH = inj.home.pts || 0, injA = inj.away.pts || 0;
    ph += hca / 2 + restEdge / 2 - .6 * injH + .4 * injA;
    pa += -hca / 2 - restEdge / 2 - .6 * injA + .4 * injH;
    return { home: r1(ph), away: r1(pa), margin: r1(ph - pa), total: r1(ph + pa), poss: r1(possG), rates: { home: H, away: A },
      adj: { hca, rest: r1(restEdge), injHome: injH, injAway: injA, base: { home: r1(base * H.off * A.def), away: r1(base * A.off * H.def) } } };
  }
  // chances, edges, signals and leans (same shape as the hockey matchup's best bet / inclinations)
  function bets(g, pj, ctx) {
    const o = g.odds || {}, H = g.home.abbr, W = g.away.abbr, M = pj.margin, T = pj.total, out = [];
    const sideSig = s => {   // +1 helps team s
      const me = s === "home" ? H : W, op = s === "home" ? W : H, sig = [];
      const R = pj.rates[s], Ro = pj.rates[s === "home" ? "away" : "home"];
      if (R.net != null && Ro.net != null && R.n >= 3 && Ro.n >= 3 && Math.abs(R.net - Ro.net) >= 4) sig.push({ d: R.net > Ro.net ? 1 : -1, t: `Net rating ${R.net > 0 ? "+" : ""}${R.net} vs ${Ro.net > 0 ? "+" : ""}${Ro.net}` });
      const fm = ctx.fat[s], fo = ctx.fat[s === "home" ? "away" : "home"];
      if (Math.abs(fm.score - fo.score) >= 1) sig.push({ d: fm.score < fo.score ? 1 : -1, t: `Rest/travel: ${fm.score < fo.score ? me : op} fresher` });
      const im = ctx.inj[s].pts, io = ctx.inj[s === "home" ? "away" : "home"].pts;
      if (Math.abs(im - io) >= 2) sig.push({ d: im < io ? 1 : -1, t: `Injuries: ${im < io ? op : me} missing more (${r1(Math.max(im, io))} pts)` });
      const f = ctx.form[s], fo2 = ctx.form[s === "home" ? "away" : "home"];
      if (f && fo2 && f.l10net != null && fo2.l10net != null && Math.abs(f.l10net - fo2.l10net) >= 5) sig.push({ d: f.l10net > fo2.l10net ? 1 : -1, t: `Last 10 margin ${f.l10net > 0 ? "+" : ""}${f.l10net} vs ${fo2.l10net > 0 ? "+" : ""}${fo2.l10net}` });
      return sig;
    };
    const totSig = L => {
      const sig = [], R = pj.rates;
      if (R.home.paceRaw && R.away.paceRaw && R.home.n >= 3 && R.away.n >= 3) {
        const fast = R.home.rk.pace <= 8 && R.away.rk.pace <= 8, slow = R.home.rk.pace >= 23 && R.away.rk.pace >= 23;
        if (fast) sig.push({ d: 1, t: "Both teams play fast (top-8 pace)" }); if (slow) sig.push({ d: -1, t: "Both teams play slow (bottom-8 pace)" });
      }
      const ho = ctx.h2h.filter(r => r.close != null).slice(0, 6);
      if (ho.length >= 3) { const ov = ho.filter(r => r.total > L).length / ho.length; if (ov >= .67 || ov <= .33) sig.push({ d: ov >= .67 ? 1 : -1, t: `Head-to-head: over ${L} in ${ho.filter(r => r.total > L).length} of ${ho.length}` }); }
      if ((ctx.fat.home.days === 1) && (ctx.fat.away.days === 1)) sig.push({ d: -1, t: "Both teams on a back-to-back (tired legs, missed shots)" });
      const injT = ctx.inj.home.pts + ctx.inj.away.pts; if (injT >= 6) sig.push({ d: -1, t: `${r1(injT)} pts of scorers out between the two teams` });
      return sig;
    };
    const add = (type, s, label, short, model, fair, price, sig, extra) => {
      if (model == null) return;
      const p = fair != null ? .5 * model + .5 * fair : model, im = imp(price), edge = im != null ? p - im : null, net = sig.reduce((t, x) => t + x.d, 0);
      out.push({ type, side: s, label, short, model: r3(model), fair: fair != null ? r3(fair) : null, p: r3(p), price: price != null ? price : null,
        edge: edge != null ? r3(edge) : null, ev: price != null ? r3(p * dec(price) - 1) : null, net, signals: sig, score: edge != null ? r2(edge * 100 + 1.5 * net) : null, ...(extra || {}) });
    };
    const sH = sideSig("home"), sA = sideSig("away");
    const pHome = Phi(M / SD_MARGIN);
    add("ml", "home", `${H} moneyline`, `${H} ML`, pHome, o.home && o.away ? noVig(o.home.ml, o.away.ml) : null, o.home && o.home.ml, sH);
    add("ml", "away", `${W} moneyline`, `${W} ML`, 1 - pHome, o.home && o.away ? noVig(o.away.ml, o.home.ml) : null, o.away && o.away.ml, sA);
    for (const s of ["home", "away"]) {
      const q = o[s] && o[s].spread; if (!q || q.point == null) continue;
      const myM = s === "home" ? M : -M, pc = Phi((myM + q.point) / SD_MARGIN), other = o[s === "home" ? "away" : "home"].spread;
      add("spread", s, `${s === "home" ? H : W} ${q.point > 0 ? "+" : ""}${q.point}`, `${s === "home" ? H : W} ${q.point > 0 ? "+" : ""}${q.point}`, pc,
        other ? noVig(q.price, other.price) : null, q.price, s === "home" ? sH : sA, { point: q.point });
    }
    if (o.total && o.total.point != null) {
      const L = o.total.point, ts = totSig(L), pO = 1 - Phi((L - T) / SD_TOTAL);
      add("total", "over", `${W} @ ${H} Over ${L}`, `O ${L}`, pO, noVig(o.total.over, o.total.under), o.total.over, ts, { line: L });
      add("total", "under", `${W} @ ${H} Under ${L}`, `U ${L}`, 1 - pO, noVig(o.total.under, o.total.over), o.total.under, ts.map(x => ({ ...x, d: -x.d })), { line: L });
    }
    // leans: what the data says without prices; strength = distance from a coin flip (pts) + 2 x net signals
    const band = x => x >= 15 ? "Strong" : x >= 8 ? "Moderate" : x >= 3 ? "Slight" : "Toss-up";
    const wS = pHome >= .5 ? "home" : "away", pW = wS === "home" ? pHome : 1 - pHome, wSig = wS === "home" ? sH : sA, wNet = wSig.reduce((t, x) => t + x.d, 0);
    const spr = o.home && o.home.spread ? o.home.spread.point : null;   // home spread
    let ats = null;
    if (spr != null) { const pcH = Phi((M + spr) / SD_MARGIN), s = pcH >= .5 ? "home" : "away", pp = s === "home" ? pcH : 1 - pcH, sg = s === "home" ? sH : sA, nt = sg.reduce((t, x) => t + x.d, 0), sc = r2((pp - .5) * 100 + 2 * nt);
      ats = { side: s, abbr: s === "home" ? H : W, point: s === "home" ? spr : -spr, p: r3(pp), modelLine: r1(-M), net: nt, signals: sg, score: sc, strength: band(sc) }; }
    const RL = o.total && o.total.point != null ? o.total.point : null;
    let tot = null;
    if (RL != null) { const pO = 1 - Phi((RL - T) / SD_TOTAL), pick = pO >= .5 ? "over" : "under", pp = pick === "over" ? pO : 1 - pO, sg = totSig(RL).map(x => ({ ...x, d: pick === "over" ? x.d : -x.d })), nt = sg.reduce((t, x) => t + x.d, 0), sc = r2((pp - .5) * 100 + 2 * nt);
      tot = { pick, line: RL, xTotal: T, p: r3(pp), net: nt, signals: sg, score: sc, strength: band(sc) }; }
    const wScore = r2((pW - .5) * 100 + 2 * wNet);
    const lean = { winner: { side: wS, abbr: wS === "home" ? H : W, p: r3(pW), net: wNet, signals: wSig, score: wScore, strength: band(wScore),
      underdog: o.home && o.away && o.home.ml != null && o.away.ml != null ? (wS === "home" ? o.home.ml > o.away.ml : o.away.ml > o.home.ml) : false }, spread: ats, total: tot };
    const ok = out.filter(b => b.edge != null && b.edge > 0 && b.p >= .52 && b.price != null && b.price >= -250).sort((a, b) => b.score - a.score);
    const best = ok[0] ? { ...ok[0], strength: ok[0].score >= 6 ? "Strong" : ok[0].score >= 3 ? "Solid" : "Lean" } : null;
    return { bets: out, best, lean };
  }

  // ---------- everything the matchup page needs from the model ----------
  async function analyse(g, date, tb, h2h, form) {
    const yr = seasonYr(new Date(date + "T12:00:00Z")), H = g.home.abbr, A = g.away.abbr;
    const [lg, bh, ba, sh, sa, inj] = await Promise.all([league(yr, 20000), teamBoxes(H, yr), teamBoxes(A, yr),
      IDS[H] ? teamGames(IDS[H], yr) : [], IDS[A] ? teamGames(IDS[A], yr) : [], injuries(g.id, [H, A])]);
    const site = H;   // neutral-site games (Mexico City, Paris...) are treated as at the home team's arena
    const fat = { home: fatigue(sh, H, site, date), away: fatigue(sa, A, site, date) };
    const PH = players(H, bh.cur, bh.prev), PA = players(A, ba.cur, ba.prev);
    const ic = { home: injCost(H, inj.list[H], PH, bh.cur.length), away: injCost(A, inj.list[A], PA, ba.cur.length) };
    const pj = project(g, lg, tb, fat, ic);
    const b = bets(g, pj, { fat, inj: ic, form, h2h });
    const d = fat.home.score - fat.away.score, m = Math.abs(d);
    return {
      model: { ...pj, ...b, league: { rtg: r1(lg.rtg), pace: r1(lg.pace), games: lg.games, ready: lg.ready }, sd: { margin: SD_MARGIN, total: SD_TOTAL } },
      lineups: { home: lineup(H, bh.cur, bh.prev, PH, inj.list[H]), away: lineup(A, ba.cur, ba.prev, PA, inj.list[A]) },
      injuries: { ok: inj.ok, home: ic.home, away: ic.away },
      sched: { home: fat.home, away: fat.away, edge: m >= 1 ? { team: d > 0 ? A : H, tired: d > 0 ? H : A, size: m >= 2 ? "notable" : "slight", pts: r1(Math.min(REST_CAP, REST_PTS * m)) } : null }
    };
  }

  // box-score cache in/out, so the tracker can keep it between runs
  const dumpBoxes = () => Object.fromEntries(BOX), loadBoxes = o => { for (const [k, v] of Object.entries(o || {})) if (v && v.t) BOX.set(k, v); return BOX.size; };
  return { analyse, league, box, dumpBoxes, loadBoxes, IDS, GEO };
};
