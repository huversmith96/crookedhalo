import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const gameFile = path.join(root, 'crooked-halo.html');
const port = Number(process.env.PORT) || 4173;
const scrypt = promisify(scryptCallback);
// Persistent account storage is optional. Keep the public preview runnable
// without a database; the UI falls back to this browser's local save.
const pool = null;
let schemaReady;
async function dbReady() {
  if (!pool) throw new Error('Persistent account storage is not configured yet.');
  if (!schemaReady) schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS game_users (id BIGSERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, save JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS game_sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES game_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS game_sessions_expiry_idx ON game_sessions(expires_at);`);
  await schemaReady;
}
const cookieName = 'crooked_halo_session';
const tokenHash = value => createHash('sha256').update(value).digest('hex');
function cookieValue(req) { const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '=')); return part?.slice(cookieName.length + 1) || ''; }
function setCookie(res, value, age) { res.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); }
async function bodyJson(req) { let raw=''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error('Request is too large.'); } return JSON.parse(raw || '{}'); }
async function currentUser(req) { await dbReady(); const token = cookieValue(req); if (!token) return null; const result = await pool.query('SELECT u.id,u.handle,u.save FROM game_sessions s JOIN game_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [tokenHash(token)]); return result.rows[0] || null; }
async function makeSession(res, userId) { const token=randomBytes(32).toString('base64url'); await pool.query('INSERT INTO game_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')', [tokenHash(token),userId]); setCookie(res,token,30*24*60*60); }
function validSave(save) { if (!save || typeof save !== 'object' || Array.isArray(save) || JSON.stringify(save).length > 1_500_000) return false; return Array.isArray(save.chars) && save.chars.length <= 20; }

// Live-world prototype state is shared across connected browsers. It is held
// in memory for the current server process; durable world state needs a DB.
const livePlayers = new Map();
const liveChat = [];
const liveChronicle = [];
const liveClients = new Map();
const validFactions = new Set(['Radiant', 'Veil', 'Verdant']);
function cleanText(value, max = 240) { return String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
function liveSnapshot() {
  const cutoff = Date.now() - 45_000;
  for (const [id, player] of livePlayers) if (player.lastSeen < cutoff) livePlayers.delete(id);
  return { players: [...livePlayers.values()].map(({ lastSeen, ...player }) => player), chat: liveChat.slice(-80), chronicle: liveChronicle.slice(-30), at: Date.now() };
}
function sendLive(res, data) { if (!res.destroyed) res.write(`event: world\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcastWorld() { const data = liveSnapshot(); for (const [res] of liveClients) sendLive(res, data); }
async function liveWorldRoute(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/world/stream') {
    const id = cleanText(url.searchParams.get('id'), 80);
    const name = cleanText(url.searchParams.get('name'), 24) || 'Wayfarer';
    const character = cleanText(url.searchParams.get('character'), 24) || name;
    const faction = validFactions.has(url.searchParams.get('faction')) ? url.searchParams.get('faction') : 'Radiant';
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(id)) return json(res, 400, { error: 'Invalid world-session id.' });
    const player = { id, name, character, faction, lastSeen: Date.now() };
    livePlayers.set(id, player);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n');
    liveClients.set(res, { id });
    sendLive(res, liveSnapshot());
    broadcastWorld();
    const heartbeat = setInterval(() => { if (res.destroyed) return clearInterval(heartbeat); player.lastSeen = Date.now(); res.write(': keep-alive\n\n'); }, 15_000);
    res.on('close', () => { clearInterval(heartbeat); liveClients.delete(res); player.lastSeen = Date.now(); broadcastWorld(); });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/world/snapshot') return json(res, 200, liveSnapshot());
  if (req.method === 'POST' && (url.pathname === '/api/world/chat' || url.pathname === '/api/world/activity')) {
    const id = cleanText(req.headers['x-player-id'], 80), player = livePlayers.get(id);
    if (!player) return json(res, 401, { error: 'Join the live world first.' });
    player.lastSeen = Date.now();
    let data; try { data = await bodyJson(req); } catch { return json(res, 400, { error: 'Invalid message.' }); }
    if (url.pathname.endsWith('/chat')) {
      const text = cleanText(data.text, 240); if (!text) return json(res, 400, { error: 'Write a message first.' });
      const channel = data.channel === 'faction' ? 'faction' : 'world';
      const message = { id: randomBytes(8).toString('hex'), sender: player.character, faction: player.faction, channel, text, time: Date.now() };
      liveChat.push(message); if (liveChat.length > 500) liveChat.splice(0, liveChat.length - 500);
    } else {
      const text = cleanText(data.text, 180); if (!text) return json(res, 400, { error: 'Activity text is empty.' });
      liveChronicle.unshift({ id: randomBytes(8).toString('hex'), sender: player.character, faction: player.faction, text, time: Date.now() });
      if (liveChronicle.length > 150) liveChronicle.length = 150;
    }
    broadcastWorld(); return json(res, 202, { ok: true });
  }
  return false;
}

async function authRoute(req, res, url) {
  try {
    await dbReady();
    if (req.method === 'GET' && url.pathname === '/api/account') { const user=await currentUser(req); return json(res,200,user?{authenticated:true,handle:user.handle,save:user.save}:{authenticated:false}); }
    if (req.method === 'POST' && url.pathname === '/api/account/register') {
      const data=await bodyJson(req),handle=String(data.handle||'').trim(),email=String(data.email||'').trim().toLowerCase(),password=String(data.password||'');
      if (!/^[A-Za-z0-9_-]{3,20}$/.test(handle)) return json(res,400,{error:'Handle must be 3–20 letters, numbers, underscores, or hyphens.'});
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return json(res,400,{error:'Enter a valid email address.'});
      if (password.length<10||password.length>200) return json(res,400,{error:'Password must be at least 10 characters.'});
      if (!validSave(data.save)) return json(res,400,{error:'The game save could not be read.'});
      const salt=randomBytes(16).toString('hex'),derived=await scrypt(password,salt,64),hash=`${salt}:${Buffer.from(derived).toString('hex')}`;
      try { const result=await pool.query('INSERT INTO game_users(handle,email,password_hash,save) VALUES($1,$2,$3,$4) RETURNING id,handle,save',[handle,email,hash,JSON.stringify(data.save)]); await makeSession(res,result.rows[0].id); return json(res,201,{authenticated:true,handle:result.rows[0].handle,save:result.rows[0].save}); }
      catch(e) { if(e.code==='23505') return json(res,409,{error:'That handle or email is already registered. Try signing in.'}); throw e; }
    }
    if (req.method === 'POST' && url.pathname === '/api/account/login') {
      const data=await bodyJson(req),identity=String(data.identity||'').trim();
      const result=await pool.query('SELECT id,handle,email,password_hash,save FROM game_users WHERE LOWER(email)=LOWER($1) OR LOWER(handle)=LOWER($1) LIMIT 1',[identity]);
      const row=result.rows[0], [salt,stored]=row?.password_hash.split(':')||['','']; const actual=row?Buffer.from(await scrypt(String(data.password||''),salt,64)):Buffer.alloc(64); const expected=Buffer.from(stored,'hex');
      if(!row||actual.length!==expected.length||!timingSafeEqual(actual,expected)) return json(res,401,{error:'Account or password not recognized.'});
      await makeSession(res,row.id); return json(res,200,{authenticated:true,handle:row.handle,save:row.save});
    }
    if (req.method === 'POST' && url.pathname === '/api/account/save') {
      const user=await currentUser(req); if(!user) return json(res,401,{error:'Sign in again to save your progress.'}); const data=await bodyJson(req); if(!validSave(data.save)) return json(res,400,{error:'The game save is too large or invalid.'});
      await pool.query('UPDATE game_users SET save=$1 WHERE id=$2',[JSON.stringify(data.save),user.id]); return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/account/logout') { const token=cookieValue(req); if(token) await pool.query('DELETE FROM game_sessions WHERE token_hash=$1',[tokenHash(token)]); setCookie(res,'',0); return json(res,200,{ok:true}); }
    return false;
  } catch (error) { console.error('Account service error:',error.message); json(res,503,{error:'Account storage is not available right now. Your browser save is still here; please try again shortly.'}); return true; }
}

const server = http.createServer(async (req, res) => {
  const requestPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (requestPath.startsWith('/api/world/')) { if (await liveWorldRoute(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`)) !== false) return; }
  if (requestPath.startsWith('/api/account')) { if (await authRoute(req,res,new URL(req.url,`http://${req.headers.host||'localhost'}`)) !== false) return; }
  if (req.url === '/health') {
    json(res,200,{ok:true,game:'Crooked Halo',accountsConfigured:Boolean(pool),realTimeWorld:true,onlinePlayers:liveSnapshot().players.length});
    return;
  }
  if (['/assets/portrait-wayfarer.svg', '/assets/portrait-bellkeeper.svg', '/assets/crooked-country.svg'].includes(requestPath)) {
    try {
      const asset = path.join(root, requestPath.slice(1));
      const body = await readFile(asset);
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Illustration not found.');
    }
    return;
  }
  if (requestPath === '/' || requestPath === '/crooked-halo.html') {
    try {
      const html = await readFile(gameFile);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Crooked Halo could not read its game page.');
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Crooked Halo is running at http://localhost:${port}`);
});
