// ladder-routes.js — Bangi Picklers Ladder League API (Round-based)
// server.js: if (pathname.startsWith('/ladder')) return ladderRoutes(req, res, pathname, query, mongo, getSession, KNOWN_PLAYERS, KNOWN_PLAYERS_WOMEN);

const crypto = require('crypto');

const COURTS = [1, 3, 5, 7];
const COURT_BONUS = { 1: 8, 3: 5, 5: 3, 7: 1 };
const WIN_BONUS = 10;

function calcPts(court, won) {
  return (won ? WIN_BONUS : 0) + (COURT_BONUS[court] || 1);
}

// ── Round logic ───────────────────────────────────────────────────────────────
// Each court has 8 players in slots [0..7]
// Round 1: slots [0,1] vs [2,3]
// Round 2: slots [4,5] vs [6,7]
// Round 3+: movement round — winners up, losers down, split partners
//
// Movement after Round 2:
//   Court 1 next = split( W(C1,R1+R2), W(C3,R1+R2) )
//   Court 3 next = split( W(C5,R1+R2), L(C1,R1+R2) )  — best loser vs best winner below
//   Court 5 next = split( W(C7,R1+R2), L(C3,R1+R2) )
//   Court 7 next = split( L(C5,R1+R2), L(C7,R1+R2) )
//
// Split formula: [P1,P2] vs [P3,P4] → P1+P3 vs P2+P4

function splitMatch(pair1, pair2) {
  // pair1=[A,B], pair2=[C,D] → TeamA=[A,C], TeamB=[B,D]
  return {
    teamA: [pair1[0], pair2[0]],
    teamB: [pair1[1], pair2[1]],
  };
}

function generateMovementRound(courtResults) {
  // courtResults = { 1: { winners:[h1,h2], losers:[h3,h4] }, 3: {...}, 5: {...}, 7: {...} }
  // Returns next round matchups per court
  const W = c => courtResults[c]?.winners || [];
  const L = c => courtResults[c]?.losers  || [];

  return {
    1: splitMatch(W(1), W(3)),  // Court 1: W(C1) split W(C3)
    3: splitMatch(W(5), L(1)),  // Court 3: W(C5) split L(C1)
    5: splitMatch(W(7), L(3)),  // Court 5: W(C7) split L(C3)
    7: splitMatch(L(5), L(7)),  // Court 7: L(C5) split L(C7)
  };
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

  // Strategy 1: S5 format — <a href="/players/@handle">...<img src="user-avatars/N.webp">...<p>Name</p></a>
  const re1 = /href="\/players\/@([^"]+)"[^>]*>[\s\S]{0,400}?user-avatars\/(\d+)\.webp[\s\S]{0,300}?<p[^>]*>([^<]{1,50})<\/p>/g;
  let m;
  while ((m = re1.exec(h)) !== null) {
    const handle = m[1].toLowerCase().trim();
    const avatarId = m[2];
    const name = m[3].trim();
    if (!name || name.length < 1 || seen.has(handle)) continue;
    seen.add(handle);
    players.push({ handle, name, avatarId });
  }

  // Strategy 2: S4 format — user-avatars/N.webp then players/@handle link nearby
  if (players.length === 0) {
    const re2 = /user-avatars\/(\d+)\.webp/g;
    while ((m = re2.exec(h)) !== null) {
      const chunk = h.substring(m.index, m.index + 600);
      const lm = chunk.match(/players\/@([^"\s)]+)[^>]*>([^<]{1,50})<\/a>/);
      if (!lm) continue;
      const handle = lm[1].toLowerCase(), name = lm[2].trim();
      if (!name || seen.has(handle)) continue;
      seen.add(handle);
      players.push({ handle, name, avatarId: m[1] });
    }
  }

  // Strategy 3: JSON embedded
  if (players.length === 0) {
    const re3 = /"username"\s*:\s*"([^"]+)"[^}]{0,200}"(?:displayName|name)"\s*:\s*"([^"]{2,50})"/g;
    while ((m = re3.exec(h)) !== null) {
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
    if (!info.handle || displayName.includes('||')) return;
    const handle = info.handle.replace('@', '').toLowerCase().trim();
    if (seen.has(handle)) return;
    seen.add(handle);
    if (existingPlayers[handle]) {
      existingPlayers[handle].name    = existingPlayers[handle].name || displayName.replace(/\s*\(.*\)$/, '').trim();
      existingPlayers[handle].avatarId = existingPlayers[handle].avatarId || String(info.avatarId || '');
      skipped++;
    } else {
      const cleanName = displayName.replace(/\s*\(.*\)$/, '').trim();
      existingPlayers[handle] = {
        handle, name: cleanName, avatarId: String(info.avatarId || ''),
        totalPts: 0, wins: 0, losses: 0, weekPts: {}, addedAt: new Date().toISOString(), source: 'known_players'
      };
      added++;
    }
  });
  return { added, skipped };
}

// ── Session state structure ───────────────────────────────────────────────────
// session = {
//   id, name, week, league, status: 'checkin'|'active'|'completed',
//   roundNum: 1,           // current round (1,2 = fixed pairs; 3+ = movement)
//   checkedIn: [handles],
//   courts: {
//     1: {
//       players: [h0,h1,h2,h3,h4,h5,h6,h7],  // 8 assigned players (fixed slots)
//       currentMatch: { teamA:[h,h], teamB:[h,h] } | null,
//       roundResults: {
//         1: { teamA:[h,h], teamB:[h,h], winner:'A'|'B', winners:[h,h], losers:[h,h] },
//         2: { ... },
//         3: { ... },
//       }
//     },
//     3: { ... }, 5: { ... }, 7: { ... }
//   },
//   matchCount: 0,
// }

function getSlotsByRound(roundNum) {
  // Pattern repeats every 2 rounds after movement:
  // Odd rounds (1,3,5,7...): slots 0-3 play
  // Even rounds (2,4,6,8...): slots 4-7 play
  if (roundNum % 2 === 1) return { aSlots: [0,1], bSlots: [2,3] };
  if (roundNum % 2 === 0) return { aSlots: [4,5], bSlots: [6,7] };
  return null;
}

function buildMatchFromSlots(players, roundNum) {
  if (roundNum % 2 === 1) {
    // Odd round: slots 0-3 play, straight pairing
    const teamA = [players[0], players[1]].filter(Boolean);
    const teamB = [players[2], players[3]].filter(Boolean);
    if (teamA.length < 2 || teamB.length < 2) return null;
    return { teamA, teamB };
  } else {
    // Even round: slots 4-7 play, split bench pairing
    // bench=[B0,B1,B2,B3] → teamA=[B0,B2], teamB=[B1,B3] (splits previous partners)
    const bench = players.slice(4, 8).filter(Boolean);
    if (bench.length < 4) return null;
    return { teamA: [bench[0], bench[2]], teamB: [bench[1], bench[3]] };
  }
}

// After round 2 completes on all courts, generate round 3 matchups
function buildRound3(session) {
  // Collect round 1+2 combined winners/losers per court
  // Winners = won both rounds; if split (1 each), pick by pts... 
  // Actually: each round produces its own winners. Movement uses round results separately.
  // Simplest: take winners from most recent completed round (round 2) for movement
  const courtResults = {};
  COURTS.forEach(c => {
    const ct = session.courts[c];
    const r2 = ct.roundResults?.[2];
    const r1 = ct.roundResults?.[1];
    // Use round 2 result for movement (most recent)
    if (r2) {
      courtResults[c] = { winners: r2.winners, losers: r2.losers };
    } else if (r1) {
      courtResults[c] = { winners: r1.winners, losers: r1.losers };
    }
  });
  return generateMovementRound(courtResults);
}

// After round 3+ completes, generate next movement round
function buildNextMovementRound(session, completedRound) {
  const courtResults = {};
  COURTS.forEach(c => {
    const r = session.courts[c].roundResults?.[completedRound];
    if (r) courtResults[c] = { winners: r.winners, losers: r.losers };
  });
  return generateMovementRound(courtResults);
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

  // ── Serve ladder.html ────────────────────────────────────────────────────
  if ((subpath === '' || subpath === '/') && req.method === 'GET') {
    const fs = require('fs'), path = require('path');
    try {
      const html = fs.readFileSync(path.join(__dirname, 'ladder.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      return res.end(html);
    } catch (e) { res.writeHead(404); return res.end('ladder.html not found'); }
  }

  // ── GET /ladder/api/state ────────────────────────────────────────────────
  if (subpath === '/api/state' && req.method === 'GET') {
    const [players, session] = await Promise.all([loadPlayers(mongo, lg), loadSession(mongo, lg)]);
    const standings = Object.values(players)
      .map(p => ({ handle: p.handle, name: p.name, avatarId: p.avatarId || null, totalPts: p.totalPts || 0, wins: p.wins || 0, losses: p.losses || 0, weekPts: p.weekPts || {} }))
      .sort((a, b) => b.totalPts - a.totalPts || b.wins - a.wins);
    return json({ players, standings, session, league: lg });
  }

  // ── POST /ladder/api/players/seed ───────────────────────────────────────
  if (subpath === '/api/players/seed' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const KP = lg === 'women' ? KNOWN_PLAYERS_WOMEN : KNOWN_PLAYERS;
    if (!KP || Object.keys(KP).length === 0) return json({ error: 'No known players available' }, 400);
    const players = await loadPlayers(mongo, lg);
    const { added, skipped } = seedFromKnown(KP, players);
    await savePlayers(mongo, players, lg);
    return json({ success: true, added, skipped, total: Object.keys(players).length, players });
  }

  // ── POST /ladder/api/players/import ─────────────────────────────────────
  if (subpath === '/api/players/import' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { html } = JSON.parse(await body());
    if (!html) return json({ error: 'html required' }, 400);
    const parsed = parseReclubHtml(html);
    const players = await loadPlayers(mongo, lg);
    let added = 0, updated = 0;
    parsed.forEach(p => {
      if (players[p.handle]) { players[p.handle].name = p.name; if (p.avatarId) players[p.handle].avatarId = p.avatarId; updated++; }
      else { players[p.handle] = { handle: p.handle, name: p.name, avatarId: p.avatarId || null, totalPts: 0, wins: 0, losses: 0, weekPts: {}, addedAt: new Date().toISOString() }; added++; }
    });
    await savePlayers(mongo, players, lg);
    return json({ success: true, parsed: parsed.length, added, updated, players });
  }

  // ── POST /ladder/api/players/add ────────────────────────────────────────
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

  // ── POST /ladder/api/session/start ──────────────────────────────────────
  if (subpath === '/api/session/start' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const existing = await loadSession(mongo, lg);
    if (existing && existing.status === 'active') return json({ error: 'Session already active' }, 409);
    const { sessionName, week } = JSON.parse(await body());
    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      name: sessionName || `Week ${week}`,
      week: week || 1, league: lg,
      status: 'checkin',
      startedAt: new Date().toISOString(),
      matchCount: 0, roundNum: 1,
      checkedIn: [],
      courts: {
        1: { players: [], currentMatch: null, roundResults: {} },
        3: { players: [], currentMatch: null, roundResults: {} },
        5: { players: [], currentMatch: null, roundResults: {} },
        7: { players: [], currentMatch: null, roundResults: {} },
      }
    };
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin ────────────────────────────────────
  if (subpath === '/api/session/checkin' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, checked } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    if (checked) { if (!session.checkedIn.includes(handle)) session.checkedIn.push(handle); }
    else {
      session.checkedIn = session.checkedIn.filter(h => h !== handle);
      COURTS.forEach(c => { session.courts[c].players = session.courts[c].players.filter(h => h !== handle); });
    }
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/checkin/bulk ───────────────────────────────
  if (subpath === '/api/session/checkin/bulk' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handles } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    session.checkedIn = handles || [];
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/activate ───────────────────────────────────
  if (subpath === '/api/session/activate' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    if (session.checkedIn.length < 4) return json({ error: 'Need at least 4 players' }, 400);
    session.status = 'active';
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/suggest-courts ──────────────────────────────
  // Auto-assign checked-in players to courts based on REVERSE overall ranking
  // Top ranked → Court 7 (bottom), low ranked / new → Court 1 (top)
  if (subpath === '/api/session/suggest-courts' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);

    const players = await loadPlayers(mongo, lg);
    const checkedIn = session.checkedIn || [];
    if (checkedIn.length < 4) return json({ error: 'Check in players first' }, 400);

    // Sort checked-in players by overall ranking (desc pts) → reverse seed
    const sorted = [...checkedIn].sort((a, b) => {
      const pa = players[a], pb = players[b];
      const ptsA = pa?.totalPts || 0, ptsB = pb?.totalPts || 0;
      const wA = pa?.wins || 0, wB = pb?.wins || 0;
      const lA = pa?.losses || 0, lB = pb?.losses || 0;
      return ptsB - ptsA || wB - wA || lA - lB;
    });

    // Reverse seeding:
    // Rank 1 (top) → Court 7, Rank last (bottom) → Court 1
    // Split into groups of 8 (or fewer if less players)
    const total = sorted.length;
    const perCourt = Math.ceil(total / 4);

    // Reset all court players
    COURTS.forEach(c => { session.courts[c].players = []; });

    // Assign: sorted[0..perCourt-1] → Court 7 (highest ranked)
    //         sorted[perCourt..2*perCourt-1] → Court 5
    //         sorted[2*perCourt..3*perCourt-1] → Court 3
    //         sorted[3*perCourt..] → Court 1 (lowest ranked / new)
    const courtOrder = [7, 5, 3, 1]; // top players go to Court 7
    courtOrder.forEach((court, idx) => {
      const start = idx * perCourt;
      const end   = Math.min(start + perCourt, total);
      const group = sorted.slice(start, end);
      session.courts[court].players = group;
    });

    await saveSession(mongo, session, lg);
    return json({ success: true, session, assigned: total });
  }

  // ── POST /ladder/api/session/assign ─────────────────────────────────────
  // Assign player to a court slot
  if (subpath === '/api/session/assign' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { handle, court } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    // Remove from all courts
    COURTS.forEach(c => { session.courts[c].players = session.courts[c].players.filter(h => h !== handle); });
    // Add to target court (max 8)
    if (court !== null && court !== undefined) {
      const c = Number(court);
      if (COURTS.includes(c) && session.courts[c].players.length < 8) {
        session.courts[c].players.push(handle);
      }
    }
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/match/edit — swap players in current match ──
  if (subpath === '/api/session/match/edit' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { court, teamA, teamB } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    const c = Number(court);
    if (!session.courts[c]?.currentMatch) return json({ error: 'No active match for this court' }, 400);
    session.courts[c].currentMatch.teamA = teamA;
    session.courts[c].currentMatch.teamB = teamB;
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/session/match/start ────────────────────────────────
  // Host triggers start of current round match for a court
  if (subpath === '/api/session/match/start' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { court } = JSON.parse(await body());
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    const c = Number(court);
    const ct = session.courts[c];
    const roundNum = session.roundNum;

    let match = null;
    // All rounds use slot-based matching OR pre-generated currentMatch
    // If currentMatch already set (movement rounds), use it
    // Otherwise build from slots (odd=0-3, even=4-7)
    if (ct.currentMatch) {
      match = ct.currentMatch;
    } else {
      match = buildMatchFromSlots(ct.players, roundNum);
      if (!match) return json({ error: `Not enough players for round ${roundNum}` }, 400);
    }

    ct.currentMatch = match;
    await saveSession(mongo, session, lg);
    return json({ success: true, session, match });
  }

  // ── POST /ladder/api/session/match/result ───────────────────────────────
  // Record match result for a court in current round
  if (subpath === '/api/session/match/result' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { court, winner } = JSON.parse(await body());
    if (!['A','B'].includes(winner)) return json({ error: 'winner must be A or B' }, 400);
    const c = Number(court);
    const [players, session, matches] = await Promise.all([loadPlayers(mongo, lg), loadSession(mongo, lg), loadMatches(mongo, lg)]);
    if (!session) return json({ error: 'No session' }, 404);
    const ct = session.courts[c];
    if (!ct.currentMatch) return json({ error: 'No active match for this court' }, 400);

    const { teamA, teamB } = ct.currentMatch;
    const winners = winner === 'A' ? teamA : teamB;
    const losers  = winner === 'A' ? teamB : teamA;
    const week = session.week || 1;
    const roundNum = session.roundNum;
    const ptsAwarded = {};

    // Update player stats
    [...teamA, ...teamB].forEach(h => {
      if (!players[h]) return;
      const won = winners.includes(h);
      const pts = calcPts(c, won);
      players[h].totalPts      = (players[h].totalPts || 0) + pts;
      players[h].wins          = (players[h].wins     || 0) + (won ? 1 : 0);
      players[h].losses        = (players[h].losses   || 0) + (won ? 0 : 1);
      players[h].weekPts       = players[h].weekPts || {};
      players[h].weekPts[week] = (players[h].weekPts[week] || 0) + pts;
      players[h].lastSeen      = new Date().toISOString();
      ptsAwarded[h] = pts;
    });

    // Save round result
    ct.roundResults[roundNum] = { teamA, teamB, winner, winners, losers, ptsAwarded, timestamp: new Date().toISOString() };
    ct.currentMatch = null;
    session.matchCount = (session.matchCount || 0) + 1;

    // Save match log
    matches.push({
      id: crypto.randomBytes(6).toString('hex'),
      sessionId: session.id, sessionName: session.name,
      week, roundNum, court: c, teamA, teamB, winner, ptsAwarded,
      timestamp: new Date().toISOString()
    });

    // Check if ALL courts done for this round → advance round
    const allDone = COURTS.every(court => session.courts[court].roundResults?.[roundNum]);
    if (allDone) {
      session.roundNum = roundNum + 1;

      // Movement after every EVEN round (2, 4, 6, 8...)
      if (roundNum % 2 === 0) {
        // R3 active = W(R1) from each court (cross-court split)
        // R3 bench  = stayed players = R1 losers + R2 losers (slot[0-3] who lost + slot[4-7] who lost)
        // Movement formula uses ODD round (R1, R3, R5...) winners, NOT even round
        const prevOdd = roundNum - 1; // R1 for first cycle, R3 for second, etc.
        const courtResultsW = {}; // winners from odd round
        const courtResultsL = {}; // losers from odd round (used for movement down)
        COURTS.forEach(court => {
          const ro = session.courts[court].roundResults?.[prevOdd];
          if (ro) {
            courtResultsW[court] = { winners: ro.winners, losers: ro.losers };
          }
        });

        const W = c => courtResultsW[c]?.winners || [];
        const L = c => courtResultsW[c]?.losers  || [];

        // Movement: W(R1_C1) + W(R1_C3) → Court 1 R3
        //           W(R1_C5) + L(R1_C1) → Court 3 R3
        //           W(R1_C7) + L(R1_C3) → Court 5 R3
        //           L(R1_C5) + L(R1_C7) → Court 7 R3
        const activeMatches = {
          1: { teamA:[W(1)[0],W(3)[0]], teamB:[W(1)[1],W(3)[1]] },
          3: { teamA:[W(5)[0],L(1)[0]], teamB:[W(5)[1],L(1)[1]] },
          5: { teamA:[W(7)[0],L(3)[0]], teamB:[W(7)[1],L(3)[1]] },
          7: { teamA:[L(5)[0],L(7)[0]], teamB:[L(5)[1],L(7)[1]] },
        };

        COURTS.forEach(court => {
          const ct = session.courts[court];
          const am = activeMatches[court];
          if (!am.teamA[0] || !am.teamA[1] || !am.teamB[0] || !am.teamB[1]) return;

          const activePlayers = [...am.teamA, ...am.teamB]; // 4 active → slot[0-3]

          // Bench (slot[4-7]) = players who stayed = NOT in the R1 odd round movers
          // R1 movers = W(R1) from THIS court (they moved to active) + L(R1) from courts above
          // Actually: bench = all players NOT in activePlayers for this court
          // = R1 losers from this court + R2 losers from this court (they both stayed)
          const r1 = ct.roundResults?.[prevOdd];
          const r2 = ct.roundResults?.[roundNum];
          const r1Losers = r1?.losers || [];
          const r2Losers = r2?.losers || [];
          // bench = losers from both rounds, minus any that ended up as active via cross-court movement
          const bench = [...r1Losers, ...r2Losers].filter(h => !activePlayers.includes(h)).slice(0, 4);

          ct.currentMatch = am;
          ct.players = [...activePlayers, ...bench];
        });
      }
      // No special handling needed for odd rounds — slots[0-3] auto from players array
      // Even rounds use splitBench(players[4-7]) handled in match/start via buildMatchFromSlots
    }

    await Promise.all([savePlayers(mongo, players, lg), saveSession(mongo, session, lg), saveMatches(mongo, matches, lg)]);
    return json({ success: true, ptsAwarded, session, allDone, nextRound: allDone ? session.roundNum : roundNum });
  }

  // ── POST /ladder/api/session/end ────────────────────────────────────────
  if (subpath === '/api/session/end' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const session = await loadSession(mongo, lg);
    if (!session) return json({ error: 'No session' }, 404);
    session.status = 'completed'; session.endedAt = new Date().toISOString();
    await saveSession(mongo, session, lg);
    return json({ success: true, session });
  }

  // ── POST /ladder/api/scores/reset ───────────────────────────────────────
  if (subpath === '/api/scores/reset' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { confirm } = JSON.parse(await body());
    if (confirm !== 'YES_RESET_SCORES') return json({ error: 'Send confirm:"YES_RESET_SCORES"' }, 400);
    const players = await loadPlayers(mongo, lg);
    Object.keys(players).forEach(h => { players[h].totalPts = 0; players[h].wins = 0; players[h].losses = 0; players[h].weekPts = {}; delete players[h].lastSeen; });
    await Promise.all([savePlayers(mongo, players, lg), saveMatches(mongo, [], lg)]);
    return json({ success: true, total: Object.keys(players).length, players });
  }

  // ── POST /ladder/api/reset ───────────────────────────────────────────────
  if (subpath === '/api/reset' && req.method === 'POST') {
    if (!await requireAdmin()) return;
    const { confirm } = JSON.parse(await body());
    if (confirm !== 'YES_RESET_LADDER') return json({ error: 'Send confirm:"YES_RESET_LADDER"' }, 400);
    await Promise.all([savePlayers(mongo, {}, lg), saveSession(mongo, null, lg), saveMatches(mongo, [], lg)]);
    return json({ success: true });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found: ' + subpath }));
};
