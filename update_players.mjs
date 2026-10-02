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
  if (j.errors && Object.keys(j.errors).length) {
    throw new Error(JSON.stringify(j.errors));
  }
  return j;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function currentLeague(country, name) {
  const j = await api(
    `/leagues?country=${encodeURIComponent(country)}&name=${encodeURIComponent(name)}`
  );

  const x = j.response?.[0];
  if (!x) return null;

  const season =
    x.seasons?.find(s => s.current) ||
    x.seasons?.at(-1);

  return season
    ? {
        id: x.league.id,
        season: season.year,
        name: x.league.name
      }
    : null;
}

// Keep the request count reasonable while still giving the rotation a large pool.
async function players(league, season) {
  let page = 1;
  const out = [];

  while (page <= 5) {
    const j = await api(
      `/players?league=${league}&season=${season}&page=${page}`
    );

    out.push(...(j.response || []));

    if (page >= (j.paging?.total || 1)) break;
    page++;
  }

  return out;
}

// Full transfer history for the "أنا مين؟" clues.
async function playerTransfers(id) {
  try {
    const j = await api(`/transfers?player=${id}`);

    const rows = [];

    for (const item of j.response || []) {
      const transfers = item.transfers || [];

      for (const t of transfers) {
        const from = t.teams?.out?.name;
        const to = t.teams?.in?.name;
        const date = t.date || '';

        if (from || to) {
          rows.push({
            date,
            from,
            to
          });
        }
      }
    }

    return rows;
  } catch {
    return [];
  }
}

async function transfers(id) {
  try {
    const j = await api(`/transfers?player=${id}`);

    return (j.response || [])
      .flatMap(x =>
        (x.transfers || []).map(t => ({
          date: t.date,
          from: t.teams?.out?.name,
          to: t.teams?.in?.name
        }))
      )
      .filter(x => x.from && x.to)
      .slice(-10);
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

const state = await readJson(
  STATE_FILE,
  {
    who: [],
    trans: [],
    auction: []
  }
);

function fresh(list, used, count) {
  const available = list.filter(
    x => !used.includes(String(x.id))
  );

  if (available.length >= count) {
    return available.slice(0, count);
  }

  return [
    ...available,
    ...list
      .filter(x => !available.includes(x))
      .slice(0, count - available.length)
  ];
}

function mark(stateList, selected) {
  return [
    ...stateList,
    ...selected.map(x => String(x.id))
  ].slice(-5000);
}

const posMap = {
  goalkeeper: 'حارس',
  defender: 'مدافع',
  midfielder: 'وسط',
  attacker: 'مهاجم',
  forward: 'مهاجم'
};


// ============================================================
// أنا مين؟
// تلميحات قصصية متدرجة على طريقة Claude
// ============================================================

async function cluePack(x) {
  const clues = [];

  const history = await playerTransfers(x.id);

  // ترتيب زمني للانتقالات
  const sorted = [...history].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );

  // استخراج الأندية بدون تكرار
  const clubs = [];

  for (const item of sorted) {
    if (item.from && !clubs.includes(item.from)) {
      clubs.push(item.from);
    }

    if (item.to && !clubs.includes(item.to)) {
      clubs.push(item.to);
    }
  }

  const cleanClubs = clubs.filter(Boolean);

  // ----------------------------------------------------------
  // 1 - البداية: سنة الميلاد + المدينة + المركز
  // ----------------------------------------------------------

  if (x.birth) {
    const year = String(x.birth).slice(0, 4);

    if (x.birthPlace && x.position) {
      clues.push(
        `اتولدت سنة ${year} في ${x.birthPlace}، واشتغلت في الملعب بمركز ${posMap[x.position] || x.position} وده المركز اللي اتعرفت بيه أغلب مسيرتك.`
      );
    } else if (x.birthPlace) {
      clues.push(
        `اتولدت سنة ${year} في ${x.birthPlace}، وكانت كرة القدم هي الطريق اللي بدأت منه مسيرتك الاحترافية.`
      );
    } else if (x.position) {
      clues.push(
        `اتولدت سنة ${year}، واشتغلت في الملعب بمركز ${posMap[x.position] || x.position} خلال أغلب مسيرتك.`
      );
    }
  }

  // ----------------------------------------------------------
  // 2 - أول محطة
  // ----------------------------------------------------------

  if (cleanClubs.length >= 1) {
    clues.push(
      `من أول المحطات اللي مرّيت بيها في مسيرتي كانت نادي ${cleanClubs[0]}، وكانت بداية رحلة طويلة بين أندية مختلفة.`
    );
  }

  // ----------------------------------------------------------
  // 3 - مجموعة من الأندية
  // ----------------------------------------------------------

  if (cleanClubs.length >= 4) {
    const middle = cleanClubs
      .slice(1, Math.min(cleanClubs.length, 8))
      .join(' ونادي ');

    clues.push(
      `اتنقلت في مسيرتي بين أندية زي نادي ${middle} قبل ما أوصل لمحطات متقدمة في مشواري.`
    );
  } else if (cleanClubs.length >= 2) {
    clues.push(
      `خلال مسيرتي تنقلت بين أكتر من نادي، ومن أبرز المحطات نادي ${cleanClubs.slice(0, 4).join(' ونادي ')}.`
    );
  }

  // ----------------------------------------------------------
  // 4 - عدد الأندية
  // ----------------------------------------------------------

  if (cleanClubs.length >= 2) {
    clues.push(
      `لعبت في ${cleanClubs.length} أندية مختلفة خلال مسيرتي الاحترافية.`
    );
  }

  // ----------------------------------------------------------
  // 5 - آخر محطة
  // ----------------------------------------------------------

  if (cleanClubs.length >= 2) {
    const lastClub = cleanClubs[cleanClubs.length - 1];

    clues.push(
      `آخر محطة متسجلة ليا في المسيرة كانت نادي ${lastClub}.`
    );
  }

  // ----------------------------------------------------------
  // 6 - معلومة إضافية
  // ----------------------------------------------------------

  if (x.nationality) {
    clues.push(
      `بحمل جنسية ${x.nationality}، وده البلد اللي بتمثلها على المستوى الدولي.`
    );
  } else if (x.league) {
    clues.push(
      `حاليًا مسيرتي مرتبطة بالدوري ${x.league}.`
    );
  }

  // ----------------------------------------------------------
  // 7 - التلميح الأخير: النادي الحالي / المركز
  // ----------------------------------------------------------

  if (x.team && x.position) {
    clues.push(
      `حاليًا بلعب مع ${x.team} في مركز ${posMap[x.position] || x.position}.`
    );
  } else if (x.team) {
    clues.push(
      `حاليًا بلعب مع ${x.team}.`
    );
  } else if (x.position) {
    clues.push(
      `مركزي الأساسي في الملعب هو ${posMap[x.position] || x.position}.`
    );
  }

  // ----------------------------------------------------------
  // في حالة عدم توفر تاريخ انتقالات كافي
  // ----------------------------------------------------------

  const fallback = [
    x.birthPlace
      ? `مكان ميلادي كان ${x.birthPlace}.`
      : null,

    x.nationality
      ? `بحمل جنسية ${x.nationality}.`
      : null,

    x.age
      ? `سني حاليًا حوالي ${x.age} سنة.`
      : null,

    x.height
      ? `طولي حوالي ${x.height}.`
      : null,

    x.league
      ? `بلعب في ${x.league}.`
      : null,

    x.position
      ? `مركزي الأساسي هو ${posMap[x.position] || x.position}.`
      : null,

    x.team
      ? `بلعب حاليًا مع ${x.team}.`
      : null
  ].filter(Boolean);

  for (const c of fallback) {
    if (clues.length >= 7) break;
    if (!clues.includes(c)) clues.push(c);
  }

  // لازم h تفضل بنفس الشكل اللي Claude مستنيه
  return clues.slice(0, 7);
}


// ============================================================
// أنا مين
// ============================================================

const whoPool = unique.filter(x => x.photo);
const whoSelected = fresh(whoPool, state.who, 80);

const who = [];

for (const x of whoSelected) {
  const h = await cluePack(x);

  who.push({
    n: x.n,
    photo: x.photo,
    h
  });
}


// ============================================================
// الانتقالات
// ============================================================

const transferSelected = fresh(
  unique,
  state.trans,
  35
);

const trans = [];

for (const x of transferSelected) {
  const tr = await transfers(x.id);

  const clubs = [];

  for (const t of tr) {
    if (t.from) clubs.push(t.from);
    if (t.to) clubs.push(t.to);
  }

  const clean = [
    ...new Set(clubs.filter(Boolean))
  ];

  if (clean.length >= 3) {
    trans.push({
      n: x.n,
      c: clean.slice(-7)
    });
  }
}


// ============================================================
// المزاد
// ============================================================

const auctionPool = unique.filter(
  x => x.photo && posMap[x.position]
);

const auctionSelected = fresh(
  auctionPool,
  state.auction,
  30
);

const auction = auctionSelected.map((x, i) => ({
  pos: posMap[x.position],
  shown: x.n,
  hidden:
    auctionPool[(i + 17) % auctionPool.length]?.n ||
    x.n
}));


// ============================================================
// حفظ الحالة
// ============================================================

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

await fs.writeFile(
  DATA_FILE,
  JSON.stringify(data, null, 2)
);

await fs.writeFile(
  STATE_FILE,
  JSON.stringify(nextState, null, 2)
);

console.log(
  `Updated: who=${who.length}, trans=${trans.length}, auction=${auction.length}`
);
