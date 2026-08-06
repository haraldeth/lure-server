/* LURE multiplayer game server — zero dependencies, deploy anywhere Node runs.
   Authoritative world: rooms of up to 40 real players (bots fill the gaps so
   the map is always alive), server-side physics, kills, corpse drops, GLOBAL
   daily + all-time rankings persisted to disk and shared by every device.
   Protocol: simple HTTP polling (works everywhere, no websockets needed):
     POST /join   {name}                 -> {id,room,you,snakes,foods,day,all}
     POST /input  {id,angle,boost}       -> snapshot {you,snakes,foodAdd,foodDel,events,day,all,pool,burn}
     POST /leave  {id}                   -> {score}
     GET  /rankings                      -> {day,all,pool,burn}   (for the menu)
*/
const http = require('http');
const fs = require('fs');
const PORT = process.env.PORT || 8790;

/* ---- constants (mirror the client) ---- */
const WORLD_R=2500, START_LENGTH=60, FOOD_TARGET=330, MAX_FOOD=520;
const ROOM_CAPACITY=40, BOT_FILL=12, TICK=1/30;
const DROP_FRACTION=0.35;
const BOT_NAMES=['ANGLER','KRAKEN','NAUTILUS','MANTA','VIPER','GLOWWORM','LEVIATHAN','DRIFTER','SIREN','ABYSSAL','LANTERN','EEL'];
const COLORS=['#45e8d4','#ff7ac8','#ffd166','#9d8cff','#7ce38b','#ff9d66'];
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
const norm=a=>{while(a>Math.PI)a-=6.2832;while(a<-Math.PI)a+=6.2832;return a;};
function diskPoint(r){const t=Math.random()*6.2832,d=Math.sqrt(Math.random())*r;return{x:Math.cos(t)*d,y:Math.sin(t)*d};}
const headR=s=>Math.min(8+s.length*0.013,36);
const turnRate=s=>Math.max(2.2-s.length*0.00022,1.05);

/* ---- global rankings (shared by ALL rooms & devices) ---- */
const BOARDS_FILE=process.env.BOARDS_FILE||'./boards.json';
let boards={day:{},all:{},dayId:epochId(),pool:0,burn:0};
function epochId(){const d=new Date();return d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();}
try{const j=JSON.parse(fs.readFileSync(BOARDS_FILE,'utf8'));if(j&&j.all)boards=j;}catch(e){}
function rollDay(){const id=epochId();if(id!==boards.dayId){boards.dayId=id;boards.day={};boards.pool=0;boards.burn=0;saveBoards();}}
let dirty=false;
function saveBoards(){try{fs.writeFileSync(BOARDS_FILE,JSON.stringify(boards));}catch(e){}}
setInterval(()=>{if(dirty){dirty=false;saveBoards();}},15000);
function recordScore(name,score){
  rollDay();score=Math.round(score);
  if(!(score>0))return;
  if(!(boards.day[name]>=score))boards.day[name]=score;
  if(!(boards.all[name]>=score))boards.all[name]=score;
  dirty=true;
}
function topList(map,n){return Object.entries(map).map(([name,score])=>({name,score}))
  .sort((a,b)=>b.score-a.score).slice(0,n);}

/* ---- rooms ---- */
const rooms=[];
function newRoom(){
  const room={players:new Map(),bots:[],foods:new Map(),nextFood:1,foodAdd:[],foodDel:[],id:rooms.length};
  for(let i=0;i<FOOD_TARGET;i++)spawnFood(room);
  room.foodAdd.length=0;
  for(let i=0;i<BOT_FILL;i++)spawnBot(room,i);
  rooms.push(room);return room;
}
function pickRoom(){for(const r of rooms)if(r.players.size<ROOM_CAPACITY)return r;return newRoom();}
function spawnFood(room,x,y,v,c){
  const p=(x===undefined)?diskPoint(WORLD_R*.98):{x,y};
  const big=v===undefined&&Math.random()<.05;
  const f={i:room.nextFood++,x:p.x,y:p.y,v:v!==undefined?v:(big?20:rand(3,7)),c:c||COLORS[(Math.random()*6)|0],big:!!big};
  room.foods.set(f.i,f);room.foodAdd.push(f);return f;
}
function makeSnake(name,color,isBot){
  const p=diskPoint(WORLD_R*.6);
  return{name,color,bot:!!isBot,x:p.x,y:p.y,angle:rand(0,6.28),desired:rand(0,6.28),
    length:START_LENGTH+(isBot?rand(0,120):0),peak:START_LENGTH,boost:false,alive:true,
    path:[{x:p.x,y:p.y}],pathLen:0,body:[{x:p.x,y:p.y}],kills:0,respawnT:0,
    skill:isBot?(Math.random()<.3?rand(.8,1):Math.random()<.6?rand(.45,.75):rand(.2,.4)):1,
    wx:0,wy:0,wT:0};
}
function spawnBot(room,i){const b=makeSnake(BOT_NAMES[i%12],COLORS[i%6],true);b.id='b'+i;room.bots.push(b);}
let nextId=1;

/* ---- physics tick ---- */
function step(room,dt){
  const all=[...room.players.values(),...room.bots].filter(s=>s.alive);
  /* bot AI (simplified port of the client AI) */
  for(const b of room.bots){
    if(!b.alive){b.respawnT-=dt;if(b.respawnT<=0){Object.assign(b,makeSnake(b.name,b.color,true),{id:b.id});}continue;}
    b.wT-=dt;
    const wd=(b.wx-b.x)**2+(b.wy-b.y)**2;
    if(b.wT<=0||wd<120*120){b.wT=rand(3,6);const p=diskPoint(WORLD_R*.8);b.wx=p.x;b.wy=p.y;}
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
      const st=b.skill>.6?4:8;
      for(let i=0;i<o.body.length;i+=st){const p=o.body[i],dx=p.x-b.x,dy=p.y-b.y;
        if(dx*dx+dy*dy<dodge){target=Math.atan2(b.y-p.y,b.x-p.x)+rand(-(1-b.skill)*.9,(1-b.skill)*.9);break;}}}
    b.desired=target;
  }
  /* movement */
  for(const s of all){
    const d=norm(s.desired-s.angle),tr=turnRate(s)*dt;
    s.angle+=clamp(d,-tr,tr);
    const boosting=s.boost&&s.length>90;
    const sp=(boosting?260:165)*dt;
    s.x+=Math.cos(s.angle)*sp;s.y+=Math.sin(s.angle)*sp;
    if(boosting){s.length=Math.max(80,s.length-14*dt);
      if(Math.random()<dt*6)spawnFood(room,s.x-Math.cos(s.angle)*headR(s)*3,s.y-Math.sin(s.angle)*headR(s)*3,3,s.color);}
    const lp=s.path[0],ml=Math.hypot(s.x-lp.x,s.y-lp.y);
    if(ml>4){s.path.unshift({x:s.x,y:s.y});s.pathLen+=ml;
      while(s.pathLen>s.length+220&&s.path.length>2){
        const a=s.path.pop(),b2=s.path[s.path.length-1];
        s.pathLen-=Math.hypot(a.x-b2.x,a.y-b2.y);}}
    /* body points, capped ~120 server-side (collisions only) */
    const stp=Math.max(10,s.length/120);s.body=[];let acc=0,nx=0;
    for(let i=1;i<s.path.length&&acc<s.length;i++){
      const a=s.path[i-1],b2=s.path[i],L=Math.hypot(b2.x-a.x,b2.y-a.y);if(L<1e-4)continue;
      while(nx<=acc+L&&nx<=s.length){const k=(nx-acc)/L;
        s.body.push({x:a.x+(b2.x-a.x)*k,y:a.y+(b2.y-a.y)*k});nx+=stp;}
      acc+=L;}
  }
  /* eating */
  for(const s of all){const hr=headR(s);
    for(const f of room.foods.values()){
      const dx=f.x-s.x,dy=f.y-s.y,rr=hr+3+f.v*.3+6;
      if(dx*dx+dy*dy<rr*rr){
        const sizeM=1/(1+Math.max(0,s.length-START_LENGTH)/2600);
        s.length+=f.v*sizeM;
        room.foods.delete(f.i);room.foodDel.push(f.i);
      }}}
  while(room.foods.size<FOOD_TARGET)spawnFood(room);
  if(room.foods.size>MAX_FOOD){const it=room.foods.keys();
    while(room.foods.size>MAX_FOOD){const k=it.next().value;room.foods.delete(k);room.foodDel.push(k);}}
  /* collisions: head vs others' bodies + wall */
  for(const s of all){
    if(!s.alive)continue;
    if(Math.hypot(s.x,s.y)>WORLD_R){kill(room,s,null,'the wall');continue;}
    const hr=headR(s);
    for(const o of all){
      if(o===s||!o.alive)continue;
      const dx0=o.x-s.x,dy0=o.y-s.y;
      if(dx0*dx0+dy0*dy0>(o.length+300)**2)continue;
      const bstep=Math.max(10,o.length/120);
      const rr=hr+headR(o)*.8+bstep*.5;
      for(const p of o.body){const dx=p.x-s.x,dy=p.y-s.y;
        if(dx*dx+dy*dy<rr*rr){kill(room,s,o,o.name);break;}}
      if(!s.alive)break;
    }
  }
}
function kill(room,s,killer,how){
  if(!s.alive)return;
  s.alive=false;
  const mass=Math.max(0,s.length-START_LENGTH);
  const nOrbs=Math.min(26,6+Math.floor(mass/90));
  const per=Math.max(4,(mass*DROP_FRACTION)/nOrbs);
  for(let d=0;d<nOrbs;d++){
    const p=s.body[Math.floor(d/nOrbs*s.body.length)]||{x:s.x,y:s.y};
    spawnFood(room,p.x+rand(-14,14),p.y+rand(-14,14),per,s.color);}
  if(killer){killer.kills++;pushEvent(room,killer,{t:'kill',name:s.name,mass:Math.round(s.length)});}
  recordScore(s.name,s.peak);
  if(s.bot){s.respawnT=rand(2.5,4.5);}
  else{s.deadHow=how;pushEvent(room,s,{t:'death',how,score:Math.round(s.peak)});}
}
function pushEvent(room,s,ev){if(!s.bot){const p=room.players.get(s.id);if(p)p.events.push(ev);}}

setInterval(()=>{rollDay();for(const r of rooms)step(r,TICK);
  /* clean disconnected players (no input for 10s) */
  const now=Date.now();
  for(const r of rooms)for(const[id,p]of r.players){
    if(now-p.lastSeen>10000){if(p.alive)recordScore(p.name,p.peak);r.players.delete(id);}}
},TICK*1000);

/* ---- snapshots ---- */
function snakesSnapshot(room){
  const out=[];
  for(const s of[...room.players.values(),...room.bots])if(s.alive)
    out.push({i:s.id,n:s.name,x:Math.round(s.x*10)/10,y:Math.round(s.y*10)/10,
      a:Math.round(s.angle*100)/100,l:Math.round(s.length),c:s.color,k:s.kills});
  return out;
}
function boardsSnapshot(){rollDay();return{day:topList(boards.day,50),all:topList(boards.all,50),
  pool:boards.pool,burn:boards.burn};}

/* ---- http ---- */
function json(res,code,obj){
  res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type'});
  res.end(JSON.stringify(obj));
}
const server=http.createServer((req,res)=>{
  if(req.method==='OPTIONS')return json(res,200,{});
  if(req.method==='GET'&&req.url.startsWith('/rankings'))return json(res,200,boardsSnapshot());
  if(req.method==='GET'&&req.url.startsWith('/healthz'))return json(res,200,{ok:true,rooms:rooms.length});
  let body='';req.on('data',c=>{body+=c;if(body.length>4096)req.destroy();});
  req.on('end',()=>{
    let d={};try{d=JSON.parse(body||'{}');}catch(e){return json(res,400,{error:'bad json'});}
    if(req.method==='POST'&&req.url==='/join'){
      const name=String(d.name||'ANON').replace(/[<>&"]/g,'').toUpperCase().slice(0,14)||'ANON';
      const room=pickRoom();
      const s=makeSnake(name,'#45e8d4',false);
      s.id='p'+(nextId++);s.events=[];s.lastSeen=Date.now();
      /* simulated entry economics: 20 burn, 10 team, 70 pool (real ones move on-chain) */
      boards.burn+=20;boards.pool+=70;dirty=true;
      room.players.set(s.id,s);
      return json(res,200,{id:s.id,room:room.id,
        foods:[...room.foods.values()],snakes:snakesSnapshot(room),...boardsSnapshot()});
    }
    if(req.method==='POST'&&req.url==='/input'){
      let room=null,p=null;
      for(const r of rooms){if(r.players.has(d.id)){room=r;p=r.players.get(d.id);break;}}
      if(!p)return json(res,404,{error:'unknown player'});
      p.lastSeen=Date.now();
      if(p.alive){if(isFinite(d.angle))p.desired=d.angle;p.boost=!!d.boost;
        if(p.length>p.peak)p.peak=p.length;}
      const ev=p.events;p.events=[];
      const resp={you:{alive:p.alive,length:Math.round(p.length),kills:p.kills,score:Math.round(p.peak)},
        snakes:snakesSnapshot(room),foodAdd:room.foodAdd.splice(0),foodDel:room.foodDel.splice(0),
        events:ev,...boardsSnapshot()};
      return json(res,200,resp);
    }
    if(req.method==='POST'&&req.url==='/leave'){
      for(const r of rooms){const p=r.players.get(d.id);
        if(p){if(p.alive)recordScore(p.name,p.peak);const sc=Math.round(p.peak);
          r.players.delete(d.id);return json(res,200,{score:sc});}}
      return json(res,200,{score:0});
    }
    json(res,404,{error:'not found'});
  });
});
server.listen(PORT,()=>console.log('LURE game server on :'+PORT));
module.exports={server,rooms,boards};
