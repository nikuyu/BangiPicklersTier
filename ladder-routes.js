// ladder-routes.js — Bangi Picklers Ladder League API
// Mount: if (pathname.startsWith('/ladder')) return ladderRoutes(req, res, pathname, query, mongo, getSession);

const crypto = require('crypto');

const COURTS = [1, 3, 5, 7];
const COURT_BONUS = { 1: 8, 3: 5, 5: 3, 7: 1 };
const WIN_BONUS = 10;

function calcPts(court, won) {
  return (won ? WIN_BONUS : 0) + (COURT_BONUS[court] || 1);
}
function nextCourt(court, won) {
  const idx = COURTS.indexOf(court);
  if (idx === -1) return court;
  if (won) return COURTS[Math.max(0, idx - 1)];
  return COURTS[Math.min(COURTS.length - 1, idx + 1)];
}

// ── DB helpers (ladder-specific collections) ─────────────────────────────────
async function lGet(mongo, col, league = 'men') {
  const colName = `ladder_${col}_${league}`;
  if (mongo) {
    const doc = await mongo.collection(colName).findOne({ _id: col });
    return doc ? doc.data : null;
  }
  // fallback: in-memory (resets on restart — for local dev only)
  if (!global._ladderStore) global._ladderStore = {};
  return global._ladderStore[colName] || null;
}

async function lSet(mongo, col, data, league = 'men') {
  const colName = `ladder_${col}_${league}`;
  if (mongo) {
    await mongo.collection(colName).replaceOne(
      { _id: col },
      { _id: col, data },
      { upsert: true }
    );
    return;
  }
  if (!global._ladderStore) global._ladderStore = {};
  global._ladderStore[colName] = data;
}

async function loadPlayers(mongo, lg)  { return (await lGet(mongo, 'players', lg))  || {}; }
async function savePlayers(mongo, d, lg) { await lSet(mongo, 'players', d, lg); }
async function loadSession(mongo, lg)  { return (await lGet(mongo, 'session', lg))  || null; }
async function saveSession(mongo, d, lg) { await lSet(mongo, 'session', d, lg); }
async function loadMatches(mongo, lg)  { return (await lGet(mongo, 'matches', lg))  || []; }
async function saveMatches(mongo, d, lg) { await lSet(mongo, 'matches', d, lg); }

// ── Reclub HTML parser ────────────────────────────────────────────────────────
function parseReclubHtml(html) {
  const players = [];
  const seen = new Set();

  // Stop at Waitlisted section
  const waitIdx = html.search(/Waitlisted/i);
  const confirmedHtml = waitIdx > 0 ? html.substring(0, waitIdx) : html;

  // Strategy 1: user-avatars/NNN.webp followed by players/@handle link
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

  // Strategy 2: JSON embedded — "username":"xxx","displayName":"yyy"
  if (players.length === 0) {
    const jsonRe = /"username"\s*:\s*"([^"]+)"[^}]{0,200}"(?:displayName|name)"\s*:\s*"([^"]{2,50})"/g;
    while ((m = jsonRe.exec(confirmedHtml)) !== null) {
      const handle = m[1].toLowerCase().replace(/^@/, '');
      const name = m[2].trim();
      if (!seen.has(handle)) { seen.add(handle); players.push({ handle, name, avatarId: null }); }
    }
  }

  // Strategy 3: fallback — @handle mentions
  if (players.length === 0) {
    const hRe = /@([\w-]{3,30})/g;
    while ((m = hRe.exec(confirmedHtml)) !== null) {
      const handle = m[1].toLowerCase();
      if (!seen.has(handle) && !['app','api','cdn','www','mail','reclub'].includes(handle)) {
        seen.add(handle);
        players.push({ handle, name: m[1], avatarId: null });
      }
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

  const body = () => new Promise(r => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => r(b));
  });

  const isAdmin = async () => {
    const s = await getSession(req);
    return s && s.role === 'admin';
  };

  const requireAdmin = async () => {
    if (!await isAdmin()) {
      json({ error: 'Admin required' }, 403);
      return false;
    }
    return true;
  };

  // ── GET /ladder or /ladder/ — serve ladder.html ──────────────────────────
  if ((subpath === '' || subpath === '/' || subpath === '/host') && req.method === 'GET') {
    const fs = require('fs');
    const path = require('path');
    try {
      const html = fs.readFileSync(path.join(__dirname, 'ladder.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404); return res.end('ladder.html not found');
    }
  }

  // ── GET /ladder/api/standings ─────────────────────────────────────────────
  if (subpath === '/api/standings' && req.method === 'GET') {
    const players = await loadPlayers(mongo, lg);
    const list = Object.values(players)
      .sort((a, b) => (b.totalPts || 0) - (a.totalPts || 0) || (b.wins || 0) - (a.wins || 0));
    return json({ players: list, league: lg });
  }

  // ── GET /ladder/api/session ───────────────────────────────────────────────
  if (subpath === '/api/session' && req.method === 'GET') {
    const session = await loadSession(mongo, lg);
    return json({ session });
  }

  // ── GET /ladder/api/players ───────────────────────────────────────────────
  if (subpath === '/api/players' && req.method === 'GET') {
    const players = await loadPlayers(mongo, lg);
    return json({ players });
  }

  // ── POST /ladder/api/players/import — parse reclub HTML ──────────────────
  if (subpath === '/api/players/import' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { html, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;
    if (!html) return json({ error: 'html required' }, 400);

    const parsed = parseReclubHtml(html);
    const players = await loadPlayers(mongo, useLg);
    let added = 0, updated = 0;

    parsed.forEach(p => {
      const existing = players[p.handle];
      if (existing) {
        // Update name/avatarId but keep stats
        players[p.handle] = { ...existing, name: p.name, avatarId: p.avatarId || existing.avatarId };
        updated++;
      } else {
        players[p.handle] = {
          handle: p.handle,
          name: p.name,
          avatarId: p.avatarId || null,
          totalPts: 0,
          wins: 0,
          losses: 0,
          addedAt: new Date().toISOString()
        };
        added++;
      }
    });

    await savePlayers(mongo, players, useLg);
    return json({ success: true, parsed: parsed.length, added, updated, players });
  }

  // ── POST /ladder/api/players/add — manual add single player ──────────────
  if (subpath === '/api/players/add' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, name, avatarId, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;
    if (!handle || !name) return json({ error: 'handle and name required' }, 400);
    const players = await loadPlayers(mongo, useLg);
    const key = handle.replace('@', '').toLowerCase().trim();
    if (players[key]) return json({ error: 'Player already exists' }, 409);
    players[key] = { handle: key, name, avatarId: avatarId || null, totalPts: 0, wins: 0, losses: 0, addedAt: new Date().toISOString() };
    await savePlayers(mongo, players, useLg);
    return json({ success: true, player: players[key] });
  }

  // ── PUT /ladder/api/players/rename — update display name ─────────────────
  if (subpath === '/api/players/rename' && req.method === 'PUT') {
    if (!await requireAdmin()) return;
    const { handle, name } = JSON.parse(await body());
    if (!handle || !name) return json({ error: 'handle and name required' }, 400);
    const players = await loadPlayers(mongo, lg);
    const key = handle.replace('@', '').toLowerCase().trim();
    if (!players[key]) return json({ error: 'Player not found' }, 404);
    players[key].name = name;
    await savePlayers(mongo, players, lg);
    return json({ success: true });
  }

  // ── DELETE /ladder/api/players/:handle ────────────────────────────────────
  if (subpath.startsWith('/api/players/') && req.method === 'DELETE') {
    if (!await requireAdmin()) return;
    const handle = subpath.split('/')[3];
    if (!handle) return json({ error: 'handle required' }, 400);
    const players = await loadPlayers(mongo, lg);
    const key = handle.replace('@', '').toLowerCase().trim();
    if (!players[key]) return json({ error: 'Not found' }, 404);
    delete players[key];
    await savePlayers(mongo, players, lg);
    return json({ success: true });
  }

  // ── POST /ladder/api/session/start ────────────────────────────────────────
  if (subpath === '/api/session/start' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { sessionName, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;
    const existing = await loadSession(mongo, useLg);
    if (existing && existing.status === 'active') {
      return json({ error: 'Session already active. End it first.' }, 409);
    }
    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      name: sessionName || `Session ${new Date().toLocaleDateString('en-MY')}`,
      league: useLg,
      status: 'active',
      startedAt: new Date().toISOString(),
      matchCount: 0,
      courts: {
        1: { queue: [] },
        3: { queue: [] },
        5: { queue: [] },
        7: { queue: [] }
      }
    };
    await saveSession(mongo, session, useLg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/assign ──────────────────────────────────────
  // Assign player to a court queue (or remove if court=null)
  if (subpath === '/api/session/assign' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, court, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;
    const session = await loadSession(mongo, useLg);
    if (!session) return json({ error: 'No active session' }, 404);

    // Remove from all courts first
    COURTS.forEach(c => {
      session.courts[c].queue = (session.courts[c].queue || []).filter(h => h !== handle);
    });

    // Add to target court
    if (court !== null && court !== undefined && COURTS.includes(Number(court))) {
      session.courts[Number(court)].queue.push(handle);
    }

    await saveSession(mongo, session, useLg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/match ────────────────────────────────────────
  // Record match result: { court, teamA:[h1,h2], teamB:[h1,h2], winner:'A'|'B' }
  if (subpath === '/api/session/match' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { court, teamA, teamB, winner, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;

    if (!court || !teamA || !teamB || !winner) return json({ error: 'court, teamA, teamB, winner required' }, 400);
    if (!['A', 'B'].includes(winner)) return json({ error: 'winner must be A or B' }, 400);

    const courtNum = Number(court);
    const winners = winner === 'A' ? teamA : teamB;
    const losers  = winner === 'A' ? teamB : teamA;

    const players = await loadPlayers(mongo, useLg);
    const session = await loadSession(mongo, useLg);
    const matches = await loadMatches(mongo, useLg);

    // Update player stats
    const allPlayed = [...teamA, ...teamB];
    allPlayed.forEach(handle => {
      if (!players[handle]) return;
      const won = winners.includes(handle);
      const pts = calcPts(courtNum, won);
      players[handle].totalPts  = (players[handle].totalPts  || 0) + pts;
      players[handle].wins      = (players[handle].wins      || 0) + (won ? 1 : 0);
      players[handle].losses    = (players[handle].losses    || 0) + (won ? 0 : 1);
      players[handle].lastSeen  = new Date().toISOString();
    });

    // Update session queue — remove played players, move to next court
    if (session) {
      session.courts[courtNum].queue = (session.courts[courtNum].queue || []).filter(h => !allPlayed.includes(h));

      winners.forEach(handle => {
        const nc = nextCourt(courtNum, true);
        if (!session.courts[nc].queue.includes(handle)) session.courts[nc].queue.push(handle);
      });
      losers.forEach(handle => {
        const nc = nextCourt(courtNum, false);
        if (!session.courts[nc].queue.includes(handle)) session.courts[nc].queue.push(handle);
      });

      session.matchCount = (session.matchCount || 0) + 1;
      await saveSession(mongo, session, useLg);
    }

    // Save match record
    const matchRecord = {
      id: crypto.randomBytes(6).toString('hex'),
      sessionId: session?.id || null,
      sessionName: session?.name || null,
      court: courtNum,
      teamA,
      teamB,
      winner,
      ptsAwarded: {},
      timestamp: new Date().toISOString()
    };
    allPlayed.forEach(h => {
      matchRecord.ptsAwarded[h] = calcPts(courtNum, winners.includes(h));
    });
    matches.push(matchRecord);

    await savePlayers(mongo, players, useLg);
    await saveMatches(mongo, matches, useLg);

    return json({
      success: true,
      match: matchRecord,
      session,
      ptsAwarded: matchRecord.ptsAwarded
    });
  }

  // ── POST /ladder/api/session/end ──────────────────────────────────────────
  if (subpath === '/api/session/end' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { league: bodyLg } = JSON.parse(await body() || '{}');
    const useLg = bodyLg || lg;
    const session = await loadSession(mongo, useLg);
    if (!session) return json({ error: 'No active session' }, 404);
    session.status = 'completed';
    session.endedAt = new Date().toISOString();
    await saveSession(mongo, session, useLg);
    return json({ success: true, session });
  }

  // ── GET /ladder/api/matches ───────────────────────────────────────────────
  if (subpath === '/api/matches' && req.method === 'GET') {
    const matches = await loadMatches(mongo, lg);
    return json({ matches: matches.slice(-100) }); // last 100
  }

  // ── DELETE /ladder/api/reset — wipe all ladder data for league ───────────
  if (subpath === '/api/reset' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { confirm, league: bodyLg } = JSON.parse(await body());
    const useLg = bodyLg || lg;
    if (confirm !== 'YES_RESET_LADDER') return json({ error: 'Must send confirm:"YES_RESET_LADDER"' }, 400);
    await savePlayers(mongo, {}, useLg);
    await saveSession(mongo, null, useLg);
    await saveMatches(mongo, [], useLg);
    return json({ success: true, message: `Ladder data reset for ${useLg}` });
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ladder route not found: ' + subpath }));
};
