/* LURE multiplayer game server — two deps now (@solana/web3.js, tweetnacl),
   only for THE ABYSS's chain wiring; everything else is still plain Node.
   Authoritative world: rooms of up to 40 real players (bots fill the gaps so
   the map is always alive), server-side physics, kills, corpse drops, GLOBAL
   daily + all-time rankings persisted to disk and shared by every device.
   Protocol: simple HTTP polling (works everywhere, no websockets needed):
     POST /join       {name, matchId?, player?} -> {id,room,you,snakes,foods,day,all}
     POST /input      {id,angle,boost}          -> snapshot {you,snakes,foodAdd,foodDel,events,day,all,pool,burn}
     POST /leave      {id}                      -> {score,val}
     GET  /rankings                             -> {day,all,pool,burn}   (for the menu)
     POST /match/new  {player, tier}            -> {matchId}   (THE ABYSS: unpredictable id, bound to a wallet+tier)
     POST /attest/claim {matchId}               -> {message,signature,attesterPublicKey}  (THE ABYSS: escape payout)
*/
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const PORT = process.env.PORT || 8790;
/* PHASE mirrors index.html's own `const PHASE=` literal. Flip BOTH together
   when going live: this one via the Render env var, the client's by editing
   the source. Until then ABYSS_ON stays false and /match/new + /attest/claim
   simply refuse to run (see below), so nothing here can touch real money by
   accident. */
const PHASE = process.env.PHASE || 'free';
const ABYSS_ON = PHASE === 'abyss';

/* ---- THE ABYSS: chain wiring (only active once ABYSS_ON) --------------- */
let web3 = null, nacl = null;
try { web3 = require('@solana/web3.js'); } catch (e) { /* reported at boot, below */ }
try { nacl = require('tweetnacl'); } catch (e) { /* reported at boot, below */ }

/* Program id and IDL seeds are copied from ABYSS_IDL in index.html — keep
   them in sync if the program is ever redeployed with a new address. */
const ABYSS_PROGRAM_ID = process.env.ABYSS_PROGRAM_ID || 'A8tG9q3L28MXudiPeswU2uR1QB33RFrJqruz8AtNtCr6';
const ABYSS_RPC_URL = process.env.ABYSS_RPC_URL || 'https://api.devnet.solana.com';
/* ASSUMPTION — verify against attest.rs: 0 = devnet, 1 = mainnet-beta. If the
   program checks this byte differently, set ABYSS_NETWORK_TAG in the env to
   match, or tell me the real encoding and I'll fix it here. */
const ABYSS_NETWORK_TAG = parseInt(process.env.ABYSS_NETWORK_TAG || '0', 10);
const ABYSS_MATCH_TTL_MS = parseInt(process.env.ABYSS_MATCH_TTL_MS || String(15 * 60 * 1000), 10); /* time to deposit after /match/new */
const ABYSS_CLAIM_TTL_MS = parseInt(process.env.ABYSS_CLAIM_TTL_MS || String(10 * 60 * 1000), 10); /* time to claim after escaping alive */
const ABYSS_ATTEST_EXPIRY_S = parseInt(process.env.ABYSS_ATTEST_EXPIRY_S || '180', 10); /* how long the signed message is valid on-chain */

const abyssProgramId = web3 ? new web3.PublicKey(ABYSS_PROGRAM_ID) : null;
const abyssConnection = web3 ? new web3.Connection(ABYSS_RPC_URL, 'confirmed') : null;
function abyssPda(seedLabel, extra) {
  const seeds = [Buffer.from(seedLabel)];
  if (extra) seeds.push(Buffer.from(extra));
  return web3.PublicKey.findProgramAddressSync(seeds, abyssProgramId)[0];
}
const abyssMatchPda = matchId => abyssPda('match', matchId);

/* Raw Borsh/Anchor layout of MatchAccount, mirrored from ABYSS_IDL.types in
   index.html. No anchor client on the server: this is the whole account,
   read by hand, so there is exactly one place (that IDL block) to keep in
   sync if the program's struct ever changes. */
const MATCH_DISCRIMINATOR = Buffer.from([235, 36, 243, 39, 81, 16, 144, 87]);
const MATCH_STATE = { IDLE: 0, AT_RISK: 1, RESOLVED: 2 };
function decodeMatchAccount(data) {
  if (data.length < 107 || !data.slice(0, 8).equals(MATCH_DISCRIMINATOR)) return null;
  return {
    matchId: data.slice(8, 40),
    player: new web3.PublicKey(data.slice(40, 72)),
    atRisk: data.readBigUInt64LE(72),
    seq: data.readBigUInt64LE(80),
    state: data.readUInt8(88),
    outcome: data.readUInt8(89),
  };
}
async function fetchMatchAccount(matchIdBytes) {
  if (!web3 || !abyssConnection) throw new Error('solana web3 unavailable on server');
  const info = await abyssConnection.getAccountInfo(abyssMatchPda(Buffer.from(matchIdBytes)));
  if (!info) return null;
  return decodeMatchAccount(info.data);
}

/* Mirrors ATTEST_DOMAIN / parseAttestationMessage in index.html's wallet.js.
   Any change here MUST be mirrored there and in the on-chain attest.rs. */
const ATTEST_DOMAIN = Buffer.from('LURE_ABYSS_V1', 'ascii'); /* 13 bytes */
const OUTCOME_ESCAPE_ALIVE = 1;
function buildAttestationMessage(f) {
  const buf = Buffer.alloc(175);
  let o = 0;
  ATTEST_DOMAIN.copy(buf, o); o += 13;
  buf.writeUInt8(f.networkTag, o); o += 1;
  Buffer.from(f.programId.toBytes()).copy(buf, o); o += 32;
  buf.writeUInt8(f.outcome, o); o += 1;
  Buffer.from(f.matchId).copy(buf, o); o += 32;
  buf.writeBigUInt64LE(BigInt(f.matchSeq), o); o += 8;
  buf.writeBigUInt64LE(BigInt(f.atRisk), o); o += 8;
  Buffer.from(f.player.toBytes()).copy(buf, o); o += 32;
  Buffer.from(f.counterpartyMatchId).copy(buf, o); o += 32;
  buf.writeBigUInt64LE(BigInt(f.counterpartySeq), o); o += 8;
  buf.writeBigInt64LE(BigInt(f.expiryUnix), o); o += 8;
  return buf;
}

/* Solana keypairs are conventionally 64 bytes: 32-byte seed + 32-byte public
   key (the exact format `solana-keygen new` writes to a .json file, and the
   exact format tweetnacl's sign.detached expects). Paste that file's array
   AS-IS into ATTESTER_SECRET_KEY and this reads it with no conversion step.
   NEVER put this key in index.html or anywhere the browser can reach it. */
function loadAttesterKeypair() {
  const raw = (process.env.ATTESTER_SECRET_KEY || '').trim();
  if (!raw) return null;
  let bytes;
  try {
    bytes = Uint8Array.from(raw[0] === '[' ? JSON.parse(raw) : Buffer.from(raw, 'base64'));
  } catch (e) { console.error('[abyss] ATTESTER_SECRET_KEY unreadable:', e.message); return null; }
  if (bytes.length !== 64) { console.error('[abyss] ATTESTER_SECRET_KEY must be 64 bytes, got ' + bytes.length); return null; }
  return { secretKey: bytes, publicKey: bytes.slice(32, 64) };
}
const attesterKeypair = (web3 && nacl) ? loadAttesterKeypair() : null;

if (ABYSS_ON) {
  if (!web3) console.error('[abyss] PHASE=abyss pero @solana/web3.js no esta instalado: npm install en gameserver/.');
  if (!nacl) console.error('[abyss] PHASE=abyss pero tweetnacl no esta instalado: npm install en gameserver/.');
  if (!attesterKeypair) console.error('[abyss] PHASE=abyss pero ATTESTER_SECRET_KEY falta o es invalida: /attest/claim fallara.');
  else console.log('[abyss] attester pubkey: ' + new web3.PublicKey(attesterKeypair.publicKey).toBase58() + ' — confirma que coincide con config.attester on-chain.');
}

/* matchId (hex) -> pending deposit not yet confirmed on-chain */
const pendingMatches = new Map();
/* matchId (hex) -> confirmed escape-alive, ready for ONE /attest/claim */
const escapedMatches = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingMatches) if (now - v.createdAt > ABYSS_MATCH_TTL_MS) pendingMatches.delete(k);
  for (const [k, v] of escapedMatches) if (now - v.createdAt > ABYSS_CLAIM_TTL_MS) escapedMatches.delete(k);
}, 60000);

/* ---- constants (mirror the client) ---- */
const WORLD_R=2500, START_LENGTH=60, FOOD_TARGET=260, MAX_FOOD=300;
const ROOM_CAPACITY=40, BOT_FILL=12, TICK=1/20;
const DROP_FRACTION=0.35;
const BOT_NAMES=['ANGLER','KRAKEN','NAUTILUS','MANTA','VIPER','GLOWWORM','LEVIATHAN','DRIFTER','SIREN','ABYSSAL','LANTERN','EEL'];
const COLORS=['#45e8d4','#ff7ac8','#ffd166','#9d8cff','#7ce38b','#ff9d66'];
/* bots wear muted deep-water tones: readable at a glance as FOOD, not prize */
function colorFor(name){
  let h=0; const n=String(name||'');
  for(let i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))>>>0;
  return COLORS[h%COLORS.length];
}
const BOT_COLORS=['#2e4a52','#33565e','#3a4e5a','#28414b','#456066','#31434f'];
/* stake is CONFIG, not code: change ENTRY_LURE in the environment and the
   whole economy follows (the USD peg lands here in the on-chain phase:
   the deposit contract reads the live token price and computes ENTRY) */
const ENTRY=Math.max(1,parseInt(process.env.ENTRY_LURE||'100',10));
const AT_RISK=Math.round(ENTRY*0.95); /* 95% rides with you, 5% protocol */
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
const norm=a=>{while(a>Math.PI)a-=6.2832;while(a<-Math.PI)a+=6.2832;return a;};
function diskPoint(r){const t=Math.random()*6.2832,d=Math.sqrt(Math.random())*r;return{x:Math.cos(t)*d,y:Math.sin(t)*d};}
const headR=s=>Math.min(8+s.length*0.013,36);
const turnRate=s=>Math.max(2.2-s.length*0.00022,1.05); /* bots */
const turnRateH=s=>Math.max(3.1,Math.min(5.6,5.6-s.length*0.0035)); /* humans: EXACT match with the client's prediction physics */

/* ---- global rankings (shared by ALL rooms & devices) ---- */
const BOARDS_FILE=process.env.BOARDS_FILE||'./boards.json';
let boards={day:{},all:{},dayId:epochId(),pool:0,burn:0,referrals:{}};
function epochId(){const d=new Date();return d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();}
try{const j=JSON.parse(fs.readFileSync(BOARDS_FILE,'utf8'));if(j&&j.all)boards=j;}catch(e){}
/* boards.json guardado antes de existir los referidos no trae este campo:
   sin esto, el primer registro reventaria contra undefined */
if(!boards.referrals)boards.referrals={};
for(const b of [boards.day,boards.all])for(const n of BOT_NAMES)delete b[n];
function rollDay(){const id=epochId();if(id!==boards.dayId){boards.dayId=id;boards.day={};boards.pool=0;boards.burn=0;saveBoards();}}
let dirty=false;
function saveBoards(){try{fs.writeFileSync(BOARDS_FILE,JSON.stringify(boards));}catch(e){}}
setInterval(()=>{if(dirty){dirty=false;saveBoards();}},15000);
const BOT_SET=new Set(BOT_NAMES);
const BOARD_MAX=500; /* memory bound: keep only the top N names per board */
function trimBoard(b){
  const keys=Object.keys(b);
  if(keys.length<=BOARD_MAX)return b;
  const top=keys.sort((a,c)=>b[c]-b[a]).slice(0,BOARD_MAX);
  const out={};for(const k of top)out[k]=b[k];
  return out;
}
function recordScore(name,score){
  rollDay();score=Math.round(score);
  if(BOT_SET.has(name))return; /* tournament boards are humans-only */
  if(!(score>0))return;
  if(!(boards.day[name]>=score))boards.day[name]=score;
  if(!(boards.all[name]>=score))boards.all[name]=score;
  if(Object.keys(boards.all).length>BOARD_MAX+50)boards.all=trimBoard(boards.all);
  if(Object.keys(boards.day).length>BOARD_MAX+50)boards.day=trimBoard(boards.day);
  dirty=true;
}
function topList(map,n){return Object.entries(map).map(([name,score])=>({name,score}))
  .sort((a,b)=>b.score-a.score).slice(0,n);}

/* ---- rooms ---- */
const rooms=[];
function newRoom(){
  const room={players:new Map(),bots:[],foods:new Map(),nextFood:1,id:rooms.length};
  for(let i=0;i<FOOD_TARGET;i++)spawnFood(room);
  for(let i=0;i<BOT_FILL;i++){spawnBot(room,i);placeAt(room.bots[i],safeSpawn(room));}
  rooms.push(room);return room;
}
function pickRoom(){for(const r of rooms)if(r.players.size<ROOM_CAPACITY)return r;return newRoom();}
function spawnFood(room,x,y,v,c,exceptId){
  let p;
  if(x===undefined){
    /* ANTES: WORLD_R*.85 dejaba el 15% exterior del mapa (un anillo de 375
       unidades) completamente vacio de comida. El borde no era una zona de
       riesgo con recompensa, era espacio muerto donde no habia nada que
       hacer. Ahora llega al 94%: hay comida hasta cerca del muro, pero sin
       pegarla tanto como para que recogerla sea suicidio automatico. */
    p=diskPoint(WORLD_R*.94);
  }
  else {
    /* Comida colocada por COORDENADAS (cadaveres y rastro de boost). Hay que
       meterla dentro del mundo a la fuerza, porque quien la suelta puede estar
       justo en el muro o pasado de largo: una serpiente muere EN el limite y su
       cadaver caeria fuera del area jugable.
       Sin esto pasan dos cosas, y las dos se notan jugando:
         1. se apilan orbes pegados al borde que nadie puede comer nunca
         2. esos orbes cuentan para FOOD_TARGET, asi que el servidor deja de
            generar comida nueva y el centro del mapa se queda vacio
       Se empuja al 97% del radio (no al 100%) para que quede claramente dentro
       y se pueda comer sin rozar el muro. */
    const d=Math.hypot(x,y), lim=WORLD_R*.96;
    if(d>lim && d>0){ const k=lim/d; p={x:x*k,y:y*k}; }
    else p={x,y};
  }
  const big=v===undefined&&Math.random()<.05;
  const f={i:room.nextFood++,x:p.x,y:p.y,v:v!==undefined?v:(big?20:rand(3,7)),c:c||COLORS[(Math.random()*6)|0],big:!!big};
  room.foods.set(f.i,f);
  /* per-player diff queues: every player gets every change, EXCEPT the owner
     of a boost-trail orb (they already rendered it locally, instantly; getting
     it echoed back late made tiny orbs pop up behind them). */
  for(const pl of room.players.values())if(pl.id!==exceptId)pl.addQ.push(f);
  return f;
}
function bodyPolyline(src){
  /* compact real-body polyline (head first), used by /join and /bodies */
  if(!src||!src.body||src.body.length<2)return null;
  const step=Math.max(1,Math.ceil(src.body.length/50)),b=[];
  for(let bi=0;bi<src.body.length;bi+=step)
    b.push([Math.round(src.body[bi].x),Math.round(src.body[bi].y)]);
  return b;
}
function safeSpawn(room){
  /* pick the candidate farthest from every living head: nobody ever spawns
     on top of someone (that caused instant unfair deaths and pass-throughs) */
  let best=null,bd=-1;
  for(let t=0;t<24;t++){
    const p=diskPoint(WORLD_R*.8);let md=1e18;
    for(const s of [...room.players.values(),...room.bots])if(s.alive){
      const dx=s.x-p.x,dy=s.y-p.y,d=dx*dx+dy*dy;if(d<md)md=d;}
    if(md>bd){bd=md;best=p;}
  }
  return best||diskPoint(WORLD_R*.6);
}
function placeAt(s,p){s.x=p.x;s.y=p.y;s.path=[{x:p.x,y:p.y}];s.pathLen=0;s.body=[{x:p.x,y:p.y}];}
function makeSnake(name,color,isBot){
  const p=diskPoint(WORLD_R*.6);
  return{name,color,bot:!!isBot,x:p.x,y:p.y,angle:rand(0,6.28),desired:rand(0,6.28),
    length:START_LENGTH+(isBot?rand(0,120):0),peak:START_LENGTH,val:isBot?0:AT_RISK,valPeak:isBot?0:AT_RISK,boost:false,alive:true, /* bots NEVER carry $LURE: unfarmable */
    path:[{x:p.x,y:p.y}],pathLen:0,body:[{x:p.x,y:p.y}],kills:0,respawnT:0,
    skill:isBot?(Math.random()<.3?rand(.8,1):Math.random()<.6?rand(.45,.75):rand(.2,.4)):1,
    wx:0,wy:0,wT:0};
}
function spawnBot(room,i){const b=makeSnake(BOT_NAMES[i%12],BOT_COLORS[i%6],true);b.id='b'+i;room.bots.push(b);}
let nextId=1;

/* ---- physics tick ---- */
function step(room,dt){
  room.simT=(room.simT||0)+dt; /* sim-time odometer (tests/diagnostics) */
  const nowMs=Date.now();
  const all=[...room.players.values(),...room.bots].filter(s=>s.alive);
  /* bot AI (simplified port of the client AI) */
  for(const b of room.bots){
    if(!b.alive){b.respawnT-=dt;if(b.respawnT<=0){Object.assign(b,makeSnake(b.name,b.color,true),{id:b.id});placeAt(b,safeSpawn(room));}continue;}
    b.wT-=dt;
    const wd=(b.wx-b.x)**2+(b.wy-b.y)**2;
    if(b.wT<=0||wd<120*120){b.wT=rand(3,6);const p=diskPoint(WORLD_R*(Math.random()<.2?.95:.8));b.wx=p.x;b.wy=p.y;}
    let target=Math.atan2(b.wy-b.y,b.wx-b.x);
    let bestScore=1e18,nf=null;const fr=(220+b.skill*260)**2;
    for(const f of room.foods.values()){
      const dx=f.x-b.x,dy=f.y-b.y,d2=dx*dx+dy*dy;if(d2>fr)continue;
      const turn=Math.abs(norm(Math.atan2(dy,dx)-b.angle));
      let sc=Math.sqrt(d2)*(0.5+turn);if(f.big&&b.skill>.6)sc*=.5;
      if(sc<bestScore){bestScore=sc;nf=f;}
    }
    if(nf)target=Math.atan2(nf.y-b.y,nf.x-b.x);
    if(Math.hypot(b.x,b.y)>WORLD_R-280)target=Math.atan2(-b.y,-b.x);
    const dodge=(58+b.skill*46)**2;
    for(const o of all){if(o===b)continue;
      const st=b.skill>.6?6:10;
      for(let i=0;i<o.body.length;i+=st){const p=o.body[i],dx=p.x-b.x,dy=p.y-b.y;
        if(dx*dx+dy*dy<dodge){target=Math.atan2(b.y-p.y,b.x-p.x)+rand(-(1-b.skill)*.9,(1-b.skill)*.9);break;}}}
    b.desired=target;
  }
  /* movement: bots are server-driven; humans are client-driven (their
     position arrives via /input), but their trail, boost drain and boost
     orb drops still happen here so everyone sees them identically */
  for(const s of all){
    if(s.bot){
      const d=norm(s.desired-s.angle),tr=turnRate(s)*dt;
      s.angle+=clamp(d,-tr,tr);
      const sp=((s.boost&&s.length>64)?290:185)*dt;
      s.x+=Math.cos(s.angle)*sp;s.y+=Math.sin(s.angle)*sp;
    }else{
      /* ANTI-PAUSE by REAL DISPLACEMENT (spec §25). A hidden tab keeps
         dribbling ~1 stale input/sec with a FROZEN position, so silence
         detection fails. Instead we track how far the accepted position
         actually moved over the last second: in this game you can never
         stand still, so no travel == frozen client, whatever arrives.
         Frozen => the SERVER drives straight, alive and fully vulnerable,
         and stale client positions are ignored (see /input) until real
         motion resumes. Nobody freezes mid-arena as a statue. */
      /* AFK = the CLIENT stopped feeding real motion. We accumulate path
         length contributed by /input only (s._cliMove, added there); the
         server's own catch-up driving does NOT count, so it can't clear the
         AFK flag by itself. A tight circle still nets ~185u/s of client
         path, so honest play is never flagged; a frozen tab nets 0. */
      if(s._t0===undefined)s._t0=nowMs;
      if(nowMs-s._t0>=1000){
        s._afk=(s._cliMove||0)<60;
        s._cliMove=0;s._t0=nowMs;
      }
      if(s._afk&&s.alive){
        const sp=185*dt;
        s.x+=Math.cos(s.angle)*sp;s.y+=Math.sin(s.angle)*sp;
      }
    }
    const boosting=s.boost&&s.length>64; /* gate == drain floor: one orb after spawning unlocks sprint, slither-style */
    if(boosting){s.length=Math.max(64,s.length-14*dt);
      if(Math.random()<dt*6){
        /* drop at the TAIL TIP, exactly like slither.io: at the tail the
           network delay is invisible and the orb can never be re-eaten by
           your own head in the same instant */
        const tail=(s.body&&s.body.length>1)?s.body[s.body.length-1]:{x:s.x-Math.cos(s.angle)*headR(s)*6,y:s.y-Math.sin(s.angle)*headR(s)*6};
        spawnFood(room,tail.x+rand(-5,5),tail.y+rand(-5,5),3,s.color);
      }}
    const lp=s.path[0],ml=Math.hypot(s.x-lp.x,s.y-lp.y);
    if(ml>4){s.path.unshift({x:s.x,y:s.y});s.pathLen+=ml;
      while(s.pathLen>s.length+220&&s.path.length>2){
        const a=s.path.pop(),b2=s.path[s.path.length-1];
        s.pathLen-=Math.hypot(a.x-b2.x,a.y-b2.y);}}
    /* body points, capped ~120 server-side (collisions only) */
    const stp=Math.max(10,s.length/80);s.body=[];let acc=0,nx=0;
    for(let i=1;i<s.path.length&&acc<s.length;i++){
      const a=s.path[i-1],b2=s.path[i],L=Math.hypot(b2.x-a.x,b2.y-a.y);if(L<1e-4)continue;
      while(nx<=acc+L&&nx<=s.length){const k=(nx-acc)/L;
        s.body.push({x:a.x+(b2.x-a.x)*k,y:a.y+(b2.y-a.y)*k});nx+=stp;}
      acc+=L;}
  }
  /* eating, accelerated by a spatial grid (200u cells): each head only
     tests food in its own cell and the 8 neighbours, not all 300 orbs.
     This is the hot loop that pinned the CPU on the free tier. */
  const CELL=200,grid=new Map();
  for(const f of room.foods.values()){
    const gx=Math.floor(f.x/CELL),gy=Math.floor(f.y/CELL),key=gx+','+gy;
    let cell=grid.get(key);if(!cell){cell=[];grid.set(key,cell);}
    cell.push(f);
  }
  for(const s of all){
    if(!s.alive)continue;
    const hr=headR(s),gx=Math.floor(s.x/CELL),gy=Math.floor(s.y/CELL);
    for(let cx=gx-1;cx<=gx+1;cx++)for(let cy=gy-1;cy<=gy+1;cy++){
      const cell=grid.get(cx+','+cy);if(!cell)continue;
      for(const f of cell){
        if(!room.foods.has(f.i))continue;
        /* Radio de comer. El margen extra compensa el retardo de red: el
           navegador del jugador va ~100-200ms por delante y ya se comio el
           orbe en su pantalla; sin margen, el servidor se lo "devolveria".
           Los BOTS viven aqui dentro, sin retardo ninguno: no les corresponde
           ese regalo. Con el margen antiguo (+20 para todos) un bot aspiraba
           orbes a 2-3 cabezas de distancia y se notaba jugando. */
        const dx=f.x-s.x,dy=f.y-s.y,rr=hr*1.2+f.v*.3+(s.bot?6:46);
        if(dx*dx+dy*dy<rr*rr){
          const sizeM=1/(1+Math.max(0,s.length-START_LENGTH)/2600);
          s.length+=f.v*sizeM;
          room.foods.delete(f.i);for(const pl of room.players.values())pl.delQ.push(f.i);
        }
      }
    }
  }
  /* Barrido de orbes inalcanzables. El clamp de spawnFood impide que se creen
     nuevos fuera del mundo, pero un servidor que lleve tiempo encendido puede
     arrastrar los de antes del arreglo. Sin esto seguirian ocupando cupo de
     FOOD_TARGET para siempre. Se comprueba una vez por segundo, no en cada
     frame: recorrer todos los orbes 20 veces por segundo no aporta nada. */
  room.sweepT=(room.sweepT||0)+dt;
  if(room.sweepT>=1){
    room.sweepT=0;
    const lim=WORLD_R*.99;
    for(const f of room.foods.values()){
      if(Math.hypot(f.x,f.y)>lim){
        room.foods.delete(f.i);
        for(const pl of room.players.values())pl.delQ.push(f.i);
      }
    }
  }
  room.regen=(room.regen||0)+6*dt; /* gradual regeneration: max 8 orbs/s */
  while(room.foods.size<FOOD_TARGET&&room.regen>=1){room.regen-=1;spawnFood(room);}
  if(room.foods.size>=FOOD_TARGET)room.regen=0;
  if(room.foods.size>MAX_FOOD){const it=room.foods.keys();
    while(room.foods.size>MAX_FOOD){const k=it.next().value;room.foods.delete(k);for(const pl of room.players.values())pl.delQ.push(k);}}
  /* collisions: head vs others' bodies + wall */
  for(const s of all){
    if(!s.alive)continue;
    if(!s.bot&&!s._afk){
      /* ACTIVE humans die on their own screen (client-authoritative via
         /died, validated): killing them here with a stale copy produced
         unfair deaths. AFK humans fall through: the server-side absolute
         rule below applies to them exactly like bots: no pause exploit. */
      if(Math.hypot(s.x,s.y)>WORLD_R+60)kill(room,s,null,'the wall');
      continue;
    }
    if(Math.hypot(s.x,s.y)>WORLD_R){kill(room,s,null,'the wall');continue;}
    const hr=headR(s);
    for(const o of all){
      if(o===s||!o.alive)continue;
      const dx0=o.x-s.x,dy0=o.y-s.y;
      if(dx0*dx0+dy0*dy0>(o.length+300)**2)continue;
      const bstep=Math.max(10,o.length/80);
      const rr=hr+headR(o)*.8+bstep*.5;
      /* NECK ZONE, head-proximity gated: forgiving only when the two heads
         are close (a real ram). Crossing a neck with the head far away is a
         normal body hit: without the gate, the neck was a crossable blind
         spot behind every head. */
      /* THE ABSOLUTE RULE for bots too: head touches any body point =>
         dies. No neck forgiveness: forgiveness zones are corridors. */
      for(let bi=1;bi<o.body.length;bi++){const p=o.body[bi];const dx=p.x-s.x,dy=p.y-s.y;
        if(dx*dx+dy*dy<rr*rr){kill(room,s,o,o.name);break;}}
      if(!s.alive)break;
    }
  }
}
function kill(room,s,killer,how){
  if(!s.alive)return;
  s.alive=false;
  /* BUG ARREGLADO: el evento de muerte de abajo enviaba lost:s.val, pero para
     entonces s.val ya estaba a cero (se pone a cero aqui arriba y dentro del
     bloque del killer). El cliente NUNCA veia la cifra perdida, y el mensaje
     "· lost X $LURE" del game over salia vacio siempre. Se captura ANTES. */
  const lostVal=Math.round(s.val);
  if(!killer&&s.val>0){boards.burn+=s.val;s.val=0;dirty=true;} /* wall/timeout: full burn */
  const mass=Math.max(0,s.length-START_LENGTH);
  const nOrbs=Math.min(26,6+Math.floor(mass/90));
  const per=Math.max(4,(mass*DROP_FRACTION)/nOrbs);
  for(let d=0;d<nOrbs;d++){
    const p=s.body[Math.floor(d/nOrbs*s.body.length)]||{x:s.x,y:s.y};
    spawnFood(room,p.x+rand(-14,14),p.y+rand(-14,14),per,s.color);}
  if(killer){
    killer.kills++;
    /* ECONOMY RULES (V2 + bot-safety):
       - a HUMAN killer captures 95% of everything the victim carried,
         5% burns forever. Value only moves between HUMANS.
       - a BOT killer (or the wall) transfers NOTHING: the victim's whole
         carried value burns. The abyss consumed it. Bots can never hold,
         launder or leak $LURE: unfarmable by construction. */
    let gain=0;
    if(s.val>0){
      if(!killer.bot){
        gain=Math.round(s.val*0.95);
        killer.val+=gain;boards.burn+=(s.val-gain);
        /* pico de valor llevado: el killer acaba de crecer */
        if(killer.val>(killer.valPeak||0))killer.valPeak=killer.val;
      }else{
        boards.burn+=s.val; /* bot kill: full burn */
      }
      s.val=0;dirty=true;
    }
    pushEvent(room,killer,{t:'kill',name:s.name,mass:Math.round(s.length),g:gain});
  }
  /* only HUMANS enter the global rankings: bots fill the map, never the podium */
  if(!s.bot)recordScore(s.name,s.peak);
  if(s.bot){s.respawnT=rand(2.5,4.5);}
  else{s.deadHow=how;pushEvent(room,s,{t:'death',how,score:Math.round(s.peak),lost:lostVal,valPeak:Math.round(s.valPeak||0)});}
  s.val=0;
}
function pushEvent(room,s,ev){if(!s.bot){const p=room.players.get(s.id);if(p)p.events.push(ev);}}

let pushT=0;
function buildSnapshot(room,p,snap){
  const msg={t:Math.round(room.simT*1000),you:{alive:p.alive,e:ENTRY,x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,a:p.angle,length:Math.round(p.length),kills:p.kills,score:Math.round(p.peak),val:Math.round(p.val),valPeak:Math.round(p.valPeak||0)},
    snakes:snap,events:p.events.splice(0)};
  if(p.addQ.length>400||p.delQ.length>300){
    p.addQ=[];p.delQ=[];
    msg.foods=[...room.foods.values()];
  }else{
    msg.foodAdd=p.addQ.splice(0);msg.foodDel=p.delQ.splice(0);
  }
  const nowT=Date.now();
  if(nowT-p.lastBoardsTs>3000){p.lastBoardsTs=nowT;Object.assign(msg,cachedBoards());}
  return msg;
}
let lastTickAt=Date.now();
setInterval(()=>{rollDay();
  const nowRT=Date.now();
  let elapsed=(nowRT-lastTickAt)/1000;lastTickAt=nowRT;
  if(elapsed>0.25)elapsed=0.25; /* extreme stall: brief slow-motion beats teleports */
  while(elapsed>0.0001){
    const st=Math.min(TICK,elapsed);
    for(const r of rooms)step(r,st);
    elapsed-=st;
    pushT+=st;
  }
  if(pushT>=0.1){pushT=0;
    for(const r of rooms){
      let snap=null;
      for(const p of r.players.values()){
        if(!p.sse)continue;
        if(!snap)snap=snakesSnapshot(r);
        try{p.sse.write('data: '+JSON.stringify(buildSnapshot(r,p,snap))+'\n\n');}catch(e){p.sse=null;}
      }
    }
  }
  /* clean genuinely disconnected players. NOT the same threshold as the
     AFK conveyor (that fires after 1s of no client motion and keeps the
     creature alive+simulated): this is the final "gone for good" cutoff.
     A hidden tab keeps posting /input, just throttled hard by the browser
     (sometimes to ~once/several-sec), so this must be generous enough to
     survive a normal tab-switch, or the player gets wiped mid-AFK-drive
     and /whereami on return 404s into a stale rubber-band snap-back. */
  const now=Date.now();
  for(const r of rooms)for(const[id,p]of r.players){
    if(now-p.lastSeen>60000){if(p.alive)recordScore(p.name,p.peak);r.players.delete(id);}}
},TICK*1000);

/* ---- snapshots ---- */
function snakesSnapshot(room){
  const out=[];
  for(const s of[...room.players.values(),...room.bots])if(s.alive)
    out.push({i:s.id,n:s.name,x:Math.round(s.x*10)/10,y:Math.round(s.y*10)/10,
      a:Math.round(s.angle*100)/100,l:Math.round(s.length),c:s.color,k:s.kills,v:Math.round(s.val||0)});
  return out;
}
let _bCache=null,_bTs=0;
function cachedBoards(){
  const now=Date.now();
  if(!_bCache||now-_bTs>1000){
    rollDay();
    _bCache={day:topList(boards.day,50),all:topList(boards.all,50),
      pool:boards.pool,burn:boards.burn};
    _bTs=now;
  }
  return _bCache;
}

/* ---- http ---- */
function json(res,code,obj){
  res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type'});
  res.end(JSON.stringify(obj));
}
const server=http.createServer((req,res)=>{
  if(req.method==='OPTIONS')return json(res,200,{});
  if(req.method==='GET'&&req.url.startsWith('/stream')){
    /* Server-Sent Events: a one-way push stream. Snapshots arrive at a steady
       10/s regardless of round-trip latency, which is what makes remote
       snakes smooth on a far-away free-tier server. */
    const qid=(req.url.split('id=')[1]||'').split('&')[0];
    let sroom=null,sp=null;
    for(const r of rooms){if(r.players.has(qid)){sroom=r;sp=r.players.get(qid);break;}}
    if(!sp){res.writeHead(404,{'Access-Control-Allow-Origin':'*'});return res.end();}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',
      'Access-Control-Allow-Origin':'*','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write('retry: 2000\n\n');
    if(sp.sse){try{sp.sse.end();}catch(e){}} /* one stream per player: closing any previous one */
    sp.sse=res;
    req.on('close',()=>{if(sp.sse===res)sp.sse=null;});
    return;
  }
  if(req.method==='GET'&&req.url.startsWith('/whereami')){
    /* on tab-return the client asks where it REALLY is now, snapping to the
       truth (or learning it died) instead of springing back from its frozen
       local copy: this is what kills the shrink/stretch rubber-band. */
    const q=new URL(req.url,'http://x').searchParams.get('id')||'';
    let pl=null;for(const r of rooms)if(r.players.has(q))pl=r.players.get(q);
    if(!pl)return json(res,404,{error:'unknown player'});
    return json(res,200,{alive:pl.alive,x:Math.round(pl.x*10)/10,y:Math.round(pl.y*10)/10,
      a:Math.round(pl.angle*100)/100,length:Math.round(pl.length)});
  }
  if(req.method==='GET'&&req.url.startsWith('/bodies')){
    /* geometry resync after a free-tier stall: the client re-seeds every
       remote body from the REAL server geometry instead of colliding
       against frozen data or fabricated straight catch-up segments */
    const q=new URL(req.url,'http://x').searchParams.get('id')||'';
    let room=null;for(const r of rooms)if(r.players.has(q)){room=r;break;}
    if(!room)return json(res,404,{error:'unknown player'});
    const out=[];
    for(const src of [...room.players.values(),...room.bots]){
      if(!src.alive)continue;
      const b=bodyPolyline(src);
      if(b)out.push({i:src.id,b});
    }
    return json(res,200,{bodies:out});
  }
  if(req.method==='GET'&&req.url.startsWith('/rankings'))return json(res,200,cachedBoards());
  if(req.method==='GET'&&req.url.startsWith('/healthz'))return json(res,200,{ok:true,v:7,rooms:rooms.length});
  let body='';req.on('data',c=>{body+=c;if(body.length>4096)req.destroy();});
  req.on('end',async()=>{
    let d={};try{d=JSON.parse(body||'{}');}catch(e){return json(res,400,{error:'bad json'});}
    if(req.method==='POST'&&req.url==='/match/new'){
      /* THE ABYSS, step 1 of 3: the client asks for an unpredictable matchId
         BEFORE depositing, bound here to a wallet+tier. This is what lets
         /attest/claim later trust "this matchId belongs to this wallet" —
         the browser never gets to invent its own id. */
      if(!ABYSS_ON)return json(res,403,{error:'THE ABYSS is not open yet'});
      if(!web3)return json(res,503,{error:'server misconfigured: solana web3 unavailable'});
      let playerPk;
      try{playerPk=new web3.PublicKey(String(d.player||''));}catch(e){return json(res,400,{error:'invalid player pubkey'});}
      const tier=parseInt(d.tier,10);
      if(!(tier>=0&&tier<4))return json(res,400,{error:'invalid tier'});
      let matchId,hex;
      do{matchId=crypto.randomBytes(32);hex=matchId.toString('hex');}while(pendingMatches.has(hex));
      pendingMatches.set(hex,{matchId,player:playerPk.toBase58(),tier,createdAt:Date.now()});
      return json(res,200,{matchId:hex});
    }
    if(req.method==='POST'&&req.url==='/attest/claim'){
      /* THE ABYSS, step 3 of 3: the player escaped alive (recorded by /leave,
         below) and now wants to cash out on-chain. The browser gets a signed
         message it can transport but never influence — the amount and match
         identity come entirely from what THIS server tracked during the run. */
      if(!ABYSS_ON)return json(res,403,{error:'THE ABYSS is not open yet'});
      if(!web3||!nacl||!attesterKeypair)return json(res,503,{error:'attester not configured on this server'});
      const hex=String(d.matchId||'').toLowerCase();
      if(!/^[0-9a-f]{64}$/.test(hex))return json(res,400,{error:'invalid matchId'});
      const esc=escapedMatches.get(hex);
      if(!esc)return json(res,404,{error:'no recorded escape for this match'});
      if(esc.used)return json(res,409,{error:'already claimed'});
      esc.used=true; /* single-use here; resolve_escape also can't run twice on-chain (match state -> Resolved) */
      try{
        const message=buildAttestationMessage({
          networkTag:ABYSS_NETWORK_TAG,
          programId:abyssProgramId,
          outcome:OUTCOME_ESCAPE_ALIVE,
          matchId:Buffer.from(hex,'hex'),
          matchSeq:esc.seq,
          atRisk:esc.atRisk,
          player:new web3.PublicKey(esc.player),
          counterpartyMatchId:Buffer.alloc(32),
          counterpartySeq:0n,
          expiryUnix:Math.floor(Date.now()/1000)+ABYSS_ATTEST_EXPIRY_S,
        });
        const signature=nacl.sign.detached(message,attesterKeypair.secretKey);
        return json(res,200,{
          message:Buffer.from(message).toString('hex'),
          signature:Buffer.from(signature).toString('hex'),
          attesterPublicKey:new web3.PublicKey(attesterKeypair.publicKey).toBase58(),
        });
      }catch(e){
        esc.used=false; /* signing failed: let them retry instead of burning their one shot */
        return json(res,500,{error:'could not sign attestation: '+e.message});
      }
    }
    if(req.method==='POST'&&req.url==='/boards/seed'){
      /* self-healing rankings for the FREE-TIER phase: a client that holds a
         fuller cached board re-seeds a freshly-woken (wiped) server, so all
         devices converge again. Hardened: sanitized names, score/entry caps.
         IMPORTANT: set ALLOW_SEED=0 in the environment THE DAY real prizes
         exist; from then on the server's own record must be the only truth
         (a paid persistent disk replaces this mechanism). */
      if(process.env.ALLOW_SEED==='0')return json(res,403,{error:'seeding disabled'});
      const clean=b=>(Array.isArray(b)?b:[]).slice(0,200)
        .map(e=>({name:String((e&&e.name)||'').replace(/[<>&"]/g,'').toUpperCase().slice(0,14),
                  score:Math.min(50000,Math.max(0,Math.round((e&&e.score)||0)))}))
        .filter(e=>e.name&&e.score>0&&!BOT_SET.has(e.name));
      rollDay();
      for(const e of clean(d.day))if(!(boards.day[e.name]>=e.score))boards.day[e.name]=e.score;
      for(const e of clean(d.all))if(!(boards.all[e.name]>=e.score))boards.all[e.name]=e.score;
      if(isFinite(d.pool)&&d.pool>boards.pool&&d.pool<1e7)boards.pool=Math.round(d.pool);
      if(isFinite(d.burn)&&d.burn>boards.burn&&d.burn<1e7)boards.burn=Math.round(d.burn);
      if(Object.keys(boards.all).length>BOARD_MAX+50)boards.all=trimBoard(boards.all);
      if(Object.keys(boards.day).length>BOARD_MAX+50)boards.day=trimBoard(boards.day);
      dirty=true;_bCache=null;
      return json(res,200,{ok:1});
    }
    if(req.method==='POST'&&req.url==='/died'){
      /* client-authoritative human death (demo phase): validate that the
         reported killer exists, is alive, and is plausibly in range before
         crediting the capture. Implausible reports still kill the reporter
         (their own death needs no proof) but credit nobody. */
      let room=null,p=null;
      for(const r of rooms){if(r.players.has(d.id)){room=r;p=r.players.get(d.id);break;}}
      if(!p)return json(res,404,{error:'unknown player'});
      if(p.alive){
        let killer=null;
        if(d.killer!==undefined&&d.killer!==null){
          for(const c of [...room.players.values(),...room.bots]){
            if(c.id===d.killer&&c.alive&&c!==p){
              const kdx=c.x-p.x,kdy=c.y-p.y;
              if(kdx*kdx+kdy*kdy<Math.pow(p.length+c.length+500,2))killer=c;
              break;
            }
          }
        }
        const how=String(d.how||'').replace(/[<>&"]/g,'').slice(0,20)||'collision';
        kill(room,p,killer,how);
      }
      return json(res,200,{ok:1});
    }
    if(req.method==='GET'&&req.url==='/xauth/config'){
      /* the client asks which X app to talk to; empty = OAuth not set up
         yet and the client falls back to the manual handle modal */
      return json(res,200,{clientId:process.env.X_CLIENT_ID||''});
    }
    if(req.method==='POST'&&req.url==='/xauth'){
      /* real Sign-in-with-X, PKCE public client: the browser cannot call
         X's token endpoint (no CORS), so this server does the exchange.
         No client secret anywhere: PKCE code_verifier proves the flow. */
      const cid=process.env.X_CLIENT_ID||'';
      if(!cid)return json(res,400,{error:'oauth not configured'});
      const code=String(d.code||'').slice(0,512);
      const ver=String(d.verifier||'').slice(0,128);
      const redir=String(d.redirect||'').slice(0,200);
      if(!code||!ver||!/^https:\/\//.test(redir))return json(res,400,{error:'bad request'});
      (async()=>{
        try{
          const ac=new AbortController();const tt=setTimeout(()=>ac.abort(),10000);
          const secret=process.env.X_CLIENT_SECRET||'';
          const headers={'Content-Type':'application/x-www-form-urlencoded'};
          if(secret) /* confidential client: X requires HTTP Basic auth too */
            headers.Authorization='Basic '+Buffer.from(cid+':'+secret).toString('base64');
          const tr=await fetch('https://api.x.com/2/oauth2/token',{
            method:'POST',signal:ac.signal,headers,
            body:new URLSearchParams({grant_type:'authorization_code',
              client_id:cid,code,redirect_uri:redir,code_verifier:ver}).toString()
          });
          const tok=await tr.json();
          if(!tok.access_token){clearTimeout(tt);return json(res,401,{error:'token exchange failed'});}
          const ur=await fetch('https://api.x.com/2/users/me',{
            signal:ac.signal,headers:{Authorization:'Bearer '+tok.access_token}});
          clearTimeout(tt);
          const u=await ur.json();
          const handle=String((u.data&&u.data.username)||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,15);
          if(!handle)return json(res,401,{error:'no user'});
          return json(res,200,{handle});
        }catch(e){return json(res,502,{error:'x unreachable'});}
      })();
      return;
    }
    if(req.method==='POST'&&req.url==='/join'){
      /* abuse guards: hard caps so join-spam cannot exhaust server memory */
      let totalPlayers=0;for(const r of rooms)totalPlayers+=r.players.size;
      if(totalPlayers>=2000||rooms.length>=60)return json(res,503,{error:'server full'});
      const raw=String(d.name||'ANON').replace(/[<>&"]/g,'').slice(0,14);
      /* X handles keep their case (@darlinxsol stays pretty); everything
         else is uppercased for the arena aesthetic. One canonical form
         per player = no case-twin duplicates on the boards. */
      const name=(raw.startsWith('@')?raw:raw.toUpperCase())||'ANON';
      /* REFERIDOS. El sistema de recompensas se decide mas adelante, pero el
         REGISTRO tiene que existir desde el dia uno: quien trajo a quien no
         se puede reconstruir despues si no se guardo en su momento.
         PRIMERA VEZ MANDA: si este jugador ya tiene referidor, no se toca.
         Sin esa regla cualquiera se auto-refiere en bucle. */
      const refRaw=String(d.ref||'').replace(/^@+/,'').replace(/[^A-Za-z0-9_]/g,'').slice(0,15);
      if(refRaw){
        const ref='@'+refRaw;
        if(ref!==name&&!boards.referrals[name]){   /* y nadie se refiere a si mismo */
          boards.referrals[name]=ref;dirty=true;
        }
      }
      /* THE ABYSS, step 2 of 3: real money only enters the arena after the
         deposit is CONFIRMED on-chain — never on the client's word alone. */
      let abyssBinding=null;
      if(ABYSS_ON){
        if(!web3)return json(res,503,{error:'server misconfigured: solana web3 unavailable'});
        const hex=String(d.matchId||'').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(hex))return json(res,400,{error:'missing or invalid matchId: call /match/new and deposit first'});
        const pending=pendingMatches.get(hex);
        if(!pending)return json(res,410,{error:'unknown or expired matchId: call /match/new again'});
        let match;
        try{match=await fetchMatchAccount(pending.matchId);}
        catch(e){return json(res,502,{error:'could not verify deposit on-chain: '+e.message});}
        if(!match)return json(res,409,{error:'deposit not confirmed on-chain yet'});
        if(match.state!==MATCH_STATE.AT_RISK)return json(res,409,{error:'this match is not at-risk on-chain'});
        if(match.player.toBase58()!==pending.player)return json(res,409,{error:'match belongs to a different wallet'});
        if(!(match.atRisk>0n))return json(res,409,{error:'nothing at risk for this match'});
        pendingMatches.delete(hex); /* one deposit, one arena session */
        abyssBinding={hex,matchId:pending.matchId,player:pending.player,seq:match.seq,atRisk:match.atRisk};
      }
      const room=pickRoom();
      /* Every human used to spawn '#45e8d4': in a busy room everyone was the
         same teal and you could not tell who was who. Pick from the palette
         by hashing the handle, so a player keeps THEIR colour across runs
         and the board colour matches the snake on screen. */
      const s=makeSnake(name,colorFor(name),false);
      s.id='p'+(nextId++);s.events=[];s.lastSeen=Date.now();
      s.addQ=[];s.delQ=[];s.lastBoardsTs=0;
      if(abyssBinding){
        s.abyss=abyssBinding;
        /* real at-risk amount from the chain (base units), NOT the ENTRY
           constant: THE ABYSS's value is whatever was actually deposited. */
        s.val=Number(abyssBinding.atRisk);
        s.valPeak=s.val;
      }else{
        /* simulated entry economics: 20 burn, 10 team, 70 pool (real ones move on-chain) */
        boards.pool+=95;dirty=true; /* V2 entry: 100 = 95 at risk + 5 protocol fee, NO entry burn */
      }
      placeAt(s,safeSpawn(room));
      room.players.set(s.id,s);
      return json(res,200,{proto:7,id:s.id,room:room.id,
        foods:[...room.foods.values()],
        snakes:snakesSnapshot(room).map(sn=>{
          /* seed geometry: a compact polyline of the ACTUAL body (head
             first), so a newly-met snake collides and renders complete
             from frame one instead of growing a tail as you observe it */
          const src=[...room.players.values(),...room.bots].find(x=>x.id===sn.i);
          const b=bodyPolyline(src);if(b)sn.b=b;
          return sn;
        }),...cachedBoards()});
    }
    if(req.method==='POST'&&req.url==='/input'){
      let room=null,p=null;
      for(const r of rooms){if(r.players.has(d.id)){room=r;p=r.players.get(d.id);break;}}
      if(!p)return json(res,404,{error:'unknown player'});
      const nowT=Date.now();
      if(p.alive){
        /* HYBRID MODEL (the one that plays right on 200ms links): the
           CLIENT owns its own movement (instant control) and its own death
           (via /died, validated); the server validates positions with a
           speed clamp, and stays authoritative for bots, eating, length
           and the economy. Full server integration needs regional servers. */
        if(isFinite(d.x)&&isFinite(d.y)){
          /* client-contributed path length feeds the AFK detector. Only
             counts vs the client's OWN last reported point (not the
             server-driven position), so catch-up driving never looks like
             client motion, and a frozen tab resending one point adds 0. */
          if(p._lastCliX!==undefined){
            const cmv=Math.hypot(d.x-p._lastCliX,d.y-p._lastCliY);
            if(cmv>0.5&&cmv<600)p._cliMove=(p._cliMove||0)+cmv;
          }
          p._lastCliX=d.x;p._lastCliY=d.y;
        }
        if(isFinite(d.x)&&isFinite(d.y)&&!p._afk){ /* ignore stale positions while absent: the server drives then */
          /* SPEED BUDGET (anti input-spam): allowance accrues with REAL
             time and is CONSUMED by every accepted move, so flooding inputs
             cannot buy extra distance. Refill capped at max speed + a small
             jitter cushion; the pool itself caps at one big correction. */
          const dtc=Math.min(1,(nowT-(p._lt||nowT))/1000);
          /* speed budget accrues ONLY with real time (=== 0 on a same-ms
             burst, so flooding buys nothing); '??' not '||' so a drained
             pool of 0 is not silently refilled back to a default. */
          if(p._budget===undefined)p._budget=140;
          p._budget=Math.min(420,p._budget+340*dtc);
          const dx=d.x-p.x,dy=d.y-p.y,dist=Math.hypot(dx,dy);
          const step=Math.min(dist,p._budget);
          if(dist>0){p.x+=dx/dist*step;p.y+=dy/dist*step;}
          p._budget-=step;
        }
        if(isFinite(d.angle)){p.angle=d.angle;p.desired=d.angle;}
        p.boost=!!d.boost;
        if(p.length>p.peak)p.peak=p.length;
      }
      p._lt=nowT;
      p.lastSeen=nowT;
      if(d.sse)return json(res,200,{ok:1}); /* SSE mode: state flows via /stream */
      return json(res,200,buildSnapshot(room,p,snakesSnapshot(room)));
    }
    if(req.method==='POST'&&req.url==='/leave'){
      for(const r of rooms){const p=r.players.get(d.id);
        if(p){if(p.alive)recordScore(p.name,p.peak);const sc=Math.round(p.peak),cv=p.alive?Math.round(p.val):0,vp=Math.round(p.valPeak||0);
          if(p.alive&&p.abyss&&cv>0){
            /* THE ABYSS: escaped alive with real value on the head. This is
               the ONLY fact /attest/claim will trust — whatever the client
               says from here on carries no weight. */
            escapedMatches.set(p.abyss.hex,{atRisk:BigInt(cv),seq:p.abyss.seq,player:p.abyss.player,createdAt:Date.now(),used:false});
          }
          r.players.delete(d.id);return json(res,200,{score:sc,val:cv,valPeak:vp});}}
      return json(res,200,{score:0});
    }
    json(res,404,{error:'not found'});
  });
});
process.on('SIGTERM',()=>{try{saveBoards();}catch(e){}process.exit(0);});
/* paste-proof guard: if a bad GitHub paste ever duplicates the tail of
   this file, the second listen call is ignored instead of crashing */
if(!server.listening)server.listen(PORT,()=>console.log('LURE game server on :'+PORT));
module.exports={server,rooms,boards,step,TICK,kill};
