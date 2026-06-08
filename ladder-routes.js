// ladder-routes.js — Bangi Picklers Ladder League API
// Mount in server.js:
//   const ladderRoutes = require('./ladder-routes.js');
//   if (pathname.startsWith('/ladder')) return ladderRoutes(req, res, pathname, query, mongo, getSession, KNOWN_PLAYERS, KNOWN_PLAYERS_WOMEN);

const crypto = require('crypto');

const COURTS = [1, 3, 5, 7];
const COURT_BONUS = { 1: 8, 3: 5, 5: 3, 7: 1 };
const WIN_BONUS = 10;

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

async function loadPlayers(mongo, lg)    { return (await lGet(mongo, 'players', lg)) || {}; }
async function savePlayers(mongo, d, lg) { await lSet(mongo, 'players', d, lg); }
async function loadSession(mongo, lg)    { return (await lGet(mongo, 'session', lg)) || null; }
async function saveSession(mongo, d, lg) { await lSet(mongo, 'session', d, lg); }
async function loadMatches(mongo, lg)    { return (await lGet(mongo, 'matches', lg)) || []; }
async function saveMatches(mongo, d, lg) { await lSet(mongo, 'matches', d, lg); }

// ── Reclub HTML parser ────────────────────────────────────────────────────────
function parseReclubHtml(html) {
  const players = [], seen = new Set();
  const waitIdx = html.search(/Waitlisted/i);
  const h = waitIdx > 0 ? html.substring(0, waitIdx) : html;
  const re = /user-avatars\/(\d+)\.webp/g;
  let m;
  while ((m = re.exec(h)) !== null) {
    const chunk = h.substring(m.index, m.index + 600);
    const lm = chunk.match(/players\/@([^"\s)]+)[^>]*>([^<]{1,50})<\/a>/);
    if (!lm) continue;
    const handle = lm[1].toLowerCase(), name = lm[2].trim();
    if (!name || seen.has(handle)) continue;
    seen.add(handle);
    players.push({ handle, name, avatarId: m[1] });
  }
  if (players.length === 0) {
    const jr = /"username"\s*:\s*"([^"]+)"[^}]{0,200}"(?:displayName|name)"\s*:\s*"([^"]{2,50})"/g;
    while ((m = jr.exec(h)) !== null) {
      const handle = m[1].toLowerCase().replace(/^@/, ''), name = m[2].trim();
      if (!seen.has(handle)) { seen.add(handle); players.push({ handle, name, avatarId: null }); }
    }
  }
  return players;
}

// ── Seed from KNOWN_PLAYERS ───────────────────────────────────────────────────
function seedFromKnown(knownPlayers, existingPlayers) {
  let added = 0, skipped = 0;
  const seen = new Set();

  Object.entries(knownPlayers).forEach(([displayName, info]) => {
    if (!info.handle) return;
    // Skip court-disambiguation entries like "Faiz||Court 7"
    if (displayName.includes('||')) return;

    const handle = info.handle.replace('@', '').toLowerCase().trim();
    if (seen.has(handle)) return;
    seen.add(handle);

    if (existingPlayers[handle]) {
      // Already exists — update name/avatar only, keep stats
      existingPlayers[handle].name    = existingPlayers[handle].name || displayName.replace(/\s*\(.*\)$/, '').trim();
      existingPlayers[handle].avatarId = existingPlayers[handle].avatarId || String(info.avatarId || '');
      skipped++;
    } else {
      // Clean display name — strip bracket suffix e.g. "Faiz (faiz60111)" → "Faiz"
      const cleanName = displayName.replace(/\s*\(.*\)$/, '').trim();
      existingPlayers[handle] = {
        handle,
        name:      cleanName,
        avatarId:  String(info.avatarId || ''),
        totalPts:  0,
        wins:      0,
        losses:    0,
        weekPts:   {},
        addedAt:   new Date().toISOString(),
        source:    'known_players'
      };
      added++;
    }
  });

  return { added, skipped };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function ladderRoutes(req, res, pathname, query, mongo, getSession, KNOWN_PLAYERS, KNOWN_PLAYERS_WOMEN) {
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
  if ((subpath === '' || subpath === '/') && req.method === 'GET') {
    const fs = require('fs'), path = require('path');
    try {
      const html = fs.readFileSync(path.join(__dirname, 'ladder.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      return res.end(html);
    } catch (e) { res.writeHead(404); return res.end('ladder.html not found'); }
  }

  // ── GET /ladder/api/state ─────────────────────────────────────────────────
  if (subpath === '/api/state' && req.method === 'GET') {
    const [players, session] = await Promise.all([
      loadPlayers(mongo, lg),
      loadSession(mongo, lg),
    ]);
    const standings = Object.values(players)
      .map(p => ({
        handle:   p.handle,
        name:     p.name,
        avatarId: p.avatarId || null,
        totalPts: p.totalPts || 0,
        wins:     p.wins || 0,
        losses:   p.losses || 0,
        weekPts:  p.weekPts || {},
      }))
      .sort((a, b) => b.totalPts - a.totalPts || b.wins - a.wins);
    return json({ players, standings, session, league: lg });
  }

  // ── POST /ladder/api/players/seed — from KNOWN_PLAYERS ───────────────────
  if (subpath === '/api/players/seed' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const KP = lg === 'women' ? KNOWN_PLAYERS_WOMEN : KNOWN_PLAYERS;
    if (!KP || Object.keys(KP).length === 0) return json({ error: 'No known players available' }, 400);
    const players = await loadPlayers(mongo, lg);
    const { added, skipped } = seedFromKnown(KP, players);
    await savePlayers(mongo, players, lg);
    console.log(`Ladder seed (${lg}): added=${added}, skipped=${skipped}, total=${Object.keys(players).length}`);
    return json({ success: true, added, skipped, total: Object.keys(players).length, players });
  }

  // ── POST /ladder/api/players/import — from reclub HTML ───────────────────
  if (subpath === '/api/players/import' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { html } = JSON.parse(await body());
    if (!html) return json({ error: 'html required' }, 400);
    const parsed = parseReclubHtml(html);
    const players = await loadPlayers(mongo, lg);
    let added = 0, updated = 0;
    parsed.forEach(p => {
      if (players[p.handle]) {
        players[p.handle].name    = p.name;
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
      status: 'checkin',
      startedAt: new Date().toISOString(),
      matchCount: 0,
      checkedIn: [],
      courts: { 1:{queue:[]}, 3:{queue:[]}, 5:{queue:[]}, 7:{queue:[]} }
    };
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin ─────────────────────────────────────
  if (subpath === '/api/session/checkin' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, checked } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    if (checked) {
      if (!session.checkedIn.includes(handle)) session.checkedIn.push(handle);
    } else {
      session.checkedIn = session.checkedIn.filter(h => h !== handle);
      COURTS.forEach(c => { session.courts[c].queue = session.courts[c].queue.filter(h => h !== handle); });
    }
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin/bulk ────────────────────────────────
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
    [...teamA, ...teamB].forEach(h => {
      if (!players[h]) return;
      const won = winners.includes(h);
      const pts = calcPts(courtNum, won);
      players[h].totalPts      = (players[h].totalPts || 0) + pts;
      players[h].wins          = (players[h].wins     || 0) + (won ? 1 : 0);
      players[h].losses        = (players[h].losses   || 0) + (won ? 0 : 1);
      players[h].weekPts       = players[h].weekPts || {};
      players[h].weekPts[week] = (players[h].weekPts[week] || 0) + pts;
      players[h].lastSeen      = new Date().toISOString();
      ptsAwarded[h] = pts;
    });
    const allPlayed = [...teamA, ...teamB];
    session.courts[courtNum].queue = session.courts[courtNum].queue.filter(h => !allPlayed.includes(h));

    // Partner split via interleave:
    // Game pairs slots: [0+1] vs [2+3] → to split ex-partners, insert them at EVEN+ODD positions
    // e.g. queue=[X,Y,Z,W], winners=[A,B]:
    //   insert A → [X,Y,Z,W,A]        (A at index 4, even → Team A of next game)
    //   insert B → [X,Y,Z,W,A,_,B]    (B at index 6, even → Team A again — bad)
    // Correct: insert B at index 5 (odd → Team B) → [X,Y,Z,W,A,B] with A=idx4(even) B=idx5(odd) = diff teams ✓
    // Simple rule: first player appends, second player inserts at (first player index + 1) if that puts them in diff teams
    // Partner split: insert p1 and p2 into queue such that they land in DIFFERENT teams
    // Game pairing: slots [0,1]=TeamA, [2,3]=TeamB, [4,5]=TeamA, [6,7]=TeamB...
    // teamOf(idx) = Math.floor(idx % 4 / 2)
    // If queue empty: no split possible yet — they'll be paired, host handles physically
    const teamOf = idx => Math.floor(idx % 4 / 2);

    const splitInsert = (queue, p1, p2) => {
      const q = queue.filter(h => h !== p1 && h !== p2);
      if (q.length === 0) {
        // Empty queue — just append both, no split possible
        q.push(p1, p2);
        return q;
      }
      if (q.length % 2 === 0) {
        // Even length: p1 at last-1 (odd slot), p2 appends (even slot) → different teams
        q.splice(q.length - 1, 0, p1);
      } else {
        // Odd length: p1 appends (even slot relative to game)
        q.push(p1);
      }
      q.push(p2);
      // Final verify — if still same team, swap p2 with element before it
      const p1I = q.indexOf(p1), p2I = q.indexOf(p2);
      if (teamOf(p1I) === teamOf(p2I) && p2I > 0 && q[p2I - 1] !== p1) {
        [q[p2I - 1], q[p2I]] = [q[p2I], q[p2I - 1]];
      }
      return q;
    };

    const ncWin  = nextCourt(courtNum, true);
    const ncLose = nextCourt(courtNum, false);
    session.courts[ncWin].queue  = splitInsert(session.courts[ncWin].queue,  winners[0], winners[1]);
    session.courts[ncLose].queue = splitInsert(session.courts[ncLose].queue, losers[0],  losers[1]);
    session.matchCount = (session.matchCount || 0) + 1;
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

  // ── POST /ladder/api/scores/reset — zero pts/wins/losses, keep players ──
  if (subpath === '/api/scores/reset' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { confirm } = JSON.parse(await body());
    if (confirm !== 'YES_RESET_SCORES') return json({ error: 'Send confirm:"YES_RESET_SCORES"' }, 400);
    const players = await loadPlayers(mongo, lg);
    Object.keys(players).forEach(h => {
      players[h].totalPts = 0;
      players[h].wins     = 0;
      players[h].losses   = 0;
      players[h].weekPts  = {};
      delete players[h].lastSeen;
    });
    await Promise.all([
      savePlayers(mongo, players, lg),
      saveMatches(mongo, [], lg),
    ]);
    return json({ success: true, total: Object.keys(players).length, players });
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
