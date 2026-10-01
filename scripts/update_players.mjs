import fs from 'node:fs/promises';
const key=process.env.API_FOOTBALL_KEY;
if(!key) throw new Error('Missing API_FOOTBALL_KEY secret');
const base='https://v3.football.api-sports.io';
const headers={'x-apisports-key':key};
async function api(path){const r=await fetch(base+path,{headers}); if(!r.ok) throw new Error(`${r.status} ${path}`); const j=await r.json(); if(j.errors && Object.keys(j.errors).length) throw new Error(JSON.stringify(j.errors)); return j;}
async function currentLeague(country,name){const j=await api(`/leagues?country=${encodeURIComponent(country)}&name=${encodeURIComponent(name)}`); const x=j.response?.[0]; if(!x) return null; const season=x.seasons?.find(s=>s.current) || x.seasons?.at(-1); return season?{id:x.league.id,season:season.year}:null;}
async function players(league,season){let page=1,out=[]; while(page<=3){const j=await api(`/players?league=${league}&season=${season}&page=${page}`); out.push(...(j.response||[])); if(page>=(j.paging?.total||1)) break; page++;} return out;}
async function transfers(id){try{const j=await api(`/transfers?player=${id}`); return (j.response||[]).slice(-8).map(x=>({date:x.date,from:x.teams?.out?.name,to:x.teams?.in?.name})).filter(x=>x.from&&x.to);}catch{return[]}}
const leagues=[['England','Premier League'],['Spain','La Liga'],['Italy','Serie A'],['Egypt','Premier League'],['Saudi-Arabia','Pro League']];
const all=[];
for(const [country,name] of leagues){const l=await currentLeague(country,name); if(!l) continue; const ps=await players(l.id,l.season); for(const p of ps){const id=p.player?.id; const n=p.player?.name; if(!id||!n) continue; const team=p.statistics?.[0]?.team?.name||p.statistics?.[0]?.team?.name; const pos=(p.statistics?.[0]?.games?.position||'').toLowerCase(); all.push({id,n,photo:p.player.photo,team,position:pos,nationality:p.player.nationality});}}
const unique=[...new Map(all.map(x=>[x.id,x])).values()];
// Build Who Am I candidates from fresh player profiles. Clues are factual, short and ordered hard->easy.
const who=unique.slice(0,80).map(x=>({n:x.n,photo:x.photo,h:[x.nationality?`جنسيتك ${x.nationality}`:'جنسيتك من بلد كروية معروفة',x.team?`بتلعب حاليًا مع ${x.team}`:'بتلعب في أحد الدوريات المعروفة',x.position?`مركزك ${x.position}`:'ليّا مركز معروف في الملعب']}));
const trans=[];
for(const x of unique.slice(0,35)){const tr=await transfers(x.id); const clubs=[]; for(const t of tr){if(!clubs.length) clubs.push(t.from); clubs.push(t.to)} const clean=[...new Set(clubs.filter(Boolean))]; if(clean.length>=3) trans.push({n:x.n,c:clean.slice(-7)});}
const posMap={goalkeeper:'حارس',defender:'مدافع',midfielder:'وسط',attacker:'مهاجم',forward:'مهاجم'};
const auction=unique.filter(x=>posMap[x.position]).slice(0,30).map((x,i)=>({pos:posMap[x.position],shown:x.n,hidden:unique[(i+17)%unique.length]?.n||x.n}));
const data={updatedAt:new Date().toISOString(),who,trans,auction};
await fs.mkdir('data',{recursive:true}); await fs.writeFile('data/live.json',JSON.stringify(data,null,2));
console.log(`Updated: who=${who.length}, trans=${trans.length}, auction=${auction.length}`);
