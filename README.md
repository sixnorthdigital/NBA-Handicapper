# NBA Handicapper

Test app for the NBA version of Celly, kept separate until the model is validated. Data comes from ESPN's public feeds.

- **Home:** game cards with DraftKings lines (via ESPN), live scores.
- **Matchup:** odds; the Celly model (projected score, model spread/total/win chance vs the market, how it was built); leans and best bet;
  offense vs defense (points per 100 possessions, pace, ranks); rest & travel (back-to-backs, 3-in-4, miles, time zones, road trips, altitude);
  team form; projected starting lineups and bench (last game's starters, injured players swapped for the next man up); injuries with their cost in points;
  2-year head-to-head against the spread and the total.

Model (`model.js`): offense vs defense at the expected pace, + home court (2.4), + rest/travel (0.7 pts per fatigue point, max 2.5), − injuries
(60% off the team's own score, 40% to the opponent). Early season, team rates are pulled toward last season (10 games of weight).
Chances use ±12.5 on the margin and ±18 on the total, blended 50/50 with the market's no-vig price. All of these are starting guesses to check against results.

The league table (every team's box scores) builds in the background at start-up and refreshes every 30 minutes.

Run locally: `npm start`, then open http://localhost:3000. Deploy on Render as a Node web service with start command `npm start`.
