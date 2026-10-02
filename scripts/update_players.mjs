import fs from 'node:fs/promises';

const key = process.env.API_FOOTBALL_KEY;
if (!key) throw new Error('Missing API_FOOTBALL_KEY secret');

const base = 'https://v3.football.api-sports.io';
const headers = { 'x-apisports-key': key };
const DATA_FILE = 'data/live.json';
const STATE_FILE = 'data/player_state.json';

async function api(path) {
  const r = await fetch(base + path, { headers });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(JSON.stringify(j.errors));
  return j;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function currentLeague(country, name) {
  const j = await api(`/leagues?country=${encodeURIComponent(country)}&name=${encodeURIComponent(name)}`);
  const x = j.response?.[0];
  if (!x) return null;
  const season = x.seasons?.find(s => s.current) || x.seasons?.at(-1);
  return season ? { id: x.league.id, season: season.year, name: x.league.name } : null;
}

// Keep the request count reasonable while still giving the rotation a large pool.
async function players(league, season) {
  let page = 1;
  const out = [];
  while (page <= 5) {
    const j = await api(`/players?league=${league}&season=${season}&page=${page}`);
    out.push(...(j.response || []));
    if (page >= (j.paging?.total || 1)) break;
    page++;
  }
  return out;
}

async function transfers(id) {
  try {
    const j = await api(`/transfers?player=${id}`);
    return (j.response || [])
      .slice(-10)
      .map(x => ({ date: x.date, from: x.teams?.out?.name, to: x.teams?.in?.name }))
      .filter(x => x.from && x.to);
  } catch {
    return [];
  }
}

const leagues = [
  ['England', 'Premier League'],
  ['Spain', 'La Liga'],
  ['Italy', 'Serie A'],
  ['Egypt', 'Premier League'],
  ['Saudi-Arabia', 'Pro League']
];

const all = [];
for (const [country, name] of leagues) {
  const l = await currentLeague(country, name);
  if (!l) continue;
  const ps = await players(l.id, l.season);
  for (const p of ps) {
    const id = p.player?.id;
    const n = p.player?.name;
    if (!id || !n) continue;
    const stat = p.statistics?.[0];
    all.push({
      id,
      n,
      photo: p.player?.photo,
      team: stat?.team?.name,
      league: l.name,
      position: (stat?.games?.position || '').toLowerCase(),
      nationality: p.player?.nationality,
      age: p.player?.age,
      birth: p.player?.birth?.date,
      birthPlace: p.player?.birth?.place,
      birthCountry: p.player?.birth?.country,
      height: p.player?.height,
      weight: p.player?.weight
    });
  }
}

const unique = [...new Map(all.map(x => [x.id, x])).values()];
const state = await readJson(STATE_FILE, { who: [], trans: [], auction: [] });

function fresh(list, used, count) {
  const available = list.filter(x => !used.includes(String(x.id)));
  if (available.length >= count) return available.slice(0, count);
  // If a category eventually exhausts its pool, start a new cycle only for that category.
  return [...available, ...list.filter(x => !available.includes(x)).slice(0, count - available.length)];
}

function mark(stateList, selected) {
  return [...stateList, ...selected.map(x => String(x.id))].slice(-5000);
}

const posMap = {
  goalkeeper: 'حارس',
  defender: 'مدافع',
  midfielder: 'وسط',
  attacker: 'مهاجم',
  forward: 'مهاجم'
};

function cluePack(x) {
  const clues = [];
  if (x.birthCountry) clues.push(`اتولدت في ${x.birthCountry}`);
  else if (x.nationality) clues.push(`جنسيتك ${x.nationality}`);
  if (x.birthPlace) clues.push(`مكان ميلادك ${x.birthPlace}`);
  if (x.age) clues.push(`سنك حاليًا حوالي ${x.age} سنة`);
  if (x.height) clues.push(`طولك حوالي ${x.height}`);
  if (x.nationality && !clues.some(c => c.includes(x.nationality))) clues.push(`جنسيتك ${x.nationality}`);
  if (x.league) clues.push(`بتلعب في ${x.league}`);
  if (x.position) clues.push(`مركزك ${posMap[x.position] || x.position}`);
  if (x.team) clues.push(`بتلعب حاليًا مع ${x.team}`);

  // The Claude game expects an array of clues. Always give it seven when possible.
  const fallback = [
    'ليّا مركز معروف في الملعب',
    'لاعب محترف في كرة القدم',
    'بتلعب في أحد الدوريات المعروفة'
  ];
  for (const c of fallback) if (!clues.includes(c)) clues.push(c);
  return clues.slice(0, 7);
}

// أنا مين: 80 fresh players, each with the same h[] shape consumed by Claude's game.
const whoPool = unique.filter(x => x.photo);
const whoSelected = fresh(whoPool, state.who, 80);
const who = whoSelected.map(x => ({ n: x.n, photo: x.photo, h: cluePack(x) }));

// الانتقالات: choose fresh players, then fetch their transfer history.
const transferSelected = fresh(unique, state.trans, 35);
const trans = [];
for (const x of transferSelected) {
  const tr = await transfers(x.id);
  const clubs = [];
  for (const t of tr) {
    if (t.from) clubs.push(t.from);
    if (t.to) clubs.push(t.to);
  }
  const clean = [...new Set(clubs.filter(Boolean))];
  if (clean.length >= 3) trans.push({ n: x.n, c: clean.slice(-7) });
}

// المزاد: same {pos, shown, hidden} structure consumed by Claude's game.
const auctionPool = unique.filter(x => x.photo && posMap[x.position]);
const auctionSelected = fresh(auctionPool, state.auction, 30);
const auction = auctionSelected.map((x, i) => ({
  pos: posMap[x.position],
  shown: x.n,
  hidden: auctionPool[(i + 17) % auctionPool.length]?.n || x.n
}));

const nextState = {
  who: mark(state.who, whoSelected),
  trans: mark(state.trans, transferSelected),
  auction: mark(state.auction, auctionSelected)
};

const data = {
  updatedAt: new Date().toISOString(),
  who,
  trans,
  auction
};

await fs.mkdir('data', { recursive: true });
await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
await fs.writeFile(STATE_FILE, JSON.stringify(nextState, null, 2));
console.log(`Updated: who=${who.length}, trans=${trans.length}, auction=${auction.length}`);
