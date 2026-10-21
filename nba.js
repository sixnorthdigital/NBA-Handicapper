// NBA side of the app (stage 1: game cards with odds, and the matchup page with team form and 2-year head-to-head).
// Data comes from ESPN's public feeds, which work from Render (the official NBA stats site often blocks cloud servers):
//   scoreboard  -> today's games, live scores and DraftKings lines (no Odds API credits used)
//   schedules   -> every team's results, for form, rest and head-to-head
//   standings   -> points for / against per game, home and road records
//   core odds   -> the closing spread and total of past games, so head-to-head shows results against the spread and the total
// Kept apart from the hockey code: if anything here breaks, the NHL side keeps working.
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const STAND = "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";

module.exports = ({ getJSON, r2 }) => {
  // ESPN names a season by the year it ends: October 2026 is the 2027 season (2026-27)
  const seasonYr = d => { const y = d.getUTCFullYear(); return d.getUTCMonth() >= 8 ? y + 1 : y; };
  const etDate = iso => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  // "-115", "+105", "EVEN", "o221.5", "u221.5", 221.5 -> number
  const num = v => {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isNaN(v) ? null : v;
    const s = String(v).trim().toUpperCase();
    if (s === "EVEN" || s === "EV") return 100;
    const n = parseFloat(s.replace(/^[OU]/, ""));
    return isNaN(n) ? null : n;
  };
  const badAbbr = a => { if (!/^[A-Z]{2,4}$/.test(a || "")) { const e = new Error("Bad team"); e.code = 400; throw e; } };
  async function pool(items, n, fn) {   // run fn over items with at most n requests in flight
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } }));
    return out;
  }

  // ---------- lines from the scoreboard (DraftKings; closing line once it closes, opening line before) ----------
  function lines(c) {
    const o = (c.odds || [])[0];
    if (!o) return null;
    const pick = x => x && (x.close || x.current || x.open);
    const ml = s => { const x = pick(o.moneyline && o.moneyline[s]); return num(x ? x.odds : (o[s + "TeamOdds"] || {}).moneyLine); };
    const sp = s => {
      const x = pick(o.pointSpread && o.pointSpread[s]);
      const p = x ? num(x.line) : o.spread != null ? (s === "home" ? num(o.spread) : -num(o.spread)) : null;   // o.spread is the home team's spread
      return p == null ? null : { point: p, price: x ? num(x.odds) : num((o[s + "TeamOdds"] || {}).spreadOdds) };
    };
    const ov = pick(o.total && o.total.over), un = pick(o.total && o.total.under), tp = ov ? num(ov.line) : num(o.overUnder);
    return { book: (o.provider && o.provider.name) || "DraftKings",
      home: { ml: ml("home"), spread: sp("home") }, away: { ml: ml("away"), spread: sp("away") },
      total: tp == null ? null : { point: tp, over: ov ? num(ov.odds) : num(o.overOdds), under: un ? num(un.odds) : num(o.underOdds) } };
  }

  // ---------- today's games ----------
  async function games(date) {
    const j = await getJSON(`${SITE}/scoreboard?dates=${date.replace(/-/g, "")}`, 60);
    return (j.events || []).map(ev => {
      const c = (ev.competitions || [])[0] || {}, st = c.status || ev.status || {}, ty = st.type || {};
      const side = s => {
        const x = (c.competitors || []).find(k => k.homeAway === s) || {}, t = x.team || {};
        const rec = (x.records || []).find(r => r.type === "total" || /overall/i.test(r.name || ""));
        return { id: t.id, abbr: t.abbreviation, name: t.displayName, logo: t.logo, record: rec ? rec.summary : null,
          score: x.score == null || x.score === "" ? null : +(typeof x.score === "object" ? x.score.value : x.score) };
      };
      const home = side("home"), away = side("away");
      const state = ty.state === "in" ? "LIVE" : ty.state === "post" ? (ty.completed ? "FINAL" : "PPD") : "FUT";
      return { id: ev.id, start: ev.date, state, neutral: !!c.neutralSite, note: ((c.notes || [])[0] || {}).headline || null,
        live: state === "LIVE" ? { home: home.score || 0, away: away.score || 0, period: st.period, clock: st.displayClock, detail: ty.shortDetail, half: /HALFTIME/.test(ty.name || "") } : null,
        home, away, odds: lines(c) };
    }).filter(g => g.home.abbr && g.away.abbr).sort((a, b) => a.start.localeCompare(b.start));
  }

  // ---------- team results ----------
  async function teamGames(id, yr) {   // regular season + playoffs, oldest first
    const ttl = yr >= seasonYr(new Date()) ? 1800 : 86400;
    const get = t => getJSON(`${SITE}/teams/${id}/schedule?season=${yr}&seasontype=${t}`, ttl).catch(() => ({ events: [] }));
    const [r, p] = await Promise.all([get(2), get(3)]);
    return [...(r.events || []), ...(p.events || [])].map(ev => {
      const c = (ev.competitions || [])[0] || {}, ty = (c.status || {}).type || {};
      const s = k => (c.competitors || []).find(x => x.homeAway === k) || {};
      const sc = x => x.score == null ? null : +(typeof x.score === "object" ? x.score.value : x.score);
      const H = s("home"), A = s("away");
      return { id: ev.id, date: ev.date, done: !!ty.completed, playoff: (ev.seasonType || {}).type === 3,
        home: (H.team || {}).abbreviation, away: (A.team || {}).abbreviation, hs: sc(H), as: sc(A) };
    }).filter(g => g.home && g.away).sort((a, b) => a.date.localeCompare(b.date));
  }

  // closing spread (home team's) and total of a past game
  async function closeLine(id) {
    const j = await getJSON(`${CORE}/events/${id}/competitions/${id}/odds`, 7 * 86400).catch(() => null);
    const it = ((j && j.items) || []).find(x => x.spread != null || x.overUnder != null);
    return it ? { spread: num(it.spread), total: num(it.overUnder), book: it.provider && it.provider.name } : null;
  }

  // ---------- standings: points for / against, blended with last season early on ----------
  // Last season's weight falls in a straight line from 100% at 0 games to 0% at PREV_GP games (5 GP 75%, 10 GP 50%, 20 GP 0%).
  const PREV_GP = 20;
  async function table(yr) {
    const grab = y => getJSON(`${STAND}?season=${y}`, y >= yr ? 1800 : 86400).catch(() => ({}));
    const read = j => {
      const out = {};
      (j.children || []).forEach(cf => ((cf.standings || {}).entries || []).forEach(e => {
        const st = {}, sm = {};
        (e.stats || []).forEach(s => { const k = (s.type || s.name || "").toLowerCase(); st[k] = s.value; sm[k] = s.summary || s.displayValue; });
        const t = e.team || {};
        if (t.abbreviation) out[t.abbreviation] = { name: t.displayName, w: st.wins || 0, l: st.losses || 0, pf: st.avgpointsfor, pa: st.avgpointsagainst,
          home: sm.home || null, road: sm.road || null, l10: sm.lasttengames || null };
      }));
      return out;
    };
    const [c, p] = await Promise.all([grab(yr), grab(yr - 1)]), cur = read(c), prev = read(p);
    const T = {};
    for (const ab of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      const x = cur[ab] || { w: 0, l: 0 }, q = prev[ab], gp = x.w + x.l, w = q ? Math.max(0, 1 - gp / PREV_GP) : 0;
      const mix = k => gp && x[k] != null ? (q && q[k] != null ? (1 - w) * x[k] + w * q[k] : x[k]) : q ? q[k] : null;
      T[ab] = { ...x, gp, prevW: r2(gp ? w : q ? 1 : 0), pf: mix("pf"), pa: mix("pa"), pfNow: gp ? x.pf : null, paNow: gp ? x.pa : null };
    }
    const rank = (k, low) => { const ks = Object.keys(T).filter(a => T[a][k] != null).sort((a, b) => low ? T[a][k] - T[b][k] : T[b][k] - T[a][k]); ks.forEach((a, i) => T[a]["r" + k] = i + 1); };
    Object.values(T).forEach(t => t.net = t.pf != null && t.pa != null ? t.pf - t.pa : null);
    rank("pf"); rank("pa", true); rank("net");
    return { T, n: Object.keys(T).length };
  }
  const grade = (r, n) => { const x = r / (n || 30); return x <= .134 ? "A" : x <= .334 ? "B" : x <= .667 ? "C" : x <= .867 ? "D" : "F"; };
  function teamCard(tb, me, opp) {   // rank 1 = best; facing a weak defence / offence pushes the grade up
    const t = tb.T[me] || {}, o = tb.T[opp] || {}, n = tb.n || 30;
    const off = t.rpf && o.rpa ? (t.rpf + (n + 1 - o.rpa)) / 2 : null, def = t.rpa && o.rpf ? (t.rpa + (n + 1 - o.rpf)) / 2 : null;
    return { gp: t.gp, prevW: t.prevW, home: t.home, road: t.road, l10: t.l10,
      pf: { perGame: t.pf != null ? r2(t.pf) : null, rank: t.rpf || null }, pa: { perGame: t.pa != null ? r2(t.pa) : null, rank: t.rpa || null },
      net: { perGame: t.net != null ? r2(t.net) : null, rank: t.rnet || null },
      offenseGrade: off ? grade(off, n) : "–", defenseGrade: def ? grade(def, n) : "–", overallGrade: off && def ? grade((off + def) / 2, n) : "–" };
  }

  // ---------- form and rest ----------
  function form(gs, abbr) {   // completed games, newest first
    const res = gs.map(g => { const h = g.home === abbr, me = h ? g.hs : g.as, op = h ? g.as : g.hs; return { w: me > op, me, op }; });
    let n = 0; while (n < res.length && res[n].w === res[0].w) n++;
    const l10 = res.slice(0, 10);
    return { streak: res.length ? (res[0].w ? "W" : "L") + n : "-", last5: res.slice(0, 5).map(r => r.w ? "W" : "L").join(" ") || "-",
      l10: l10.length ? `${l10.filter(r => r.w).length}-${l10.filter(r => !r.w).length}` : "-",
      l10pf: l10.length ? r2(l10.reduce((t, r) => t + r.me, 0) / l10.length) : null, l10pa: l10.length ? r2(l10.reduce((t, r) => t + r.op, 0) / l10.length) : null };
  }
  function rest(all, date) {   // days since the last game, back-to-back, 3 games in 4 nights
    const before = all.filter(g => etDate(g.date) < date).sort((a, b) => b.date.localeCompare(a.date));
    if (!before.length) return { days: null, b2b: false, threeInFour: false, note: "First game of the season" };
    const day = 864e5, d0 = Date.parse(date + "T12:00:00Z"), days = Math.round((d0 - Date.parse(etDate(before[0].date) + "T12:00:00Z")) / day);
    const in3 = before.filter(g => (d0 - Date.parse(etDate(g.date) + "T12:00:00Z")) / day <= 3).length;
    const b2b = days === 1, t34 = in3 >= 2;
    return { days, b2b, threeInFour: t34, last: etDate(before[0].date),
      note: b2b ? "Played yesterday (back-to-back)" + (t34 ? ", 3rd game in 4 nights" : "") : t34 ? "3rd game in 4 nights" : days >= 3 ? `${days - 1} days of rest` : days === 2 ? "1 day of rest" : "" };
  }

  // ---------- head-to-head over the last 2 years, with results against the closing spread and total ----------
  async function h2h(homeId, home, away, yr, todayTotal) {
    const cut = Date.now() - 2 * 365 * 864e5, seen = new Set(), list = [];
    for (const y of [yr, yr - 1, yr - 2]) for (const g of await teamGames(homeId, y))
      if (g.done && !seen.has(g.id) && (g.home === away || g.away === away) && Date.parse(g.date) >= cut) { seen.add(g.id); list.push(g); }
    list.sort((a, b) => b.date.localeCompare(a.date));
    const lines_ = await pool(list, 6, g => closeLine(g.id));
    return list.map((g, i) => {
      const L = lines_[i], meHome = g.home === home, me = meHome ? g.hs : g.as, op = meHome ? g.as : g.hs, total = g.hs + g.as;
      const mySpread = L && L.spread != null ? (meHome ? L.spread : -L.spread) : null, cover = mySpread == null ? null : me - op + mySpread;
      return { id: g.id, date: etDate(g.date), playoff: g.playoff, home: g.home, away: g.away, hs: g.hs, as: g.as, total, winner: g.hs > g.as ? g.home : g.away,
        spread: mySpread, ats: cover == null ? null : cover > 0 ? "W" : cover < 0 ? "L" : "P",   // today's home team against the spread
        close: L ? L.total : null, ou: L && L.total != null ? (total > L.total ? "Over" : total < L.total ? "Under" : "Push") : null,
        vsToday: todayTotal == null ? null : total > todayTotal ? "Over" : total < todayTotal ? "Under" : "Push" };
    });
  }

  // ---------- matchup ----------
  async function matchup(home, away, date) {
    badAbbr(home); badAbbr(away);
    const game = (await games(date)).find(g => g.home.abbr === home && g.away.abbr === away);
    if (!game) { const e = new Error("Game not found for that date"); e.code = 404; throw e; }
    const yr = seasonYr(new Date(date + "T12:00:00Z")), line = game.odds && game.odds.total ? game.odds.total.point : null;
    const [tb, hg, ag, hp, ap, hist] = await Promise.all([table(yr), teamGames(game.home.id, yr), teamGames(game.away.id, yr),
      teamGames(game.home.id, yr - 1), teamGames(game.away.id, yr - 1), h2h(game.home.id, home, away, yr, line)]);
    const done = (gs, prev) => { const a = gs.filter(g => g.done).reverse(); return a.length >= 5 || !prev ? a : a.concat(prev.filter(g => g.done && !g.playoff).reverse()); };
    const side = (abbr, opp, gs, prev) => {
      const d = done(gs, prev), cur = gs.filter(g => g.done).length;
      return { ...teamCard(tb, abbr, opp), ...form(d, abbr), formFromLast: cur < 5 && d.length > cur, rest: rest(gs, date) };
    };
    const sum = { games: hist.length, homeWins: hist.filter(r => r.winner === home).length, awayWins: hist.filter(r => r.winner === away).length,
      ats: ["W", "L", "P"].map(k => hist.filter(r => r.ats === k).length), overs: hist.filter(r => r.ou === "Over").length, unders: hist.filter(r => r.ou === "Under").length,
      avgTotal: hist.length ? r2(hist.reduce((t, r) => t + r.total, 0) / hist.length) : null };
    return { game, marketTotal: line, season: yr, teams: { home: side(home, away, hg, hp), away: side(away, home, ag, ap) }, h2h: hist, h2hSum: sum };
  }

  return { games, matchup };
};
