const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// ── MongoDB or File fallback ───────────────────────────────
let mongo = null;

async function connectMongo() {
  if (!MONGO_URI) {
    console.log('⚠️  No MONGO_URI set — using local JSON files (data will reset on redeploy!)');
    console.log('   Set MONGO_URI env var on Render to persist data.');
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGO_URI, {serverSelectionTimeoutMS:5000});
    await client.connect();
    await client.db('admin').command({ping:1}); // verify connection
    mongo = client.db('reclub');
    console.log('✓ Connected to MongoDB Atlas — data will persist');
  } catch(e) {
    console.error('✗ MongoDB connection FAILED:', e.message);
    console.error('  Falling back to local JSON files (data will reset on redeploy!)');
    mongo = null;
  }
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FILES = {
  players:'players.json', seasons:'seasons.json', config:'config.json',
  aliases:'aliases.json', users:'users.json', sessions:'sessions.json',
};

async function dbGet(col) {
  if (mongo) {
    const doc = await mongo.collection(col).findOne({ _id: col });
    return doc ? doc.data : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILES[col]), 'utf8')); } catch(e) { return null; }
}
async function dbSet(col, data) {
  if (mongo) {
    await mongo.collection(col).replaceOne({ _id: col }, { _id: col, data }, { upsert: true });
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, FILES[col]), JSON.stringify(data, null, 2));
}

// ── Data helpers ───────────────────────────────────────────
async function loadDB()      { return (await dbGet('players'))  || { players:{} }; }
async function saveDB(d)     { d.lastUpdated=new Date().toISOString(); await dbSet('players',d); }
async function loadSeasons() { return (await dbGet('seasons'))  || { seasons:{} }; }
async function saveSeasons(s){ await dbSet('seasons',s); }
async function loadConfig()  { return (await dbGet('config'))   || { tierSizes:{S:21,A:21,B:22,C:999} }; }
async function saveConfig(c) { await dbSet('config',c); }
async function loadAliases() { return (await dbGet('aliases'))  || {}; }
async function saveAliases(a){ await dbSet('aliases',a); }

function hashPwd(pwd){ return crypto.createHash('sha256').update(pwd+'reclub_salt_2026').digest('hex'); }

async function loadUsers() {
  const u = await dbGet('users');
  if (u) return u;
  const defaults = { users:[{username:'admin',password:hashPwd('admin123'),role:'admin',createdAt:new Date().toISOString()}] };
  await dbSet('users', defaults);
  return defaults;
}
async function saveUsers(u){ await dbSet('users',u); }
async function loadSessions(){ return (await dbGet('sessions')) || {}; }
async function saveSessions(s){ await dbSet('sessions',s); }

function genToken(){ return crypto.randomBytes(32).toString('hex'); }

async function getSession(req){
  const cookie = req.headers.cookie||'';
  const match = cookie.match(/token=([a-f0-9]+)/);
  if(!match) return null;
  const sessions = await loadSessions();
  const s = sessions[match[1]];
  if(!s) return null;
  if(Date.now()-s.createdAt > 30*24*60*60*1000){ delete sessions[match[1]]; await saveSessions(sessions); return null; }
  return s;
}
async function requireAdmin(req,res){
  const s=await getSession(req);
  if(!s||s.role!=='admin'){ res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Admin required'})); return false; }
  return true;
}

// ── League constants ───────────────────────────────────────
const TIER_SCORE = { S:400, A:350, B:300, C:250 };
// Known player handles — all 3 weeks of Season 4 (R84T0F, IRD2YU, UC1049)
// name -> { handle, avatarId, team (latest), court (latest) }
// For same-name different players: key = "name||court"
const KNOWN_PLAYERS = {
  // ── All Season 4 players ────────────────────────────────
  'Shaiful Anuar':       {handle:'@captsa',             avatarId:'713071'},
  'amatlaa':             {handle:'@899',                avatarId:'1095800'},
  'Joe Salleh':          {handle:'@@joe_salleh',        avatarId:'519766'},
  'Coi':                 {handle:'@zaid najmi',         avatarId:'534562'},
  'Najmy Asyraf':        {handle:'@najmyasyraf',        avatarId:'913877'},
  'Hariz':               {handle:'@tedhryz',            avatarId:'376972'},
  'Firdaus Yaacob':      {handle:'@firdaus-yaacob-854', avatarId:'618964'},
  'ahmad naim':          {handle:'@naimsmile',          avatarId:'993694'},
  'Zulkifli':            {handle:'@zulkifli_',          avatarId:'498264'},
  'Aizat Amir':          {handle:'@aizatamir_84',       avatarId:'562780'},
  'Shahir':              {handle:'@shahir-792',         avatarId:'924430'},
  'Eymeerul':            {handle:'@eymrul',             avatarId:'347861'},
  'Fariz Pandi':         {handle:'@fariz-pandi',        avatarId:'600308'},
  'Fathy Azlan':         {handle:'@fathy-azlan-676',    avatarId:'292795'},
  'basyir bazli':        {handle:'@basyir-bazli-13',    avatarId:'1059923'},
  'Thavaganesh':         {handle:'@coolbuddy',          avatarId:'316527'},
  'Faizam Hilmy':        {handle:'@faizam-hilmy-955',   avatarId:'1027123'},
  'Syakir':              {handle:'@akedchan-650',       avatarId:'477900'},
  'Fahmi':               {handle:'@fahmi-175',          avatarId:'1020135'},
  'Danial':              {handle:'@danial-591',         avatarId:'762382'},
  'Hafiz Mar':           {handle:'@apit_mar',           avatarId:'964764'},
  'Mr. Lah':             {handle:'@qaireenads-183',     avatarId:'973454'},
  'Shazrul':             {handle:'@shazrul iman',       avatarId:'546523'},
  'Hasri Hasan':         {handle:'@mhasrihasan',        avatarId:'299693'},
  'Irfan A':             {handle:'@irfana',             avatarId:'64298'},
  'Radzi Moawiah':       {handle:'@radzi-moawiah-799',  avatarId:'604251'},
  'Muzakhkir Amat Nooh': {handle:'@muzakhkir',          avatarId:'982951'},
  'Haikal Roslan':       {handle:'@haikal29',           avatarId:'334653'},
  'Muhammad Fathi':      {handle:'@muhammad-fathi-498', avatarId:'693993'},
  'Pali':                {handle:'@fadzli',             avatarId:'752443'},
  'Ben10':               {handle:'@ben1010',            avatarId:'517843'},
  'Farhad':              {handle:'@farhad-856',         avatarId:'595129'},
  'Fazri Bozz':          {handle:'@mohd-bozz-833',      avatarId:'599461'},
  'Zanny':               {handle:'@zanny-441',          avatarId:'956619'},
  'Hafizal Mohd':        {handle:'@hafizalmohd',        avatarId:'547880'},
  'Khairul Abid':        {handle:'@khairul-abid-664',   avatarId:'455645'},
  'Akmal Nasir Al Jipiepi':{handle:'@akmalnasir',       avatarId:'572055'},
  'Ammar Akid':          {handle:'@ammarakid',          avatarId:'605648'},
  'zamm_':               {handle:'@zem9-0',             avatarId:'486161'},
  'K.A.A 21':            {handle:'@kaa21-964',          avatarId:'959031'},
  'Nazrin':              {handle:'@nazrin-996',         avatarId:'873730'},
  'wai':                 {handle:'@waiwai',             avatarId:'477388'},
  'Kimie':               {handle:'@kimie-889',          avatarId:'903440'},
  'Arif mustaqim':       {handle:'@arifmustaqim',       avatarId:'701005'},
  'Ihsan Amin':          {handle:'@ihsan-379',          avatarId:'717580'},
  'ZoulMiey':            {handle:'@zmiey',              avatarId:'652146'},
  'aimelakmal':          {handle:'@aimelakmal33',       avatarId:'914193'},
  'Moreeza':             {handle:'@moreeza-342',        avatarId:'200008'},
  'Syam Don':            {handle:'@hisyam-don',         avatarId:'1046525'},
  'Irfan Rusli':         {handle:'@irfan-rusli-760',    avatarId:'1049901'},
  'Amarizqy AR':         {handle:'@amarizqy-ar-576',    avatarId:'1049408'},
  'Amin Can':            {handle:'@amin-can-631',       avatarId:'866829'},
  'jonathan.m':          {handle:'@jonathan.m',         avatarId:'462961'},
  'Eiman Affandi':       {handle:'@eiman-affandi-624',  avatarId:'1095827'},
  'Naufal':              {handle:'@d_naufl',            avatarId:'885436'},
  'DHIRAR ZAINAL':       {handle:'@dhirarzainal',       avatarId:'305228'},
  'Aiman Rashid':        {handle:'@aaimanrashid',       avatarId:'963404'},
  'Ikhlash':             {handle:'@ikhlash-842',        avatarId:'854297'},
  'Wandy':               {handle:'@wandy-321',          avatarId:'623200'},
  'Fiy Ruslee':          {handle:'@fiyrusli',           avatarId:'675145'},
  'petchmono':           {handle:'@petchmono',          avatarId:'849050'},
  'Hatim Nazeri':        {handle:'@htmnzr',             avatarId:'351311'},
  'Muhd Ariiq':          {handle:'@potatonggg24',       avatarId:'274268'},
  'RIDUANBAKHIR':        {handle:'@riduanbakhir-946',   avatarId:'96069'},
  'Danial Darwis':       {handle:'@danial darwis',      avatarId:'866737'},
  'Syahrizan Jaffar':    {handle:'@ijanxmyhc',          avatarId:'1006655'},
  'Fitri Anuar':         {handle:'@fitrianuar',         avatarId:'779517'},
  'Aleef':               {handle:'@aleef-318',          avatarId:'184147'},
  'Ayie':                {handle:'@mohd-suhairie-557',  avatarId:'614081'},
  'Amar':                {handle:'@amargunnex',         avatarId:'604718'},
  'Khairol Azmi Yussof': {handle:'@khairol_azmi',       avatarId:'179300'},
  // W2 only players
  'Firdhaus':            {handle:'@firdhauschase',      avatarId:'461577'},
  'Raidi Roslee':        {handle:'@raidi roslee',       avatarId:'709193'},
  'Syazwan Khairi':      {handle:'@syazwan-khairi-680', avatarId:'975978'},
  'Azrul zaidi':         {handle:'@azrulzaidi74',       avatarId:'355292'},
  'Jaze':                {handle:'@mohamad-faiz-439',   avatarId:'930470'},
  'Farid':               {handle:'@farid-858',          avatarId:'640287'},
  'Idan':                {handle:'@kamalarrasydan',     avatarId:'671997'},
  'mirulz':              {handle:'@mirulz08',           avatarId:'879964'},
  'YEN R':               {handle:'@yen_r',              avatarId:'978250'},
  "arieff 'A":           {handle:'@arieffariffin',      avatarId:'554140'},
  "arieff ‘A":          {handle:'@arieffariffin',      avatarId:'554140'},
  "arieff ’A":          {handle:'@arieffariffin',      avatarId:'554140'},
  // Week 4 new players
  "Isnu":                {handle:'@isnu1210',            avatarId:'322814'},
  "Danial Darwis":       {handle:'@danial darwis',       avatarId:'866737'},
  "Eymeerul":            {handle:'@eymrul',              avatarId:'347861'},
  "Rizal":               {handle:'@rizal-470',           avatarId:'742677'},
  "Jegan":               {handle:'@jegan-948',           avatarId:'584033'},
  "Jabir Malik":         {handle:'@jabir-malik-69',      avatarId:'695270'},
  "Thabrani":            {handle:'@thabrani-marwan-384', avatarId:'552692'},
  "Karl.El":             {handle:'@karlhamzah',          avatarId:'65979'},
  "FarizSan":            {handle:'@farizsan',            avatarId:'1083786'},
  "∆p!z":                {handle:'@apishx',              avatarId:'559983'},
  "Azhar y":             {handle:'@azhar-y-479',         avatarId:'364361'},
  "Fariz Pandi":         {handle:'@fariz-pandi',         avatarId:'600308'},
  "Ezuardi":             {handle:'@ezuardi2005',         avatarId:'1009149'},
  'Nafees Najib':        {handle:'@nafeesnajib',        avatarId:'547514'},
  'Lutfi Daud':          {handle:'@lutfidaud',          avatarId:'428885'},
  'Alif Noor':           {handle:'@malifnoor',          avatarId:'393351'},
  // W3 only players
  'Mujahid Shukri':      {handle:'@mujahid-shukri-585', avatarId:'756383'},
  'ali yepe':            {handle:'@yepelus',            avatarId:'1156000'},
  'Poji Stiffler':       {handle:'@poji-stiffler-960',  avatarId:'1297958'},
  'Hazwan Mohamad':      {handle:'@hazwan-mohamad-820', avatarId:'1043723'},
  'Rizal':               {handle:'@rizal-470',          avatarId:'742677'},
  '#15 Ayie \uD83D\uDEEB': {handle:'@ayieikie93',    avatarId:'15973'},
  '#15 Ayie 🛫':         {handle:'@ayieikie93',         avatarId:'15973'},
  'Azhar y':             {handle:'@azhar-y-479',        avatarId:'364361'},
  'Ezuardi':             {handle:'@ezuardi2005',        avatarId:'1009149'},
  'Isnu':                {handle:'@isnu1210',           avatarId:'322814'},
  // Two Faiz players — court disambiguates
  'Faiz||Court 7':       {handle:'@faiz60111',          avatarId:'1035005'},
  'Faiz||Court 8':       {handle:'@faiz-979',           avatarId:'689636'},
  // Two Afiq players — both registered separately
  'Afiq':                {handle:'@afiq-524',           avatarId:'368697'},  // W3 Light Blue default
  'Afiq (afiqim00)':     {handle:'@afiqim00',           avatarId:'210956'},  // W1/W2 Afiq
  // Court-based disambiguation (used by load match)
  'Afiq||Court 2':       {handle:'@afiq-524',           avatarId:'368697'},
  'Afiq||Court 6':       {handle:'@afiq-524',           avatarId:'368697'},
  'Afiq||Court 8':       {handle:'@afiqim00',           avatarId:'210956'},
};

function normalizeName(n) {
  // Normalize apostrophes/quotes for consistent matching
  return (n||'').replace(/[\u2018\u2019\u201a\u201b\u2032\u0060]/g,"'").trim();
}

function lookupKnownPlayer(name, court) {
  const norm = normalizeName(name);
  // Check court-specific key first (for duplicate names)
  if(KNOWN_PLAYERS[name+'||'+court]) return KNOWN_PLAYERS[name+'||'+court];
  if(KNOWN_PLAYERS[norm+'||'+court]) return KNOWN_PLAYERS[norm+'||'+court];
  // Check direct name match
  if(KNOWN_PLAYERS[name]) return KNOWN_PLAYERS[name];
  if(KNOWN_PLAYERS[norm]) return KNOWN_PLAYERS[norm];
  // Case-insensitive with normalization
  const lower = norm.toLowerCase();
  const key = Object.keys(KNOWN_PLAYERS).find(k=>normalizeName(k).toLowerCase()===lower);
  return key ? KNOWN_PLAYERS[key] : null;
}

// Default team→court mapping (can be overridden in config)
const DEFAULT_TEAM_COURT = {
  'red':'Court 1','white':'Court 2','blue':'Court 3','black':'Court 4',
  'yellow':'Court 5','light blue':'Court 6','gray':'Court 7','grey':'Court 7','green':'Court 8',
};
const TEAM_COLORS = {
  'red':'#e53935','white':'#bdbdbd','blue':'#1565c0','black':'#616161',
  'yellow':'#f9a825','light blue':'#0288d1','gray':'#757575','grey':'#757575','green':'#2e7d32',
};

// Get live mapping from config (falls back to default)
async function getTeamCourtMap() {
  const cfg = await loadConfig();
  return cfg.teamCourtMap || DEFAULT_TEAM_COURT;
}

// ── Scoring ────────────────────────────────────────────────
function findPlayerInDB(name, db) {
  const nameKey = normalizeName(name).toLowerCase().trim();
  // Try name key first
  if(db.players[nameKey]) return db.players[nameKey];
  // Search by name field (with apostrophe normalization)
  const found = Object.values(db.players).find(p=>
    p.name && normalizeName(p.name).toLowerCase().trim()===nameKey
  );
  return found || null;
}

function calcCourtScore(playerNames, db, isWeek1, tierSnapshot) {
  if (isWeek1) return 200;
  const scores = playerNames.map(n => {
    const nk = normalizeName(n).toLowerCase().trim();
    // Use week's own tier snapshot if available — most accurate
    let tier = tierSnapshot?.[nk] || null;
    if(!tier){
      const p = findPlayerInDB(n, db);
      tier = p?.tier || null;
    }
    if (!tier||!TIER_SCORE[tier]) console.warn('  ⚠️  No tier: "'+n+'" → C (250)');
    return TIER_SCORE[tier] || 250;
  });
  return Math.round(scores.reduce((a,b)=>a+b,0) / playerNames.length);
}
function rankPoints(rank, courtScore) { return Math.round(courtScore * Math.pow(0.85, rank-1)); }

function calcStandings(matches, db, isWeek1, tierSnapshot) {
  const courts = {};
  matches.forEach(m => {
    if (!courts[m.court]) courts[m.court] = {};
    const c = courts[m.court];
    const w1 = m.s1>m.s2;
    [[m.t1a,m.s1,m.s2,w1],[m.t1b,m.s1,m.s2,w1],[m.t2a,m.s2,m.s1,!w1],[m.t2b,m.s2,m.s1,!w1]].forEach(([p,pf,pa,win])=>{
      if(!c[p]) c[p]={wins:0,diff:0};
      c[p].diff+=(pf-pa); if(win) c[p].wins++;
    });
  });
  const courtResults={}, playerWeekPoints={};
  Object.entries(courts).forEach(([court,players])=>{
    const list=Object.keys(players);
    const courtScore=calcCourtScore(list,db,isWeek1,tierSnapshot);
    const sorted=list.map(n=>({name:n,...players[n]})).sort((a,b)=>b.wins-a.wins||b.diff-a.diff);
    courtResults[court]=sorted.map((p,idx)=>{
      const rank=idx+1, weekPoints=rankPoints(rank,courtScore);
      // Use "name||court" key to avoid collision for same-name players on different courts
      const key = p.name+'||'+court;
      playerWeekPoints[key]=weekPoints;
      // Also set by name alone (last court wins — but courtResults has correct value per court)
      playerWeekPoints[p.name]=weekPoints;
      return {player:p.name,rank,wins:p.wins,diff:p.diff,courtScore,weekPoints};
    });
  });
  return {courtResults,playerWeekPoints};
}

function autoAssignTiers(seasonData, tierSizes) {
  const totals = {};
  Object.values(seasonData.weeks||{}).forEach(w => {
    // Wins/diff from all match results
    Object.values(w.courtResults||{}).forEach(cp => {
      cp.forEach(r => {
        const pn = normalizeName(r.player);
        if (!totals[pn]) totals[pn] = { wins:0, diff:0, points:0 };
        totals[pn].wins += r.wins||0;
        totals[pn].diff += r.diff||0;
      });
    });
    // Points — deduplicated per week (avoid same-name on different courts)
    const _seen = {};
    Object.values(w.courtResults||{}).forEach(cp => {
      cp.forEach(r => {
        const pn = normalizeName(r.player);
        if(!_seen[pn]){
          if(!totals[pn]) totals[pn]={wins:0,diff:0,points:0};
          totals[pn].points += r.weekPoints||0;
          _seen[pn] = true;
        }
      });
    });
  });
  const ranked = Object.entries(totals).sort((a,b) =>
    b[1].points-a[1].points || b[1].diff-a[1].diff || b[1].wins-a[1].wins
  );
  const assignments = {};
  let idx = 0;
  for (const tier of ['S','A','B','C']) {
    const size = tier==='C' ? Infinity : (tierSizes[tier]||21);
    const count = Math.min(size, ranked.length-idx);
    for (let i=0; i<count; i++) {
      if (idx < ranked.length) {
        const [pName, pData] = ranked[idx];
        assignments[pName] = { tier, rank:idx+1, totalPoints:pData.points, totalWins:pData.wins, totalDiff:pData.diff };
        idx++;
      }
    }
  }
  return assignments;
}

// ── Fetch & parse ──────────────────────────────────────────
function fetchURL(targetUrl, extraHeaders={}) {
  return new Promise((resolve,reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      ...extraHeaders
    };
    const req = lib.get(targetUrl,{headers},(res)=>{
      // Follow redirects
      if(res.statusCode===301||res.statusCode===302){
        return fetchURL(res.headers.location||targetUrl,extraHeaders).then(resolve).catch(reject);
      }
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(20000,()=>{req.destroy();reject(new Error('Timeout'));});
  });
}

// Fetch meet page and extract player data from embedded JSON chunks
// Reclub embeds data as window.__data__ or similar patterns
function extractPlayersFromHTML(html) {
  const results = [];
  // Pattern 1: JSON chunks with username + avatarId in script tags
  const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for(const sm of scriptMatches) {
    const script = sm[1];
    if(script.includes('avatarId') || script.includes('username')) {
      // Try to find player-like objects
      const playerPattern = /"username":"([^"]+)"[^}]*"avatarId":(\d+)[^}]*"displayName":"([^"]+)"/g;
      const playerPattern2 = /"displayName":"([^"]+)"[^}]*"username":"([^"]+)"[^}]*"avatarId":(\d+)/g;
      let m;
      while((m = playerPattern.exec(script)) !== null)  results.push({username:m[1],avatarId:m[2],name:m[3]});
      while((m = playerPattern2.exec(script)) !== null) results.push({name:m[1],username:m[2],avatarId:m[3]});
    }
  }
  // Pattern 2: inline JSON data anywhere in HTML
  const inlinePattern = /"username":"([^"]+)","avatarId":(\d+)[^}]*"displayName":"([^"]+)"/g;
  let m2;
  while((m2 = inlinePattern.exec(html)) !== null) results.push({username:m2[1],avatarId:m2[2],name:m2[3]});
  return results;
}
function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<img[^>]*>/gi,'').replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/?(div|p|h[1-6]|li|tr|td|th|span|section)[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#?\w+;/g,' ');
}
function parseScoresheet(html) {
  const text=stripHTML(html);
  const lines=text.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  let title='Match Results', date='';
  for(let i=0;i<Math.min(lines.length,30);i++){
    if(lines[i].toUpperCase()===lines[i]&&lines[i].length>10&&/CHALLENGE|LEAGUE|CUP|TOURNAMENT|TIER|WOMEN|MEN|OPEN/.test(lines[i])){title=lines[i];break;}
  }
  for(let i=0;i<Math.min(lines.length,40);i++){
    if(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/i.test(lines[i])){date=lines[i];break;}
  }
  const matches=[];
  let round=null,court=null,i=0;
  const isScore=v=>{const n=parseInt(v);return!isNaN(n)&&n>=0&&n<=30&&String(v).trim()===String(n);};
  const isName=v=>v.length>0&&!isScore(v)&&v!=='Round'&&!/^Court\s+\d+$/.test(v)&&
    !['Powered by Reclub','Print'].includes(v)&&!/^(Printable|Note:|This is)/.test(v);
  while(i<lines.length){
    const line=lines[i];
    if(line==='Round'&&lines[i+1]&&!isNaN(parseInt(lines[i+1]))){round=parseInt(lines[i+1]);i+=2;continue;}
    if(/^Court\s+\d+$/.test(line)){court=line;i++;continue;}
    if(round&&court&&i+5<lines.length){
      const[t1a,t1b,s1,t2a,t2b,s2]=[lines[i],lines[i+1],lines[i+2],lines[i+3],lines[i+4],lines[i+5]];
      if(isName(t1a)&&isName(t1b)&&isScore(s1)&&isName(t2a)&&isName(t2b)&&isScore(s2)){
        matches.push({round,court,t1a,t1b,s1:parseInt(s1),t2a,t2b,s2:parseInt(s2)});
        i+=6;continue;
      }
    }
    i++;
  }
  return{title,date,matches};
}
// Build Reclub avatar URL from avatarId
function avatarUrl(avatarId){ return `https://assets.reclub.co/user-avatars/${avatarId}.webp`; }

function extractNextData(html) {
  // Next.js embeds all page data as JSON in <script id="__NEXT_DATA__">
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try { return JSON.parse(match[1]); } catch(e) { return null; }
  }
  return null;
}

function parseMeetPage(html, teamCourtMap) {
  const tcm = teamCourtMap || DEFAULT_TEAM_COURT;
  const players={}, playersByHandle={}, playersByCourtName={};

  // ── Strategy 1: Extract from __NEXT_DATA__ JSON (most reliable) ─
  const nextData = extractNextData(html);
  if (nextData) {
    try {
      // Navigate to meet data — path varies but usually in props.pageProps
      const pageProps = nextData?.props?.pageProps || nextData?.props || {};
      // Find meet object containing registrations/teams
      const findMeet = (obj, depth=0) => {
        if (depth > 6 || !obj || typeof obj !== 'object') return null;
        // Look for registrations array or teams object
        if (obj.registrations || obj.teams || obj.participants) return obj;
        if (Array.isArray(obj)) {
          for (const item of obj) { const r = findMeet(item, depth+1); if(r) return r; }
        } else {
          for (const val of Object.values(obj)) { const r = findMeet(val, depth+1); if(r) return r; }
        }
        return null;
      };

      const meetObj = findMeet(pageProps);
      console.log('__NEXT_DATA__ keys at pageProps:', Object.keys(pageProps).slice(0,10));
      if (meetObj) {
        console.log('Found meet object with keys:', Object.keys(meetObj).slice(0,10));
      }

      // Try to find user/player objects with avatarId and username
      const findPlayers = (obj, depth=0) => {
        if (depth > 8 || !obj || typeof obj !== 'object') return [];
        if (Array.isArray(obj)) {
          return obj.flatMap(item => findPlayers(item, depth+1));
        }
        // A player object has username/handle + avatarId/avatar
        if ((obj.username || obj.handle) && (obj.avatarId || obj.avatar || obj.name || obj.displayName)) {
          return [obj];
        }
        return Object.values(obj).flatMap(val => findPlayers(val, depth+1));
      };

      const foundPlayers = findPlayers(pageProps);
      console.log('Players found in __NEXT_DATA__:', foundPlayers.length);

      if (foundPlayers.length > 0) {
        foundPlayers.forEach(u => {
          const handle   = u.username ? '@'+u.username : u.handle || null;
          const avatarId = u.avatarId || u.avatar?.id || null;
          const name     = u.displayName || u.name || u.username || '';
          const team     = u.team?.name || u.teamName || null;
          if (!name || !handle) return;
          const tl    = (team||'').toLowerCase();
          const court = tcm[tl] || null;
          const p = {name, handle, avatarId: String(avatarId||''),
            photoUrl: avatarId ? avatarUrl(String(avatarId)) : null,
            team, court, teamColor: TEAM_COLORS[tl]||'#888'};
          players[name] = p;
          if(handle) playersByHandle[handle] = p;
          if(court)  playersByCourtName[name+'||'+court] = p;
        });
        console.log('parseMeetPage via __NEXT_DATA__: found', Object.keys(players).length, 'players');
        if(Object.keys(players).length > 0)
          return {players, playersByHandle, playersByCourtName};
      }
    } catch(e) {
      console.log('__NEXT_DATA__ parse error:', e.message);
    }
  }

  // ── Strategy 2: use regex on full HTML (not line-by-line) ─
  // The raw HTML has player blocks like:
  // <a href="https://reclub.co/players/@handle"><img src=".../user-avatars/NNN.webp">Name</a>
  // OR spread across a few lines.
  // We find each player by their handle link + avatar img.

  // Step 1: Find the Waitlisted section — cut off HTML there
  const waitlistIdx = html.search(/Waitlisted/i);
  const confirmedHtml = waitlistIdx > 0 ? html.substring(0, waitlistIdx) : html;

  // Step 2: Find all team sections + their player blocks
  // Split by team headings to know which team each player belongs to
  let currentTeam = null;
  let pos = 0;
  const teamRegex = />(\w[\w\s]*?)\s+team\s*</gi;

  // Step 3: Extract ALL player entries using a comprehensive regex
  // Pattern covers both single-line and multi-line player entries
  // Each player: avatar img + link with handle + name
  const playerRegex = /user-avatars\/([\d]+)\.webp[^<]*<[^>]*>[\s\S]*?players\/@([^"\s\)]+)[^>]*>([^<]+)<\/a>/gi;

  // First pass: map positions of team headers
  const teamPositions = [];
  let tmatch;
  const teamRegex2 = />(\w[\w\s]*?)\s+team\s*</gi;
  while((tmatch = teamRegex2.exec(confirmedHtml)) !== null){
    const t = tmatch[1].trim().toLowerCase();
    if(tcm[t] !== undefined || TEAM_COLORS[t]){
      teamPositions.push({pos: tmatch.index, team: tmatch[1].trim()});
    }
  }

  // Second pass: extract all players, find their nearest preceding team
  let pmatch;
  const playerRegex2 = /user-avatars\/(\d+)\.webp/g;
  while((pmatch = playerRegex2.exec(confirmedHtml)) !== null){
    const avatarPos = pmatch.index;
    const avatarId  = pmatch[1];

    // Find nearest team header BEFORE this avatar
    let team = null;
    for(let t=teamPositions.length-1; t>=0; t--){
      if(teamPositions[t].pos < avatarPos){ team = teamPositions[t].team; break; }
    }

    // Find handle + name in the surrounding HTML (up to 500 chars after avatar)
    const chunk = confirmedHtml.substring(avatarPos, avatarPos + 500);
    const linkMatch = chunk.match(/players\/@([^"\s)]+)[^>]*>([^<]+)<\/a>/);
    if(!linkMatch) continue;

    const handle = '@' + linkMatch[1];
    const name   = linkMatch[2].trim();
    if(!name || name.length < 1) continue;

    const tl    = (team||'').toLowerCase();
    const court = tcm[tl] || null;

    const p = {name, handle, avatarId,
      photoUrl:  avatarUrl(avatarId),
      team:      team||null,
      court,
      teamColor: TEAM_COLORS[tl] || '#888'
    };

    // Only add if not already seen (avoid duplicates from repeated img tags)
    if(!players[name]) {
      players[name] = p;
      if(handle) playersByHandle[handle] = p;
      if(court)  playersByCourtName[name+'||'+court] = p;
    }
  }

  console.log('parseMeetPage: found', Object.keys(players).length, 'confirmed players');
  if(Object.keys(players).length === 0){
    console.log('WARNING: 0 players found. HTML length:', html.length,
      '| Sample:', html.substring(0, 200).replace(/\n/g,' '));
  }
  return {players, playersByHandle, playersByCourtName};
}
function fuzzyMatch(sn,mp){
  const s=sn.toLowerCase().trim();
  if(mp[sn])return mp[sn];
  const ci=Object.keys(mp).find(k=>k.toLowerCase()===s);if(ci)return mp[ci];
  const pt=Object.keys(mp).find(k=>{const m=k.toLowerCase();return m.includes(s)||s.includes(m)||m.split(' ')[0]===s.split(' ')[0];});
  if(pt)return mp[pt];
  const bg=s=>{const b=new Set();for(let i=0;i<s.length-1;i++)b.add(s[i]+s[i+1]);return b;};
  let best=null,bs=0.6;
  Object.keys(mp).forEach(k=>{const a=bg(s),b=bg(k.toLowerCase());let inter=0;a.forEach(g=>{if(b.has(g))inter++;});const sc=(2*inter)/(a.size+b.size);if(sc>bs){bs=sc;best=k;}});
  return best?mp[best]:null;
}
function resolvePlayer(name,court,aliases,playersByCourtName){
  // 1. Manual alias takes priority
  if(aliases[name+'||'+court]) return aliases[name+'||'+court];
  // 2. Court+name match → use handle as DB key (unique, prevents same-name collision)
  if(playersByCourtName && playersByCourtName[name+'||'+court]){
    const p = playersByCourtName[name+'||'+court];
    if(p.handle) return p.handle.replace('@','').toLowerCase().trim();
  }
  // 3. Name-only fuzzy — still try to get handle from meetPlayers
  return name.toLowerCase().trim();
}

// Build DB key from handle (preferred) or name
function dbKeyFromHandle(handle, name){
  if(handle) return handle.replace('@','').toLowerCase().trim();
  return name.toLowerCase().trim();
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async(req,res)=>{
  const parsed = new URL(req.url,'http://localhost');
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(200);return res.end();}
  const json=(d,c=200)=>{res.writeHead(c,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(d));};
  const body=()=>new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(b));});

  if(pathname==='/'||pathname==='/index.html'){
    try{const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(html);}
    catch(e){res.writeHead(500);return res.end('index.html not found');}
  }

  // Auth
  if(pathname==='/auth/login'&&req.method==='POST'){
    const{username,password}=JSON.parse(await body());
    const{users}=await loadUsers();
    const user=users.find(u=>u.username===username&&u.password===hashPwd(password));
    if(!user) return json({error:'Invalid username or password'},401);
    const token=genToken();
    const sessions=await loadSessions();
    sessions[token]={username:user.username,role:user.role,createdAt:Date.now()};
    await saveSessions(sessions);
    const isHttps = req.headers['x-forwarded-proto']==='https';
    const cookieFlags = isHttps ? '; Secure; SameSite=None' : '; SameSite=Lax';
    res.setHeader('Set-Cookie',`token=${token}; Path=/; HttpOnly; Max-Age=${30*24*60*60}${cookieFlags}`);
    return json({success:true,username:user.username,role:user.role});
  }
  if(pathname==='/auth/logout'&&req.method==='POST'){
    const cookie=req.headers.cookie||'';
    const match=cookie.match(/token=([a-f0-9]+)/);
    if(match){const s=await loadSessions();delete s[match[1]];await saveSessions(s);}
    const isHttps2 = req.headers['x-forwarded-proto']==='https';
    const clearFlags = isHttps2 ? '; Secure; SameSite=None' : '; SameSite=Lax';
    res.setHeader('Set-Cookie',`token=; Path=/; Max-Age=0${clearFlags}`);
    return json({success:true});
  }
  if(pathname==='/auth/me'&&req.method==='GET'){const s=await getSession(req);return json(s?{loggedIn:true,username:s.username,role:s.role}:{loggedIn:false});}
  if(pathname==='/auth/users'&&req.method==='GET'){if(!await requireAdmin(req,res))return;const{users}=await loadUsers();return json(users.map(u=>({username:u.username,role:u.role,createdAt:u.createdAt})));}
  if(pathname==='/auth/users'&&req.method==='POST'){
    if(!await requireAdmin(req,res))return;
    const{username,password,role}=JSON.parse(await body());
    if(!username||!password||!['admin','viewer'].includes(role))return json({error:'username, password, role required'},400);
    const data=await loadUsers();
    if(data.users.find(u=>u.username===username))return json({error:'Username already exists'},400);
    data.users.push({username,password:hashPwd(password),role,createdAt:new Date().toISOString()});
    await saveUsers(data);return json({success:true});
  }
  if(pathname.startsWith('/auth/users/')&&req.method==='DELETE'){
    if(!await requireAdmin(req,res))return;
    const username=pathname.split('/')[3];
    const data=await loadUsers();data.users=data.users.filter(u=>u.username!==username);
    await saveUsers(data);return json({success:true});
  }
  if(pathname.match(/^\/auth\/users\/[^/]+\/password$/)&&req.method==='PUT'){
    const s=await getSession(req);if(!s)return json({error:'Not logged in'},401);
    const username=pathname.split('/')[3];
    if(s.role!=='admin'&&s.username!==username)return json({error:'Forbidden'},403);
    const{newPassword}=JSON.parse(await body());
    if(!newPassword||newPassword.length<4)return json({error:'Min 4 characters'},400);
    const data=await loadUsers();const user=data.users.find(u=>u.username===username);
    if(!user)return json({error:'User not found'},404);
    user.password=hashPwd(newPassword);await saveUsers(data);return json({success:true});
  }

  // Protect writes
  const WRITE_PATHS=['/seasons/save','/seasons/week','/seasons/assign-tiers','/db/player','/db/bulk','/db/roster','/db/dedupe','/db/clean','/import-all','/config','/aliases'];
  // /db/auto-populate and /db/strip-location are intentionally NOT protected — needed on startup
  if(WRITE_PATHS.some(p=>pathname===p||pathname.startsWith(p))&&req.method!=='GET'){
    const s=await getSession(req);
    if(!s||s.role!=='admin'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Admin required'}));return;}
  }

  if(pathname==='/config'&&req.method==='GET')return json(await loadConfig());
  if(pathname==='/config'&&req.method==='POST'){const c=JSON.parse(await body());await saveConfig(c);return json({success:true,config:c});}
  if(pathname==='/db'&&req.method==='GET'){
    const db = await loadDB();
    // Enrich with fresh photoUrl derived from avatarId
    Object.values(db.players).forEach(p=>{
      if(p.avatarId && !p.photoUrl) p.photoUrl = avatarUrl(p.avatarId);
      if(p.avatarId) p.photoUrl = avatarUrl(p.avatarId); // always refresh
    });
    return json(db);
  }
  if(pathname==='/db/player'&&req.method==='POST'){
    const d=JSON.parse(await body());if(!d.name)return json({error:'name required'},400);
    const db=await loadDB();

    // Determine the old entry key — use oldHandle if provided (most precise)
    const oldHandleKey = d.oldHandle ? d.oldHandle.replace('@','').toLowerCase().trim() : null;
    const newHandleKey = d.handle   ? d.handle.replace('@','').toLowerCase().trim()   : null;
    const nameKey      = d.name.toLowerCase().trim();

    // Find existing entry: oldHandle key → newHandle key → name key
    const existing = (oldHandleKey&&db.players[oldHandleKey])
      || (newHandleKey&&db.players[newHandleKey])
      || db.players[nameKey]
      || {};

    const oldKey = oldHandleKey || newHandleKey || nameKey;
    const newKey = newHandleKey || nameKey;

    const {photoUrl,oldHandle,court,team,teamColor,...dClean} = d; // strip non-DB fields
    db.players[newKey]={
      ...existing,
      ...dClean,
      // Never store team/court/teamColor — changes every week
      team: undefined, court: undefined, teamColor: undefined,
      addedAt: existing.addedAt||new Date().toISOString()
    };
    // Clean up undefined fields
    delete db.players[newKey].team;
    delete db.players[newKey].court;
    delete db.players[newKey].teamColor;
    db.players[newKey].photoUrl = db.players[newKey].avatarId ? avatarUrl(db.players[newKey].avatarId) : null;

    // Clean up old key if it changed
    if(oldKey !== newKey){
      if(db.players[oldKey]) delete db.players[oldKey];
    }
    // Never delete the name key if other players still point to it
    // (different player with same name on different court keeps their own entry)

    // Final cleanup — ensure no team/court stored
    delete db.players[newKey].team;
    delete db.players[newKey].court;
    delete db.players[newKey].teamColor;
    await saveDB(db);return json({success:true,player:db.players[newKey]});
  }
  // Update handles/avatarId for existing players without changing tiers
  if(pathname==='/db/update-handles'&&req.method==='POST'){
    const{meetUrl}=JSON.parse(await body());
    if(!meetUrl)return json({error:'meetUrl required'},400);
    try{
      const tcm=await getTeamCourtMap();
      const html=await fetchURL(meetUrl);
      const{players:mp,playersByCourtName}=parseMeetPage(html,tcm);
      const db=await loadDB();
      let updated=0, skipped=0, added=0;
      const matchLog=[];

      // Build a map of all existing DB players for fuzzy lookup
      const existingPlayers = Object.entries(db.players)
        .filter(([k,v])=>v.name) // only real entries
        .map(([k,v])=>({key:k, name:v.name, nameLower:v.name.toLowerCase().trim()}));

      Object.values(mp).forEach(meetPlayer=>{
        const handleKey = meetPlayer.handle ? meetPlayer.handle.replace('@','').toLowerCase().trim() : null;
        const nameLower = meetPlayer.name.toLowerCase().trim();

        // Match ONLY by exact full name (case-insensitive) or handle key
        // No fuzzy matching — prevents wrong merges like "Khairul Azmi" ≠ "Khairul Abid"
        let match = existingPlayers.find(e=>e.nameLower===nameLower);
        if(!match && handleKey) match = existingPlayers.find(e=>e.key===handleKey);

        // Also check known players lookup
        if(!match){
          const known = lookupKnownPlayer(meetPlayer.name, meetPlayer.court||'');
          if(known && !meetPlayer.handle) meetPlayer = {...meetPlayer, ...known};
        }

        if(match){
          const existing = db.players[match.key];
          if(existing.handle && existing.avatarId){
            skipped++; return; // already has handle
          }
          // Update fields — keep tier!
          existing.handle    = meetPlayer.handle;
          existing.avatarId  = meetPlayer.avatarId;
          // team/court NOT stored — changes per week
          // team/court NOT stored — changes per week
          // team/court NOT stored — changes per week
          // If handle key is different, also index by handle
          // Migrate to handle key if different — remove old name key
          if(handleKey && handleKey!==match.key){
            db.players[handleKey] = existing;
            delete db.players[match.key]; // remove old name-based key
          }
          matchLog.push({dbName:existing.name, meetName:meetPlayer.name, handle:meetPlayer.handle});
          updated++;
        } else {
          // Not found — add as new player
          const saveKey = handleKey || nameLower;
          db.players[saveKey]={name:meetPlayer.name, tier:'C',
            handle:meetPlayer.handle, avatarId:meetPlayer.avatarId,
            // team/court NOT stored — changes per week
            addedAt:new Date().toISOString()};
          if(handleKey && nameLower!==handleKey) db.players[nameLower]=db.players[saveKey];
          added++;
          matchLog.push({dbName:'(new)', meetName:meetPlayer.name, handle:meetPlayer.handle});
        }
      });

      await saveDB(db);
      console.log('Update handles matches:', matchLog.map(m=>`${m.meetName}→${m.handle}`).join(', '));
      return json({success:true, updated, skipped, added, total:Object.keys(db.players).length, matchLog});
    }catch(e){console.error(e);return json({error:e.message},500);}
  }

  // Remove duplicate entries — group by name AND by handle
  if(pathname==='/db/dedupe'&&req.method==='POST'){
    const db=await loadDB();
    const TIER_ORDER={S:4,A:3,B:2,C:1};

    // Step 1: group by display name (case-insensitive)
    const byName={};
    Object.entries(db.players).forEach(([k,v])=>{
      if(!v.name) return;
      const n=v.name.toLowerCase().trim();
      if(!byName[n]) byName[n]=[];
      byName[n].push({key:k,player:{...v}});
    });

    const toDelete=new Set();

    Object.values(byName).forEach(entries=>{
      if(entries.length<=1) return;
      // Score: tier rank (most important) then handle then avatarId
      entries.sort((a,b)=>{
        const sa=(TIER_ORDER[a.player.tier]||0)*100+(a.player.handle?10:0)+(a.player.avatarId?1:0);
        const sb=(TIER_ORDER[b.player.tier]||0)*100+(b.player.handle?10:0)+(b.player.avatarId?1:0);
        return sb-sa;
      });
      const best=entries[0];
      // Merge data from duplicates into winner
      entries.slice(1).forEach(e=>{
        if(!best.player.handle   && e.player.handle)    best.player.handle=e.player.handle;
        if(!best.player.avatarId && e.player.avatarId)  best.player.avatarId=e.player.avatarId;
        if(!best.player.team     && e.player.team)      best.player.team=e.player.team;
        if(!best.player.teamColor&& e.player.teamColor) best.player.teamColor=e.player.teamColor;
        if(!best.player.court    && e.player.court)     best.player.court=e.player.court;
        if((TIER_ORDER[e.player.tier]||0)>(TIER_ORDER[best.player.tier]||0))
          best.player.tier=e.player.tier;
        toDelete.add(e.key);
      });
      db.players[best.key]=best.player;
    });

    // Step 2: also group by handle — same handle = same person
    const byHandle={};
    Object.entries(db.players).forEach(([k,v])=>{
      if(!v.handle||toDelete.has(k)) return;
      const h=v.handle.toLowerCase().trim();
      if(!byHandle[h]) byHandle[h]=[];
      byHandle[h].push({key:k,player:{...v}});
    });
    Object.values(byHandle).forEach(entries=>{
      if(entries.length<=1) return;
      entries.sort((a,b)=>{
        const sa=(TIER_ORDER[a.player.tier]||0)*100+(a.player.avatarId?1:0);
        const sb=(TIER_ORDER[b.player.tier]||0)*100+(b.player.avatarId?1:0);
        return sb-sa;
      });
      const best=entries[0];
      entries.slice(1).forEach(e=>{
        if((TIER_ORDER[e.player.tier]||0)>(TIER_ORDER[best.player.tier]||0)) best.player.tier=e.player.tier;
        toDelete.add(e.key);
      });
      db.players[best.key]=best.player;
    });

    toDelete.forEach(k=>delete db.players[k]);
    await saveDB(db);
    return json({success:true, removed:toDelete.size, total:Object.keys(db.players).length});
  }

  if(pathname==='/db/bulk'&&req.method==='POST'){
    const{meetUrl,defaultTier}=JSON.parse(await body());
    if(!meetUrl)return json({error:'meetUrl required'},400);
    try{
      const tcm=await getTeamCourtMap();
      const html=await fetchURL(meetUrl);const{players:mp}=parseMeetPage(html,tcm);
      const db=await loadDB();let added=0,updated=0;
      Object.values(mp).forEach(p=>{
        // Use handle as primary key to prevent same-name collisions
        const key = p.handle ? p.handle.replace('@','').toLowerCase().trim() : p.name.toLowerCase().trim();
        const nameKey = p.name.toLowerCase().trim();
        const existed = !!db.players[key] || !!db.players[nameKey];
        const existingTier = db.players[key]?.tier || db.players[nameKey]?.tier;
        db.players[key]={name:p.name,tier:existingTier||defaultTier||'C',
          handle:p.handle, avatarId:p.avatarId,
          // photoUrl derived from avatarId always — not stored
          // team/court NOT stored — changes per week
          addedAt:db.players[key]?.addedAt||db.players[nameKey]?.addedAt||new Date().toISOString()};
        // Also keep name-based key pointing to same entry for backward compat
        if(key!==nameKey) db.players[nameKey]=db.players[key];
        existed?updated++:added++;
      });
      await saveDB(db);return json({success:true,added,updated,total:Object.keys(db.players).length});
    }catch(e){return json({error:e.message},500);}
  }
  if(pathname==='/seasons'&&req.method==='GET')return json(await loadSeasons());
  if(pathname==='/seasons/save'&&req.method==='POST'){
    const{season,week,title,date,scoreUrl,meetUrl,playerWeekPoints,courtResults,isWeek1}=JSON.parse(await body());
    if(!season||!week)return json({error:'season and week required'},400);
    const seasons=await loadSeasons();
    const db=await loadDB();
    if(!seasons.seasons[season])seasons.seasons[season]={name:season,createdAt:new Date().toISOString(),weeks:{}};
    // Store current tiers as THIS week's snapshot
    // This snapshot will be used as "previous week tiers" when loading the NEXT week
    const tierSnapshot={};
    Object.values(db.players).forEach(p=>{
      if(p.name&&p.tier){
        tierSnapshot[normalizeName(p.name).toLowerCase().trim()]=p.tier;
        if(p.handle) tierSnapshot[p.handle.replace('@','').toLowerCase().trim()]=p.tier;
      }
    });
    seasons.seasons[season].weeks[week]={week:parseInt(week),title,date,scoreUrl,meetUrl,isWeek1,
      savedAt:new Date().toISOString(),playerWeekPoints,courtResults,
      tierSnapshot}; // tiers after this week's auto-assign = next week's starting tiers
    await saveSeasons(seasons);return json({success:true,season,week});
  }
  if(pathname==='/seasons/week/points'&&req.method==='POST'){
    const{season,week,player,points}=JSON.parse(await body());
    const seasons=await loadSeasons();const w=seasons.seasons[season]?.weeks[week];
    if(!w)return json({error:'Week not found'},404);
    w.playerWeekPoints[player]=parseFloat(points);
    Object.values(w.courtResults||{}).forEach(cr=>{const r=cr.find(r=>r.player===player);if(r)r.weekPoints=parseFloat(points);});
    w.savedAt=new Date().toISOString();await saveSeasons(seasons);return json({success:true});
  }
  if(pathname==='/seasons/assign-tiers'&&req.method==='POST'){
    const{season,tierSizes}=JSON.parse(await body());
    const seasons=await loadSeasons();const db=await loadDB();const cfg=await loadConfig();
    const sizes=tierSizes||cfg.tierSizes||{S:21,A:21,B:22,C:999};
    if(!seasons.seasons[season])return json({error:'Season not found'},404);
    const assignments=autoAssignTiers(seasons.seasons[season],sizes);
    let updated=0, notFound=[];
    Object.entries(assignments).forEach(([player,info])=>{
      const nameKey = normalizeName(player).toLowerCase().trim();
      // Find existing entry by name key OR by name field (with apostrophe normalization)
      const existingKey = db.players[nameKey]
        ? nameKey
        : Object.keys(db.players).find(k=>{
            const p=db.players[k];
            return p.name && normalizeName(p.name).toLowerCase().trim()===nameKey;
          });
      if(existingKey){
        db.players[existingKey]={...db.players[existingKey], tier:info.tier};
        updated++;
      } else {
        notFound.push(player);
      }
    });
    // Filter out any ||Court keys that slipped through
    const realNotFound = notFound.filter(p=>!p.includes('||'));
    if(realNotFound.length>0) console.log('assign-tiers: not found in DB:',realNotFound.join(', '));
    // Save tier snapshot to the season — keyed by timestamp so history is preserved
    const snapshot = {
      assignedAt: new Date().toISOString(),
      tierSizes: sizes,
      tiers: {} // tier -> [player names ranked]
    };
    const tierGroups = {S:[],A:[],B:[],C:[]};
    Object.entries(assignments).sort((a,b)=>a[1].rank-b[1].rank).forEach(([player,info])=>{
      if(tierGroups[info.tier]) tierGroups[info.tier].push({
        name: player,
        rank: info.rank,
        totalPoints: info.totalPoints,
        totalWins: info.totalWins,
        totalDiff: info.totalDiff
      });
    });
    snapshot.tiers = tierGroups;
    // Store latest snapshot on the season (overwrites previous)
    if(!seasons.seasons[season].tierSnapshots) seasons.seasons[season].tierSnapshots = [];
    // Keep last 10 snapshots
    seasons.seasons[season].tierSnapshots.push(snapshot);
    if(seasons.seasons[season].tierSnapshots.length > 10)
      seasons.seasons[season].tierSnapshots.shift();
    await saveSeasons(seasons);
    await saveDB(db);cfg.tierSizes=sizes;await saveConfig(cfg);
    return json({success:true,assignments,totalPlayers:updated,notFound,snapshot});
  }
  if(pathname==='/seasons/week'&&req.method==='DELETE'){
    const{season,week}=JSON.parse(await body());
    const seasons=await loadSeasons();
    if(seasons.seasons[season]?.weeks[week])delete seasons.seasons[season].weeks[week];
    await saveSeasons(seasons);return json({success:true});
  }
  if(pathname==='/aliases'&&req.method==='GET')return json(await loadAliases());
  if(pathname==='/aliases'&&req.method==='POST'){
    const{scoreName,court,dbKey}=JSON.parse(await body());
    const aliases=await loadAliases();aliases[scoreName+'||'+court]=dbKey.toLowerCase().trim();
    await saveAliases(aliases);return json({success:true,aliases});
  }
  if(pathname==='/aliases'&&req.method==='DELETE'){
    const{scoreName,court}=JSON.parse(await body());
    const aliases=await loadAliases();delete aliases[scoreName+'||'+court];
    await saveAliases(aliases);return json({success:true});
  }

  // Expose KNOWN_PLAYERS to frontend
  if(pathname==='/db/known'&&req.method==='GET'){
    return json(KNOWN_PLAYERS);
  }

  // Auto-populate DB from KNOWN_PLAYERS if empty or has no handles
  if(pathname==='/db/auto-populate'&&req.method==='POST'){
    const db = await loadDB();
    const{force}=JSON.parse(await body()||'{}');
    const hasHandles = Object.values(db.players).some(p=>p.handle);
    if(hasHandles&&!force) return json({skipped:true, message:'DB already has players with handles', total:Object.keys(db.players).length});

    // Populate from KNOWN_PLAYERS — deduplicate by handle
    let added = 0;
    const seenHandles = new Set();
    Object.entries(KNOWN_PLAYERS).forEach(([key, p])=>{
      if(!p.handle) return;
      const handleKey = p.handle.replace('@','').toLowerCase().trim();
      if(seenHandles.has(handleKey)) return;
      seenHandles.add(handleKey);
      const displayName = key.split('||')[0].replace(/\s*\(.*\)$/, '').trim();
      if(!db.players[handleKey]){
        db.players[handleKey] = {
          name: displayName,
          tier: 'C',
          handle: p.handle,
          avatarId: p.avatarId,
          addedAt: new Date().toISOString()
        };
        added++;
      }
    });
    await saveDB(db);
    return json({success:true, added, total:Object.keys(db.players).length});
  }

  // Health check — shows DB connection status
  if(pathname==='/health'){
    return json({
      status: 'ok',
      storage: mongo ? 'mongodb' : 'local-json',
      mongoConnected: !!mongo,
      mongoUri: MONGO_URI ? MONGO_URI.replace(/:([^@]+)@/, ':***@') : null,
      time: new Date().toISOString()
    });
  }

  // Restore tiers from a tier snapshot
  if(pathname==='/seasons/restore-tiers'&&req.method==='POST'){
    const{season, snapIndex}=JSON.parse(await body());
    const seasons=await loadSeasons();
    const snap=seasons.seasons[season]?.tierSnapshots?.[snapIndex];
    if(!snap) return json({error:'Snapshot not found'},404);
    const db=await loadDB();
    let updated=0, notFound=[];
    ['S','A','B','C'].forEach(tier=>{
      (snap.tiers[tier]||[]).forEach(p=>{
        const nameKey=normalizeName(p.name).toLowerCase().trim();
        const existingKey=db.players[nameKey]
          ?nameKey
          :Object.keys(db.players).find(k=>{
            const dp=db.players[k];
            return dp.name&&normalizeName(dp.name).toLowerCase().trim()===nameKey;
          });
        if(existingKey){ db.players[existingKey].tier=tier; updated++; }
        else notFound.push(p.name);
      });
    });
    await saveDB(db);
    return json({success:true, updated, notFound, restoredFrom:snap.assignedAt});
  }

  // Export ALL data as JSON dump for migration
  if(pathname==='/export-all'&&req.method==='GET'){
    const db = await loadDB();
    const seasons = await loadSeasons();
    const aliases = await loadAliases();
    const cfg = await loadConfig();
    return json({players:db.players, seasons:seasons.seasons, aliases, config:cfg});
  }

  // Import ALL data from JSON dump (migration from local to cloud)
  if(pathname==='/import-all'&&req.method==='POST'){
    const{players,seasons,aliases,config,overwrite}=JSON.parse(await body());
    // Players
    if(players){
      const db = await loadDB();
      if(overwrite){
        db.players = players;
      } else {
        // Merge — existing entries take priority for tier
        Object.entries(players).forEach(([k,p])=>{
          if(!db.players[k]) db.players[k]=p;
          else {
            // Keep existing tier, update handle/avatarId if missing
            db.players[k].handle = db.players[k].handle||p.handle;
            db.players[k].avatarId = db.players[k].avatarId||p.avatarId;
          }
        });
      }
      await saveDB(db);
    }
    // Seasons
    if(seasons){
      const s = await loadSeasons();
      if(overwrite) s.seasons=seasons;
      else Object.assign(s.seasons, seasons);
      await saveSeasons(s);
    }
    // Aliases
    if(aliases){
      const a = await loadAliases();
      if(overwrite) Object.assign(a,aliases);
      else Object.assign(a,aliases);
      await saveAliases(a);
    }
    // Config
    if(config){
      const cfg = await loadConfig();
      if(overwrite) Object.assign(cfg,config);
      await saveConfig(cfg);
    }
    return json({success:true, message:'Import complete'});
  }

  // Strip team/court/teamColor from ALL existing DB entries
  if(pathname==='/db/strip-location'&&req.method==='POST'){
    const db = await loadDB();
    let cleaned = 0;
    Object.keys(db.players).forEach(k=>{
      const p = db.players[k];
      if(p.team||p.court||p.teamColor){
        delete p.team; delete p.court; delete p.teamColor;
        cleaned++;
      }
    });
    await saveDB(db);
    return json({success:true, cleaned, total:Object.keys(db.players).length});
  }

  // Full DB cleanup — remove bare name-key entries that have a handle-key equivalent
  if(pathname==='/db/clean'&&req.method==='POST'){
    const db = await loadDB();
    const toDelete = [];
    const byHandle = {};

    // Index all entries that have handles
    Object.entries(db.players).forEach(([k,v])=>{
      if(v.handle) byHandle[v.handle.toLowerCase()] = k;
    });

    // Find bare name-key entries (no handle) that duplicate a handle-key entry
    Object.entries(db.players).forEach(([k,v])=>{
      if(v.handle) return; // has handle — keep
      // Check if a handle-key entry exists for same player name
      const nameLower = (v.name||k).toLowerCase().trim();
      const hasHandleVersion = Object.values(db.players).some(p=>
        p.handle && (p.name||'').toLowerCase().trim()===nameLower
      );
      if(hasHandleVersion) toDelete.push(k);
    });

    toDelete.forEach(k=>delete db.players[k]);
    await saveDB(db);
    return json({success:true, removed:toDelete.length, total:Object.keys(db.players).length});
  }

  // Parse pasted roster text and import to DB
  // Only adds NEW players (by handle). Never duplicates, never changes existing tiers.
  if(pathname==='/db/roster'&&req.method==='POST'){
    const{rosterText,defaultTier}=JSON.parse(await body());
    if(!rosterText) return json({error:'rosterText required'},400);
    try{
      const tcm = await getTeamCourtMap();
      const db  = await loadDB();
      const TIER_ORDER={S:4,A:3,B:2,C:1};

      // Stop at Waitlisted section
      const waitIdx = rosterText.search(/Waitlisted/i);
      const text = waitIdx>0 ? rosterText.substring(0,waitIdx) : rosterText;

      // Detect team headers and their positions
      const teamPositions=[]; // [{pos, team}]
      const teamRegex = /\b(red|white|blue|black|yellow|light blue|gray|grey|green)\s+team\b/gi;
      let tm;
      while((tm=teamRegex.exec(text))!==null){
        const t=tm[1].trim().toLowerCase();
        if(TEAM_COLORS[t]!==undefined)
          teamPositions.push({pos:tm.index, team:tm[1].charAt(0).toUpperCase()+tm[1].slice(1).toLowerCase()});
      }

      // Extract all player blocks using a comprehensive regex
      // Handles both newline and single-line formats
      // Pattern: user-avatars/NNN.webp ... NAME ... players/@HANDLE
      const playerRegex = /user-avatars\/(\d+)\.webp[^)]*\)\s*\n?\s*\n?\s*([^\[\]]+?)\]\(https:\/\/reclub\.co\/players\/@([^\)\s]+)/g;
      let pm;
      const parsed=[];
      while((pm=playerRegex.exec(text))!==null){
        const avatarId=pm[1];
        const name=pm[2].replace(/\n/g,'').replace(/!\[\]\([^)]+\)/g,'').trim();
        const handle='@'+pm[3].trim();
        if(!name||name.length<1||name.includes('http')) continue;
        // Find team — nearest header before this position
        let team=null;
        for(let t=teamPositions.length-1;t>=0;t--){
          if(teamPositions[t].pos<pm.index){team=teamPositions[t].team;break;}
        }
        const tl=(team||'').toLowerCase();
        const court=tcm[tl]||null;
        parsed.push({name,handle,avatarId,team,court,teamColor:TEAM_COLORS[tl]||'#888'});
      }
      // Also try markdown table format: | Name | @handle | avatarId |
      // This lets users paste Claude's analysis output directly
      if(parsed.length===0){
        const tableRegex = /\|\s*([^|\n]+?)\s*\|\s*(@[^\s|]+)\s*\|\s*(\d+)\s*\|/g;
        let tr;
        while((tr=tableRegex.exec(text))!==null){
          const name=tr[1].trim();
          const handle=tr[2].trim();
          const avatarId=tr[3].trim();
          if(!name||name==='Name'||name==='---') continue;
          // Find team from nearby text
          let team=null;
          for(let t=teamPositions.length-1;t>=0;t--){
            if(teamPositions[t].pos<tr.index){team=teamPositions[t].team;break;}
          }
          const tl=(team||'').toLowerCase();
          parsed.push({name,handle,avatarId,team,court:tcm[tl]||null,teamColor:TEAM_COLORS[tl]||'#888'});
        }
        console.log('Roster parser (table format): found',parsed.length,'players');
      } else {
        console.log('Roster parser: found',parsed.length,'players from text of length',text.length);
      }

      // Import to DB — skip if handle already exists
      let added=0,skipped=0,updated=0;
      const log=[];
      parsed.forEach(p=>{
        const handleKey=p.handle.replace('@','').toLowerCase().trim();
        const nameKey=p.name.toLowerCase().trim();
        // Check if player already exists by handle key
        if(db.players[handleKey]){
          const existing=db.players[handleKey];
          const changed = !existing.avatarId||!existing.team||!existing.handle;
          db.players[handleKey]={
            ...existing,
            name: existing.name||p.name,
            handle: p.handle,
            avatarId: p.avatarId||existing.avatarId,
            // team/court NOT stored in DB — per-week only
          };
          // Also clean up any stale name-key pointing to same player
          const staleKey = Object.keys(db.players).find(k=>
            k!==handleKey && k.toLowerCase()===nameKey &&
            (db.players[k].handle===p.handle || !db.players[k].handle)
          );
          if(staleKey) delete db.players[staleKey];
          changed?updated++:skipped++;
          log.push({status:changed?'updated':'skipped', name:p.name, handle:p.handle});
          return;
        }
        // Check by name key fallback (case-insensitive)
        const existingNameKey = Object.keys(db.players).find(k=>
          k.toLowerCase()===nameKey && !db.players[k].handle
        );
        if(existingNameKey){
          // Existing name-only entry — enrich with handle and migrate to handle key
          db.players[handleKey]={
            ...db.players[existingNameKey],
            name: p.name,
            handle: p.handle,
            avatarId: p.avatarId,
            // team/court NOT stored — changes every week
          };
          // Remove ALL old name-based keys for this player
          delete db.players[existingNameKey];
          if(existingNameKey !== nameKey) delete db.players[nameKey];
          updated++;
          log.push({status:'migrated', name:p.name, handle:p.handle});
          return;
        }
        // Brand new player
        db.players[handleKey]={
          name:p.name,
          tier:defaultTier||'C',
          handle:p.handle,
          avatarId:p.avatarId,
          // team/court NOT stored — changes per week


          addedAt:new Date().toISOString()
        };
        added++;
        log.push({status:'added', name:p.name, handle:p.handle});
      });

      await saveDB(db);
      return json({success:true, parsed:parsed.length, added, updated, skipped, log,
        total:Object.keys(db.players).length});
    }catch(e){console.error(e);return json({error:e.message},500);}
  }

  // Apply known players lookup directly to DB
  if(pathname==='/db/apply-known'&&req.method==='POST'){
    const db = await loadDB();
    const TIER_ORDER={S:4,A:3,B:2,C:1};
    let updated=0, skipped=0;
    // First pass: update existing entries only
    Object.entries(db.players).forEach(([key, p])=>{
      if(!p.name) return;
      const known = lookupKnownPlayer(p.name, p.court||'');
      if(known){
        if(p.handle && p.avatarId){ skipped++; return; }
        db.players[key].handle   = known.handle;
        db.players[key].avatarId = known.avatarId;
        // team/court NOT stored — changes per week
        updated++;
      }
    });
    // Second pass: dedupe immediately after applying
    const byName={};
    Object.entries(db.players).forEach(([k,v])=>{
      if(!v.name) return;
      const n=v.name.toLowerCase().trim();
      if(!byName[n]) byName[n]=[];
      byName[n].push({key:k,player:v});
    });
    const toDelete=[];
    Object.values(byName).forEach(entries=>{
      if(entries.length<=1) return;
      entries.sort((a,b)=>{
        const sa=(TIER_ORDER[a.player.tier]||0)*10+(a.player.handle?2:0)+(a.player.avatarId?1:0);
        const sb=(TIER_ORDER[b.player.tier]||0)*10+(b.player.handle?2:0)+(b.player.avatarId?1:0);
        return sb-sa;
      });
      const best=entries[0];
      entries.slice(1).forEach(e=>{
        if(!best.player.handle&&e.player.handle) best.player.handle=e.player.handle;
        if(!best.player.avatarId&&e.player.avatarId) best.player.avatarId=e.player.avatarId;
        if((TIER_ORDER[e.player.tier]||0)>(TIER_ORDER[best.player.tier]||0)) best.player.tier=e.player.tier;
        toDelete.push(e.key);
      });
      db.players[best.key]=best.player;
    });
    toDelete.forEach(k=>delete db.players[k]);
    await saveDB(db);
    return json({success:true, updated, skipped, deduped:toDelete.length, total:Object.keys(db.players).length});
  }

  // Debug: test parseMeetPage and return raw results
  if(pathname==='/db/debug-meet'&&req.method==='POST'){
    const{meetUrl}=JSON.parse(await body());
    if(!meetUrl) return json({error:'meetUrl required'},400);
    try{
      const tcm=await getTeamCourtMap();
      const html=await fetchURL(meetUrl);
      // Sample the HTML to see structure
      const lines=html.split('\n');
      const avatarLines=lines.map((l,i)=>({i:i+1,l})).filter(x=>x.l.includes('user-avatars'));
      const handleLines=lines.map((l,i)=>({i:i+1,l})).filter(x=>x.l.includes('players/@'));
      const teamLines=lines.map((l,i)=>({i:i+1,l})).filter(x=>/team/i.test(x.l)&&x.l.length<200);
      const result=parseMeetPage(html,tcm);
      // Since HTML is 1 line, search in the full string
      // Try Reclub API endpoints directly
      const meetId = meetUrl.split('/m/')[1]?.split('?')[0]?.trim();
      const apiUrls = [
        'https://api.reclub.co/meets/'+meetId,
        'https://api.reclub.co/meets/'+meetId+'/registrations',
        'https://api.reclub.co/meets/'+meetId+'/participants',
        'https://api.reclub.co/export/meet?m='+meetId,
      ];
      const apiResults = {};
      for(const apiUrl of apiUrls){
        try{
          const r = await fetchURL(apiUrl);
          apiResults[apiUrl] = r.substring(0,500);
        }catch(e){ apiResults[apiUrl] = 'ERROR: '+e.message; }
      }
      const nextData = extractNextData(html);
      return json({
        htmlLength: html.length,
        hasNextData: !!nextData,
        meetId,
        apiResults,
        playersFound: Object.keys(result.players).length,
        htmlChunk1: html.substring(0,300),
        htmlChunk2: html.substring(html.length-300),
      });
    }catch(e){return json({error:e.message,stack:e.stack});}
  }

  if(pathname==='/fetch'){
    const scoreUrl=query.scoreUrl||query.url;
    const meetUrl=query.meetUrl;
    const isWeek1=query.isWeek1==='true';
    if(!scoreUrl||!scoreUrl.includes('reclub.co'))return json({error:'Score sheet URL required'},400);
    try{
      const scoreHtml=await fetchURL(scoreUrl);
      const{title,date,matches}=parseScoresheet(scoreHtml);
      let meetData={players:{},playersByHandle:{},playersByCourtName:{}};
      const tcm=await getTeamCourtMap();
      if(meetUrl&&meetUrl.includes('reclub.co')){const mh=await fetchURL(meetUrl);meetData=parseMeetPage(mh,tcm);}
      const{players:meetPlayers,playersByCourtName}=meetData;
      const db=await loadDB();
      // Debug: check DB state
      const _total=Object.keys(db.players).length;
      const _tiered=Object.values(db.players).filter(p=>p.tier&&p.tier!=='C').length;
      console.log('📊 /fetch DB: '+_total+' players, '+_tiered+' with S/A/B tier');
      if(_tiered===0&&!isWeek1) console.warn('⚠️  All players Tier C — auto-assign may not have run');
      const aliases=await loadAliases();
      const playerNames=new Set();
      matches.forEach(m=>{playerNames.add(m.t1a);playerNames.add(m.t1b);playerNames.add(m.t2a);playerNames.add(m.t2b);});
      const playerCourt={};
      matches.forEach(m=>{[m.t1a,m.t1b,m.t2a,m.t2b].forEach(p=>{
        if(!playerCourt[p])playerCourt[p]=m.court;
        else if(playerCourt[p]!==m.court)playerCourt[p]='multiple';
      });});
      const playerProfiles={};
      playerNames.forEach(name=>{
        const court=playerCourt[name]||'';
        let md=null;
        const aliasKey=name+'||'+court;
        if(aliases[aliasKey]){md=Object.values(meetPlayers).find(p=>p.name.toLowerCase()===aliases[aliasKey])||meetPlayers[name];}
        else if(court&&playersByCourtName[name+'||'+court]){md=playersByCourtName[name+'||'+court];console.log(`  ✓ "${name}" on ${court} → ${md.handle}`);}
        else if(meetPlayers[name]){md=meetPlayers[name];}
        else{md=fuzzyMatch(name,meetPlayers);}
        // Fallback to known player lookup if meet page parsing failed
        if(!md||!md.handle){
          const known=lookupKnownPlayer(name,court);
          if(known){
            md={...known, name};
            console.log(`  📚 Known player: "${name}" → ${known.handle}`);
          }
        }
        const dbKey=resolvePlayer(name,court,aliases,playersByCourtName);
        // Look up by handle key first, then name key
        const handleKey = md?.handle ? md.handle.replace('@','').toLowerCase().trim() : null;
        // Find DB entry: try handle key, then name key, then search by name field
        let dbP = (handleKey&&db.players[handleKey])
          || db.players[dbKey]
          || db.players[name.toLowerCase().trim()];
        // If not found by key, search by name field across all entries
        if(!dbP){
          const nameLower = name.toLowerCase().trim();
          const foundKey = Object.keys(db.players).find(k=>{
            const p = db.players[k];
            return p.name && p.name.toLowerCase().trim()===nameLower;
          });
          if(foundKey) dbP = db.players[foundKey];
        }
        const finalAvatarId = dbP?.avatarId||md?.avatarId||null;
        const finalHandle    = dbP?.handle   ||md?.handle   ||null;
        playerProfiles[name]={
          name,
          tier:       dbP?.tier       || null,
          handle:     finalHandle,
          avatarId:   finalAvatarId,
          // Always derive photoUrl from avatarId — never use stale stored URL
          photoUrl:   finalAvatarId ? avatarUrl(finalAvatarId) : null,
          team:       dbP?.team       ||md?.team       ||null,
          teamColor:  dbP?.teamColor  ||md?.teamColor  ||null,
          court:      dbP?.court      ||md?.court      ||court||null,
          tierScore:  TIER_SCORE[dbP?.tier]||null,
          inDB:       !!dbP
        };
        // Use meet page data to enrich the player profile for display ONLY
        // Do NOT write to DB — DB is managed via Roster Import only
        if(md){
          // Update the in-memory profile with meet page data
          playerProfiles[name].handle   = md.handle   || playerProfiles[name].handle;
          playerProfiles[name].avatarId = md.avatarId || playerProfiles[name].avatarId;
          playerProfiles[name].photoUrl = md.avatarId ? avatarUrl(md.avatarId) : playerProfiles[name].photoUrl;
          playerProfiles[name].team      = md.team     || playerProfiles[name].team;
          playerProfiles[name].teamColor = md.teamColor|| playerProfiles[name].teamColor;
          playerProfiles[name].court     = md.court    || playerProfiles[name].court;
          if(!playerProfiles[name].tier){
            // Try to get tier from DB using handle key
            const hk = md.handle?md.handle.replace('@','').toLowerCase().trim():dbKey;
            const dbEntry = db.players[hk]||db.players[dbKey];
            playerProfiles[name].tier      = dbEntry?.tier||'C';
            playerProfiles[name].tierScore = TIER_SCORE[playerProfiles[name].tier]||250;
          }
        } else if(!db.players[dbKey]){
          // Not in DB — use C tier for scoring but DO NOT save to DB
          // Players are added via Roster Import only
          playerProfiles[name].tier='C'; playerProfiles[name].tierScore=250; playerProfiles[name].inDB=false;
        }
      });
      // DO NOT saveDB here — /fetch is read-only for DB
      // Players are managed via Roster Import (/db/roster)
      // ALWAYS use current DB tiers for display — shows correct court scores immediately
      // (The tier snapshot is only used when saving to maintain historical accuracy)
      let currentTierSnapshot = null;
      if(!isWeek1){
        currentTierSnapshot = {};
        Object.values(db.players).forEach(p=>{
          if(p.tier){
            if(p.name) currentTierSnapshot[normalizeName(p.name).toLowerCase().trim()] = p.tier;
            if(p.handle) currentTierSnapshot[p.handle.replace('@','').toLowerCase().trim()] = p.tier;
          }
        });
        const tiered = Object.values(currentTierSnapshot).filter(t=>t!=='C').length;
        console.log('Using current DB tiers: '+Object.keys(currentTierSnapshot).length+
          ' players, '+tiered+' with S/A/B tier');
      }
      const{courtResults,playerWeekPoints}=calcStandings(matches,db,isWeek1,currentTierSnapshot);
      playerNames.forEach(name=>{playerProfiles[name].weekPoints=playerWeekPoints[name]||null;});
      const noTierPlayers=[...playerNames].filter(name=>{
        const p=findPlayerInDB(name,db);
        return !TIER_SCORE[p?.tier];
      });
      // Build court-aware profiles using aliases for disambiguation
      const aliases2 = await loadAliases();
      const courtProfiles = {};
      Object.entries(playerCourt).forEach(([name, court])=>{
        if(!court || court==='multiple') return;
        const aliasKey = name+'||'+court;
        if(aliases2[aliasKey]){
          // Alias set — find the specific DB player
          const aliasedKey = aliases2[aliasKey];
          const dbEntry = db.players[aliasedKey] || Object.values(db.players).find(p=>p.handle&&p.handle.replace('@','').toLowerCase()===aliasedKey);
          if(dbEntry){
            courtProfiles[aliasKey] = {
              ...playerProfiles[name],
              handle: dbEntry.handle,
              avatarId: dbEntry.avatarId,
              photoUrl: dbEntry.avatarId ? avatarUrl(dbEntry.avatarId) : null,
              tier: dbEntry.tier
            };
            return;
          }
        }
        courtProfiles[aliasKey] = playerProfiles[name];
      });
      return json({title,date,matches,playerProfiles,courtProfiles,courtResults,playerWeekPoints,isWeek1,
        noTierPlayers:isWeek1?[]:noTierPlayers,
        matchedCount:Object.values(playerProfiles).filter(p=>p.photoUrl).length});
    }catch(e){console.error(e.message);return json({error:e.message},500);}
  }

  res.writeHead(404);res.end('Not found');
});

connectMongo().then(()=>{
  server.listen(PORT,()=>{
    console.log(`\n  ⚡ Bangi Picklers Tier Ranking`);
    console.log(`  Mode: ${mongo?'MongoDB':'Local JSON'}`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}).catch(err=>{
  console.error('MongoDB failed:', err.message, '— using local files');
  server.listen(PORT,()=>console.log(`\n  ⚡ Running on http://localhost:${PORT}\n`));
});
