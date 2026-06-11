// ladder-scoring-routes.js — Ladder Scoring Season 5
// server.js: if (pathname.startsWith('/LadderScoring')) return ladderScoringRoutes(req, res, pathname, query, mongo, getSession, DATA_DIR);

const fs   = require('fs');
const path = require('path');
const { PLAYERS, COURTS, COURT_BONUS, WIN_PTS, MAX_GAMES, SEASON, TOTAL_WEEKS } = require('./LadderScoringConfig');

const DATA_FILE = 'ladder-scoring.json';

// ── Storage helpers ────────────────────────────────────────────────────────────

async function loadData(mongo, dataDir) {
  if (mongo) {
    const doc = await mongo.collection('ladderScoring').findOne({ _id: 'ladderScoring' });
    return doc ? doc.data : { men: {}, women: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, DATA_FILE), 'utf8'));
  } catch (e) {
    return { men: {}, women: {} };
  }
}

async function saveData(data, mongo, dataDir) {
  if (mongo) {
    await mongo.collection('ladderScoring').replaceOne(
      { _id: 'ladderScoring' },
      { _id: 'ladderScoring', data },
      { upsert: true }
    );
    return;
  }
  fs.writeFileSync(path.join(dataDir, DATA_FILE), JSON.stringify(data, null, 2));
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function calcPoints(court, wins, losses) {
  const bonus = COURT_BONUS[court] || 1;
  return wins * (WIN_PTS + bonus) + losses * bonus;
}

function calcStandings(leagueData, week) {
  // leagueData = { "1": { "1": { PlayerName: {wins,losses} }, "3": {...} }, "2": {...} }
  const totals = {}; // { PlayerName: { pts, wins, losses, games, weekPts:{} } }

  const weeks = week === 'cumulative'
    ? Object.keys(leagueData)
    : [String(week)];

  for (const w of weeks) {
    const weekData = leagueData[w] || {};
    for (const court of COURTS) {
      const courtData = weekData[String(court)] || {};
      for (const [player, scores] of Object.entries(courtData)) {
        if (!totals[player]) totals[player] = { pts: 0, wins: 0, losses: 0, games: 0, byWeek: {} };
        const wins   = scores.wins   || 0;
        const losses = scores.losses || 0;
        const pts    = calcPoints(court, wins, losses);
        totals[player].pts    += pts;
        totals[player].wins   += wins;
        totals[player].losses += losses;
        totals[player].games  += wins + losses;
        if (!totals[player].byWeek[w]) totals[player].byWeek[w] = 0;
        totals[player].byWeek[w] += pts;
      }
    }
  }

  return Object.entries(totals)
    .sort((a, b) => b[1].pts - a[1].pts)
    .map(([name, s], i) => ({ rank: i + 1, name, ...s }));
}

// ── Route handler ──────────────────────────────────────────────────────────────

module.exports = async function ladderScoringRoutes(req, res, pathname, query, mongo, getSession, dataDir) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const json = (d, c = 200) => {
    res.writeHead(c, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(d));
  };
  const html = (file) => {
    try {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(content);
    } catch (e) {
      res.writeHead(404); res.end('Page not found');
    }
  };
  const body = () => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

  // ── Serve HTML pages ─────────────────────────────────────────────────────────
  if ((pathname === '/LadderScoring' || pathname === '/LadderScoring/') && req.method === 'GET') {
    return html('ladder-scoring.html');
  }
  if (pathname === '/LadderScoring/admin' && req.method === 'GET') {
    return html('ladder-scoring-admin.html');
  }

  // ── API: GET standings ───────────────────────────────────────────────────────
  if (pathname === '/LadderScoring/api/standings' && req.method === 'GET') {
    const league = query.league === 'women' ? 'women' : 'men';
    const week   = query.week || 'cumulative';
    const data   = await loadData(mongo, dataDir);
    const standings = calcStandings(data[league] || {}, week);
    return json({ league, week, season: SEASON, standings });
  }

  // ── API: GET week data for admin ─────────────────────────────────────────────
  if (pathname === '/LadderScoring/api/week-data' && req.method === 'GET') {
    const league = query.league === 'women' ? 'women' : 'men';
    const week   = query.week || '1';
    const court  = query.court || '1';
    const data   = await loadData(mongo, dataDir);
    const courtData = (data[league]?.[week]?.[court]) || {};
    const players = PLAYERS[league].map(name => ({
      name,
      wins:   courtData[name]?.wins   || 0,
      losses: courtData[name]?.losses || 0,
    }));
    return json({ league, week, court, players });
  }

  // ── API: GET config (players list, courts, weeks) ────────────────────────────
  if (pathname === '/LadderScoring/api/config' && req.method === 'GET') {
    return json({ PLAYERS, COURTS, COURT_BONUS, WIN_PTS, MAX_GAMES, SEASON, TOTAL_WEEKS });
  }

  // ── API: POST save scores (admin only) ───────────────────────────────────────
  if (pathname === '/LadderScoring/api/save' && req.method === 'POST') {
    const session = await getSession(req);
    if (!session || session.role !== 'admin') {
      return json({ error: 'Admin required' }, 403);
    }
    const { league, week, court, scores } = JSON.parse(await body());
    // scores = { PlayerName: { wins, losses } }
    if (!['men', 'women'].includes(league)) return json({ error: 'Invalid league' }, 400);
    if (!COURTS.includes(Number(court)))    return json({ error: 'Invalid court' }, 400);
    if (Number(week) < 1 || Number(week) > TOTAL_WEEKS) return json({ error: 'Invalid week' }, 400);

    const data = await loadData(mongo, dataDir);
    if (!data[league])              data[league] = {};
    if (!data[league][week])        data[league][week] = {};
    if (!data[league][week][court]) data[league][week][court] = {};

    for (const [name, s] of Object.entries(scores)) {
      const wins   = Math.max(0, Math.min(MAX_GAMES, parseInt(s.wins)   || 0));
      const losses = Math.max(0, Math.min(MAX_GAMES, parseInt(s.losses) || 0));
      if (wins + losses > MAX_GAMES) {
        return json({ error: `${name}: max ${MAX_GAMES} games per week` }, 400);
      }
      if (wins + losses === 0) {
        delete data[league][week][court][name];
      } else {
        data[league][week][court][name] = { wins, losses };
      }
    }

    await saveData(data, mongo, dataDir);
    return json({ success: true });
  }

  res.writeHead(404); res.end('Not found');
};
