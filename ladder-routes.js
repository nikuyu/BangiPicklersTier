// ladder-routes.js — Bangi Picklers Ladder League API
// Mount in server.js:
//   const ladderRoutes = require('./ladder-routes.js');
//   if (pathname.startsWith('/ladder')) return ladderRoutes(req, res, pathname, query, mongo, getSession);

const crypto = require('crypto');

const COURTS = [1, 3, 5, 7];
const COURT_BONUS = { 1: 8, 3: 5, 5: 3, 7: 1 };
const WIN_BONUS = 10;
const TOTAL_WEEKS = 4;

function calcPts(court, won) {
  return (won ? WIN_BONUS : 0) + (COURT_BONUS[court] || 1);
}
function nextCourt(court, won) {
  const idx = COURTS.indexOf(Number(court));
  if (idx === -1) return Number(court);
  if (won) return COURTS[Math.max(0, idx - 1)];
  return COURTS[Math.min(COURTS.length - 1, idx + 1)];
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function lGet(mongo, col, league = 'men') {
  const colName = `ladder_${col}_${league}`;
  if (mongo) {
    const doc = await mongo.collection(colName).findOne({ _id: col });
    return doc ? doc.data : null;
  }
  if (!global._ladderStore) global._ladderStore = {};
  return global._ladderStore[colName] || null;
}
async function lSet(mongo, col, data, league = 'men') {
  const colName = `ladder_${col}_${league}`;
  if (mongo) {
    await mongo.collection(colName).replaceOne({ _id: col }, { _id: col, data }, { upsert: true });
    return;
  }
  if (!global._ladderStore) global._ladderStore = {};
  global._ladderStore[colName] = data;
}

async function loadPlayers(mongo, lg)    { return (await lGet(mongo, 'players', lg))  || {}; }
async function savePlayers(mongo, d, lg) { await lSet(mongo, 'players', d, lg); }
async function loadSession(mongo, lg)    { return (await lGet(mongo, 'session', lg))  || null; }
async function saveSession(mongo, d, lg) { await lSet(mongo, 'session', d, lg); }
async function loadMatches(mongo, lg)    { return (await lGet(mongo, 'matches', lg))  || []; }
async function saveMatches(mongo, d, lg) { await lSet(mongo, 'matches', d, lg); }

// ── Reclub HTML parser ────────────────────────────────────────────────────────
function parseReclubHtml(html) {
  const players = [];
  const seen = new Set();
  const waitIdx = html.search(/Waitlisted/i);
  const confirmedHtml = waitIdx > 0 ? html.substring(0, waitIdx) : html;
  const avatarRe = /user-avatars\/(\d+)\.webp/g;
  let m;
  while ((m = avatarRe.exec(confirmedHtml)) !== null) {
    const avatarId = m[1];
    const chunk = confirmedHtml.substring(m.index, m.index + 600);
    const linkMatch = chunk.match(/players\/@([^"\s)]+)[^>]*>([^<]{1,50})<\/a>/);
    if (!linkMatch) continue;
    const handle = linkMatch[1].toLowerCase();
    const name = linkMatch[2].trim();
    if (!name || name.length < 1 || seen.has(handle)) continue;
    seen.add(handle);
    players.push({ handle, name, avatarId });
  }
  // fallback: JSON embedded
  if (players.length === 0) {
    const jsonRe = /"username"\s*:\s*"([^"]+)"[^}]{0,200}"(?:displayName|name)"\s*:\s*"([^"]{2,50})"/g;
    while ((m = jsonRe.exec(confirmedHtml)) !== null) {
      const handle = m[1].toLowerCase().replace(/^@/, '');
      const name = m[2].trim();
      if (!seen.has(handle)) { seen.add(handle); players.push({ handle, name, avatarId: null }); }
    }
  }
  return players;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function ladderRoutes(req, res, pathname, query, mongo, getSession) {
  const lg = query.league === 'women' ? 'women' : 'men';
  const subpath = pathname.replace(/^\/ladder/, '') || '/';

  const json = (d, c = 200) => {
    res.writeHead(c, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(d));
  };
  const body = () => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
  const isAdmin = async () => { const s = await getSession(req); return s && s.role === 'admin'; };
  const requireAdmin = async () => {
    if (!await isAdmin()) { json({ error: 'Admin required' }, 403); return false; }
    return true;
  };

  // ── Serve ladder.html ─────────────────────────────────────────────────────
  if ((subpath === '' || subpath === '/' || subpath === '/host') && req.method === 'GET') {
    const fs = require('fs'), path = require('path');
    try {
      const html = fs.readFileSync(path.join(__dirname, 'ladder.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      return res.end(html);
    } catch (e) { res.writeHead(404); return res.end('ladder.html not found'); }
  }

  // ── GET /ladder/api/state — single endpoint, returns everything ───────────
  // Players + session + standings in one call
  if (subpath === '/api/state' && req.method === 'GET') {
    const [players, session] = await Promise.all([
      loadPlayers(mongo, lg),
      loadSession(mongo, lg),
    ]);
    // Build standings: cumulative across all weeks
    const standings = Object.values(players)
      .map(p => ({
        handle: p.handle,
        name: p.name,
        avatarId: p.avatarId || null,
        totalPts: p.totalPts || 0,
        wins: p.wins || 0,
        losses: p.losses || 0,
        weekPts: p.weekPts || {},   // { "1": 80, "2": 120, ... }
      }))
      .sort((a, b) => b.totalPts - a.totalPts || b.wins - a.wins);
    return json({ players, standings, session, league: lg });
  }

  // ── POST /ladder/api/players/import ──────────────────────────────────────
  if (subpath === '/api/players/import' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { html } = JSON.parse(await body());
    if (!html) return json({ error: 'html required' }, 400);
    const parsed = parseReclubHtml(html);
    const players = await loadPlayers(mongo, lg);
    let added = 0, updated = 0;
    parsed.forEach(p => {
      if (players[p.handle]) {
        // update name/avatar but keep stats
        players[p.handle].name = p.name;
        if (p.avatarId) players[p.handle].avatarId = p.avatarId;
        updated++;
      } else {
        players[p.handle] = {
          handle: p.handle, name: p.name, avatarId: p.avatarId || null,
          totalPts: 0, wins: 0, losses: 0, weekPts: {}, addedAt: new Date().toISOString()
        };
        added++;
      }
    });
    await savePlayers(mongo, players, lg);
    return json({ success: true, parsed: parsed.length, added, updated, players });
  }

  // ── POST /ladder/api/players/add — manual ────────────────────────────────
  if (subpath === '/api/players/add' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, name, avatarId } = JSON.parse(await body());
    if (!handle || !name) return json({ error: 'handle and name required' }, 400);
    const key = handle.replace('@', '').toLowerCase().trim();
    const players = await loadPlayers(mongo, lg);
    if (players[key]) return json({ error: 'Player already exists' }, 409);
    players[key] = { handle: key, name, avatarId: avatarId || null, totalPts: 0, wins: 0, losses: 0, weekPts: {}, addedAt: new Date().toISOString() };
    await savePlayers(mongo, players, lg);
    return json({ success: true, player: players[key] });
  }

  // ── DELETE /ladder/api/players/:handle ───────────────────────────────────
  if (subpath.startsWith('/api/players/') && req.method === 'DELETE') {
    if (!await requireAdmin()) return;
    const handle = subpath.split('/')[3];
    const players = await loadPlayers(mongo, lg);
    if (!players[handle]) return json({ error: 'Not found' }, 404);
    delete players[handle];
    await savePlayers(mongo, players, lg);
    return json({ success: true });
  }

  // ── POST /ladder/api/session/start ───────────────────────────────────────
  if (subpath === '/api/session/start' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const existing = await loadSession(mongo, lg);
    if (existing && existing.status === 'active') return json({ error: 'Session already active' }, 409);
    const { sessionName, week } = JSON.parse(await body());
    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      name: sessionName || `Week ${week}`,
      week: week || 1,
      league: lg,
      status: 'checkin',   // checkin → active → completed
      startedAt: new Date().toISOString(),
      matchCount: 0,
      checkedIn: [],        // handles of players present today
      courts: { 1:{queue:[]}, 3:{queue:[]}, 5:{queue:[]}, 7:{queue:[]} }
    };
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin ─────────────────────────────────────
  // Toggle player check-in for today's session
  if (subpath === '/api/session/checkin' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, checked } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    if (checked) {
      if (!session.checkedIn.includes(handle)) session.checkedIn.push(handle);
    } else {
      session.checkedIn = session.checkedIn.filter(h => h !== handle);
      // also remove from any court queue
      COURTS.forEach(c => {
        session.courts[c].queue = session.courts[c].queue.filter(h => h !== handle);
      });
    }
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin/bulk ────────────────────────────────
  // Check in multiple players at once
  if (subpath === '/api/session/checkin/bulk' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handles } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    session.checkedIn = handles || [];
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/activate ────────────────────────────────────
  // Move from checkin → active (done checking in, start playing)
  if (subpath === '/api/session/activate' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    if (session.checkedIn.length < 4) return json({ error: 'Need at least 4 players checked in' }, 400);
    session.status = 'active';
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/assign ──────────────────────────────────────
  if (subpath === '/api/session/assign' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, court } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    COURTS.forEach(c => { session.courts[c].queue = session.courts[c].queue.filter(h => h !== handle); });
    if (court !== null && court !== undefined) {
      const c = Number(court);
      if (COURTS.includes(c)) session.courts[c].queue.push(handle);
    }
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/match ───────────────────────────────────────
  if (subpath === '/api/session/match' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { court, teamA, teamB, winner } = JSON.parse(await body());
    if (!court || !teamA || !teamB || !['A','B'].includes(winner)) return json({ error: 'Invalid params' }, 400);
    const courtNum = Number(court);
    const winners = winner === 'A' ? teamA : teamB;
    const losers  = winner === 'A' ? teamB : teamA;
    const [players, session, matches] = await Promise.all([
      loadPlayers(mongo, lg), loadSession(mongo, lg), loadMatches(mongo, lg)
    ]);
    if (!session) return json({ error: 'No active session' }, 404);
    const week = session.week || 1;
    const ptsAwarded = {};
    // Update player stats
    [...teamA, ...teamB].forEach(h => {
      if (!players[h]) return;
      const won = winners.includes(h);
      const pts = calcPts(courtNum, won);
      players[h].totalPts = (players[h].totalPts || 0) + pts;
      players[h].wins     = (players[h].wins     || 0) + (won ? 1 : 0);
      players[h].losses   = (players[h].losses   || 0) + (won ? 0 : 1);
      players[h].weekPts  = players[h].weekPts || {};
      players[h].weekPts[week] = (players[h].weekPts[week] || 0) + pts;
      players[h].lastSeen = new Date().toISOString();
      ptsAwarded[h] = pts;
    });
    // Move players in queue
    const allPlayed = [...teamA, ...teamB];
    session.courts[courtNum].queue = session.courts[courtNum].queue.filter(h => !allPlayed.includes(h));
    winners.forEach(h => { const nc = nextCourt(courtNum, true);  if (!session.courts[nc].queue.includes(h))  session.courts[nc].queue.push(h); });
    losers.forEach(h  => { const nc = nextCourt(courtNum, false); if (!session.courts[nc].queue.includes(h)) session.courts[nc].queue.push(h); });
    session.matchCount = (session.matchCount || 0) + 1;
    // Save match record
    matches.push({
      id: crypto.randomBytes(6).toString('hex'),
      sessionId: session.id, sessionName: session.name,
      week, court: courtNum, teamA, teamB, winner, ptsAwarded,
      timestamp: new Date().toISOString()
    });
    await Promise.all([
      savePlayers(mongo, players, lg),
      saveSession(mongo, session, lg),
      saveMatches(mongo, matches, lg),
    ]);
    return json({ success: true, ptsAwarded, session });
  }

  // ── POST /ladder/api/session/end ─────────────────────────────────────────
  if (subpath === '/api/session/end' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    session.status = 'completed';
    session.endedAt = new Date().toISOString();
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/reset ───────────────────────────────────────────────
  if (subpath === '/api/reset' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { confirm } = JSON.parse(await body());
    if (confirm !== 'YES_RESET_LADDER') return json({ error: 'Send confirm:"YES_RESET_LADDER"' }, 400);
    await Promise.all([
      savePlayers(mongo, {}, lg),
      saveSession(mongo, null, lg),
      saveMatches(mongo, [], lg),
    ]);
    return json({ success: true });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found: ' + subpath }));
};
