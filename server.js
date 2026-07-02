require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
app.set('trust proxy', 1);
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    done(null, result.rows[0]);
  } catch (err) {
    done(err);
  }
});
console.log('BASE_URL =', process.env.BASE_URL);
console.log(
  'GOOGLE CALLBACK =',
  `${process.env.BASE_URL}/auth/google/callback`
);
passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id;
      const email = profile.emails?.[0]?.value || null;
      const displayName = profile.displayName || 'Google User';

      let result = await pool.query(
        `SELECT * FROM users WHERE google_id = $1`,
        [googleId]
      );

      if (result.rows[0]) {
        return done(null, result.rows[0]);
      }

      let baseUsername = displayName
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 18) || 'googleuser';

      let username = baseUsername;
      let counter = 1;

      while (true) {
        const existing = await pool.query(
          `SELECT id FROM users WHERE username = $1`,
          [username]
        );

        if (existing.rows.length === 0) break;

        username = `${baseUsername}${counter}`;
        counter++;
      }

      const created = await pool.query(
        `
        INSERT INTO users (username, password, google_id, email, auth_provider)
        VALUES ($1, NULL, $2, $3, 'google')
        RETURNING *
        `,
        [username, googleId, email]
      );

      return done(null, created.rows[0]);
    } catch (err) {
      return done(err);
    }
  }
));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon-v3.PNG'));
});

// =========================
// SMALL POSTGRES HELPERS
// =========================

function sqlParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  run(sql, params = [], cb = () => {}) {
    pool.query(sqlParams(sql), params)
      .then(result => {
        cb.call({
          changes: result.rowCount,
          lastID: result.rows?.[0]?.id
        }, null);
      })
      .catch(err => cb(err));
  },

  get(sql, params = [], cb = () => {}) {
    pool.query(sqlParams(sql), params)
      .then(result => cb(null, result.rows[0]))
      .catch(err => cb(err));
  },

  all(sql, params = [], cb = () => {}) {
    pool.query(sqlParams(sql), params)
      .then(result => cb(null, result.rows))
      .catch(err => cb(err));
  }
};

async function setupDatabase() {



  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT,
  is_admin INTEGER DEFAULT 0,
      credits_left INTEGER DEFAULT 100,
      knockout_bonus_given INTEGER DEFAULT 0,
      last_login_at TIMESTAMP,
      last_seen_at TIMESTAMP

    )
  `);
    await pool.query(`
ALTER TABLE users
ADD COLUMN IF NOT EXISTS round32_bonus_given BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'local'`);
      
  await pool.query(`
  CREATE TABLE IF NOT EXISTS league_messages (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS competitions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE
    )
  `);

  await pool.query(`
    INSERT INTO competitions (id, name, slug)
    VALUES (1, 'World Cup 2026', 'worldcup')
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      external_id TEXT UNIQUE,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      game_date TEXT NOT NULL,
      game_time TEXT NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      status TEXT NOT NULL,
      competition_id INTEGER,
      stage TEXT,
      home_logo TEXT,
      away_logo TEXT
    )
  `);

  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS live_status TEXT`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS live_minute INTEGER`);
  await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS last_api_update TIMESTAMP`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      home_guess INTEGER NOT NULL,
      away_guess INTEGER NOT NULL,
      credits_used INTEGER NOT NULL,
      points_won INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leagues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT UNIQUE NOT NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_reads (
      user_id INTEGER NOT NULL,
      league_id INTEGER NOT NULL,
      last_seen_message_id INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, league_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_members (
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (league_id, user_id)
    )
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS pinned_matches (
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, game_id)
  )
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS global_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `);

  await pool.query(`
  ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS prize_1 TEXT
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS rank_movement_announcements (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL,
    league_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    old_rank INTEGER NOT NULL,
    new_rank INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, league_id, user_id, old_rank, new_rank)
  )
`);

await pool.query(`
  ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS prize_2 TEXT
`);

await pool.query(`
  ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS prize_3 TEXT
`);

await pool.query(`
  ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS prize_4 TEXT
`);

await pool.query(`
  ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS prize_5 TEXT
`);

await pool.query(`
  UPDATE users
  SET
    credits_left = credits_left + 25,
    round32_bonus_given = TRUE
  WHERE round32_bonus_given = FALSE
     OR round32_bonus_given IS NULL
`);
}

async function ensureAdminUser() {
  const existing = await pool.query(`SELECT id FROM users WHERE username = $1`, ['admin']);
  if (existing.rows.length > 0) return;

  const hash = await bcrypt.hash('1234', 10);
  await pool.query(
    `INSERT INTO users (username, password, is_admin, credits_left, knockout_bonus_given)
     VALUES ($1, $2, 1, 100, 0)`,
    ['admin', hash]
  );

  console.log('admin created: admin / 1234');
}

// =========================
// HELPERS
// =========================

function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  const isApiRequest =
    req.originalUrl.startsWith('/chat/') ||
    req.originalUrl.includes('/chat/messages') ||
    req.originalUrl.includes('/chat/send') ||
    req.originalUrl.startsWith('/js/') ||
    req.originalUrl.startsWith('/css/');

  if (!isApiRequest) {
    req.session.returnTo = req.originalUrl;
  }

  return res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (!req.session.userId || req.session.isAdmin !== 1) {
    return res.send('No permission');
  }
  next();
}

function makeJoinCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}


function apiDateToIsraelParts(apiDate) {
  const dateObj = new Date(apiDate);

  return {
    date: dateObj.toISOString().slice(0, 10),
    time: dateObj.toISOString().slice(11, 16)
  };
}
function getNowUtcParts() {
  const now = new Date();

  return {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16)
  };
}

function canGuess(game_date, game_time) {
  const now = getNowUtcParts();

  if (game_date > now.date) return true;
  if (game_date < now.date) return false;

  return game_time > now.time;
}

function formatStage(stage) {
  const s = String(stage || '').toUpperCase();

  if (s.includes('ROUND') && s.includes('32')) return 'Round of 32';
  if (s.includes('ROUND') && s.includes('16')) return 'Round of 16';
  if (s.includes('LAST_16')) return 'Round of 16';
  if (s.includes('QUARTER')) return 'Quarter Finals';
  if (s.includes('SEMI')) return 'Semi Finals';
  if (s.includes('FINAL')) return 'Final';

  return 'Group-stage';
}

function normalizeStage(stage) {
  const s = String(stage || '').toUpperCase().trim();

  if (s.includes('ROUND') && s.includes('32')) return 'ROUND_OF_32';
  if (s.includes('ROUND') && s.includes('16')) return 'LAST_16';
  if (s.includes('LAST_16')) return 'LAST_16';
  if (s.includes('QUARTER')) return 'QUARTER_FINALS';
  if (s.includes('SEMI')) return 'SEMI_FINALS';
  if (s.includes('THIRD')) return 'THIRD_PLACE';
  if (s.includes('FINAL')) return 'FINAL';

  return 'GROUP';
}

function getStageMultiplier(stage) {
  switch (normalizeStage(stage)) {
    case 'LAST_16': return 2;
    case 'QUARTER_FINALS': return 3;
    case 'SEMI_FINALS': return 4;
    case 'FINAL': return 5;
    default: return 1;
  }
}

function getStageMaxCredits(stage) {
  switch (normalizeStage(stage)) {
    case 'ROUND_OF_32': return 5;
    case 'LAST_16': return 5;
    case 'QUARTER_FINALS': return 4;
    case 'SEMI_FINALS': return 3;
    case 'FINAL': return 2;
    case 'THIRD_PLACE': return 2;
    case 'GROUP':
    default: return 6;
  }
}

function calcPoints(hg, ag, hs, as, stage) {
  let basePoints = 0;

  if (hg === hs && ag === as) {
    basePoints = 3;
  } else {
    const guessDiff = hg - ag;
    const realDiff = hs - as;

    const sameOutcome =
      (guessDiff > 0 && realDiff > 0) ||
      (guessDiff < 0 && realDiff < 0) ||
      (guessDiff === 0 && realDiff === 0);

    basePoints = sameOutcome ? 1 : 0;
  }

  return basePoints * getStageMultiplier(stage);
}

function isStrongPassword(password) {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

function renderSideNav(req) {
  const isLoggedIn = !!req.session.userId;
  const isAdmin = Number(req.session.isAdmin) === 1;

  return `
    <button class="side-nav-toggle" onclick="toggleSideNav()">
      ☰
    </button>

    <a href="/chats" class="chat-mini-btn" title="Chats">
  💬
</a>

<a
  href="https://instagram.com/predictwc"
  target="_blank"
  class="chat-mini-btn instagram-btn"
  title="Instagram"
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="white"
  >
    <path d="M7.75 2C4.57 2 2 4.57 2 7.75v8.5C2 19.43 4.57 22 7.75 22h8.5C19.43 22 22 19.43 22 16.25v-8.5C22 4.57 19.43 2 16.25 2h-8.5zm0 2h8.5A3.75 3.75 0 0 1 20 7.75v8.5A3.75 3.75 0 0 1 16.25 20h-8.5A3.75 3.75 0 0 1 4 16.25v-8.5A3.75 3.75 0 0 1 7.75 4zm8.75 1a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 16.5 5zM12 7a5 5 0 1 0 0 10a5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6a3 3 0 0 1 0-6z"/>
  </svg>
</a>



    <div id="sideNavOverlay" class="side-nav-overlay" onclick="closeSideNav()"></div>

    <aside id="sideNav" class="side-nav">
      <div class="side-nav-title">WorldCup Predict</div>

      <a href="/">Home</a>
      <a href="/games">Games</a>
      <a href="/leaderboard">Leaderboard</a>

      ${isLoggedIn ? `<a href="/leagues">Private Leagues</a>` : ''}
      ${isLoggedIn ? `<a href="/chats">Chats</a>` : ''}
      ${isLoggedIn ? `<a href="/my-bets">My Bets</a>` : ''}
      ${isLoggedIn ? `<a href="/profile/${req.session.userId}">My Profile</a>` : ''}

      <a href="/help">Help</a>

      ${isAdmin ? `<a href="/admin">Admin</a>` : ''}

      ${isLoggedIn ? `<a class="danger-link" href="/logout">Logout</a>` : `<a href="/login">Login</a>`}
    </aside>

    <script>
      function toggleSideNav() {
        document.getElementById('sideNav').classList.toggle('open-side-nav');
        document.getElementById('sideNavOverlay').classList.toggle('show-side-nav-overlay');
      }

      function closeSideNav() {
        document.getElementById('sideNav').classList.remove('open-side-nav');
        document.getElementById('sideNavOverlay').classList.remove('show-side-nav-overlay');
      }
    </script>
  `;
}



// =========================
// API SYNC
// =========================

async function fetchWorldCupMatches() {
  const url = 'https://v3.football.api-sports.io/fixtures?league=1&season=2026';

  const response = await fetch(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY
    }
  });

  const data = await response.json();

  console.log('API status:', response.status);
  console.log('API errors:', data.errors);
  console.log('API results:', data.results);

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

async function getLeagueRanking(leagueId) {
  const result = await pool.query(
    `
    SELECT
      u.id AS user_id,
      u.username,
      COALESCE(SUM(b.points_won), 0) AS total_points
    FROM league_members lm
    JOIN users u ON u.id = lm.user_id
    LEFT JOIN bets b ON b.user_id = u.id
    WHERE lm.league_id = $1
    GROUP BY u.id, u.username
    ORDER BY total_points DESC, u.username ASC
    `,
    [leagueId]
  );

  const ranks = {};

  result.rows.forEach((r, index) => {
    ranks[r.user_id] = {
      rank: index + 1,
      username: r.username,
      points: Number(r.total_points || 0)
    };
  });

  return ranks;
}

function getPrizeZoneSize(league) {
  let size = 0;

  if (league.prize_1) size = 1;
  if (league.prize_2) size = 2;
  if (league.prize_3) size = 3;
  if (league.prize_4) size = 4;
  if (league.prize_5) size = 5;

  return size;
}

async function recalculatePointsForGameByExternalId(externalId, homeScore, awayScore) {
  const gameResult = await pool.query(
    `SELECT id, stage FROM games WHERE external_id = $1`,
    [externalId]
  );

  const game = gameResult.rows[0];
  if (!game) return;

  const leaguesResult = await pool.query(
    `
    SELECT DISTINCT
      l.id,
      l.name,
      l.prize_1,
      l.prize_2,
      l.prize_3,
      l.prize_4,
      l.prize_5
    FROM leagues l
    JOIN league_members lm ON lm.league_id = l.id
    JOIN bets b ON b.user_id = lm.user_id
    WHERE b.game_id = $1
    `,
    [game.id]
  );

  const beforeRankings = {};

  for (const league of leaguesResult.rows) {
    beforeRankings[league.id] = await getLeagueRanking(league.id);
  }

  const betsResult = await pool.query(
    `
    SELECT id, user_id, home_guess, away_guess, credits_used
    FROM bets
    WHERE game_id = $1
    `,
    [game.id]
  );

  for (const b of betsResult.rows) {
    const base = calcPoints(
      b.home_guess,
      b.away_guess,
      homeScore,
      awayScore,
      game.stage
    );

    const pts = base * b.credits_used;

    await pool.query(
      `UPDATE bets SET points_won = $1 WHERE id = $2`,
      [pts, b.id]
    );
  }

  for (const league of leaguesResult.rows) {
    const before = beforeRankings[league.id];
    const after = await getLeagueRanking(league.id);
    const prizeZoneSize = getPrizeZoneSize(league);

    for (const userId of Object.keys(after)) {
      const oldData = before[userId];
      const newData = after[userId];

      if (!oldData || !newData) continue;

      const oldRank = oldData.rank;
      const newRank = newData.rank;
      const movement = oldRank - newRank;

      if (movement === 0) continue;

      const enteredPrizeZone =
        prizeZoneSize > 0 &&
        oldRank > prizeZoneSize &&
        newRank <= prizeZoneSize;

      const leftPrizeZone =
        prizeZoneSize > 0 &&
        oldRank <= prizeZoneSize &&
        newRank > prizeZoneSize;

      const bigJump = movement >= 5;
      const reachedFirst = oldRank !== 1 && newRank === 1;

      if (!bigJump && !enteredPrizeZone && !leftPrizeZone && !reachedFirst) {
        continue;
      }

      let message = '';

      if (reachedFirst) {
        message = `👑 ${newData.username} took over 1st place`;
      } else if (enteredPrizeZone) {
        message = `🎯 ${newData.username} climbed from #${oldRank} to #${newRank} and entered the prize zone`;
      } else if (leftPrizeZone) {
        message = `💔 ${newData.username} dropped from #${oldRank} to #${newRank} and left the prize zone`;
      } else {
        message = `🔥 ${newData.username} climbed from #${oldRank} to #${newRank}`;
      }

      try {
        await pool.query(
          `
          INSERT INTO rank_movement_announcements
          (game_id, league_id, user_id, old_rank, new_rank)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [game.id, league.id, Number(userId), oldRank, newRank]
        );

        await pool.query(
          `
          INSERT INTO league_messages (league_id, user_id, message)
          VALUES ($1, $2, $3)
          `,
          [league.id, Number(userId), message]
        );
      } catch (err) {
        if (err.code !== '23505') {
          console.error(err);
        }
      }
    }
  }
}

async function syncGamesFromApi() {
  const matches = await fetchWorldCupMatches();
  console.log('matches returned:', matches.length);

  for (const item of matches) {
    const fixture = item.fixture;
    const teams = item.teams;

    console.log(
  teams.home?.name,
  teams.away?.name,
  fixture.status?.short,
  fixture.status?.elapsed,
  item.goals?.home,
  item.goals?.away
);
    const goals = item.goals;
    const league = item.league;

    if (!fixture || !teams) continue;

    const externalId = String(fixture.id);
    const israelDate = apiDateToIsraelParts(fixture.date);

    const homeTeam = teams.home?.name || 'TBD';
    const awayTeam = teams.away?.name || 'TBD';
    const homeLogo = teams.home?.logo || null;
    const awayLogo = teams.away?.logo || null;

const apiStatus = fixture.status?.short || 'NS';
const liveMinute = fixture.status?.elapsed ?? null;

    const liveStatuses = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT'];
    const finishedStatuses = ['FT', 'AET', 'PEN'];

    const status = finishedStatuses.includes(apiStatus)
      ? 'finished'
      : liveStatuses.includes(apiStatus)
        ? 'live'
        : 'future';

    const homeScore = goals?.home !== null && goals?.home !== undefined ? Number(goals.home) : null;
    const awayScore = goals?.away !== null && goals?.away !== undefined ? Number(goals.away) : null;
    const stage = league?.round || 'GROUP';

await pool.query(
  `
  INSERT INTO games (
    external_id,
    home_team,
    away_team,
    game_date,
    game_time,
    home_score,
    away_score,
    status,
    competition_id,
    stage,
    home_logo,
    away_logo,
    live_status,
    live_minute,
    last_api_update
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
  ON CONFLICT (external_id) DO UPDATE SET
    home_team = EXCLUDED.home_team,
    away_team = EXCLUDED.away_team,
    game_date = EXCLUDED.game_date,
    game_time = EXCLUDED.game_time,
    home_score = EXCLUDED.home_score,
    away_score = EXCLUDED.away_score,
    status = EXCLUDED.status,
    competition_id = EXCLUDED.competition_id,
    stage = EXCLUDED.stage,
    home_logo = EXCLUDED.home_logo,
    away_logo = EXCLUDED.away_logo,
    live_status = EXCLUDED.live_status,
    live_minute = EXCLUDED.live_minute,
    last_api_update = CURRENT_TIMESTAMP
  `,
  [
    externalId,
    homeTeam,
    awayTeam,
    israelDate.date,
    israelDate.time,
    homeScore,
    awayScore,
    status,
    1,
    stage,
    homeLogo,
    awayLogo,
    apiStatus,
    liveMinute
  ]
);

    if (status === 'finished' && homeScore !== null && awayScore !== null) {
      await recalculatePointsForGameByExternalId(externalId, homeScore, awayScore);
    }
  }
}

async function runAutoSync() {
  try {
    console.log('AUTO SYNC STARTED');
    await syncGamesFromApi();
    console.log('AUTO SYNC FINISHED');
  } catch (err) {
    console.error('AUTO SYNC ERROR:', err.message);
  }
}

// =========================
// AUTH
// =========================

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.post('/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (username.includes('@')) {
  return res.send(`
    <script>
      alert("Please choose a username, not an email address");
      window.location.href = "/register";
    </script>
  `);
}
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.send(`
      <script>
        alert("Username and password are required");
        window.location.href = "/register";
      </script>
    `);
  }

  if (!isStrongPassword(password)) {
    return res.send(`
      <script>
        alert("Password must be at least 8 characters and include uppercase, lowercase, and a number");
        window.location.href = "/register";
      </script>
    `);
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, password, is_admin, credits_left, knockout_bonus_given)
       VALUES ($1, $2, 0, 100, 0)
       RETURNING id, username, is_admin`,
      [username, hash]
    );

    const user = result.rows[0];

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    res.redirect('/');
  } catch (err) {
    if (err.code === '23505') {
      return res.send(`
        <script>
          alert("Username already exists");
          window.location.href = "/register";
        </script>
      `);
    }

    console.error(err);
    res.send('Error creating user');
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');



  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
    if (err) return res.send('Database error');

    if (!row) {
      return res.send(`
        <script>
          alert("Wrong username or password");
          window.location.href = "/login";
        </script>
      `);
    }

    const ok = await bcrypt.compare(password, row.password);

    if (!ok) {
      return res.send(`
        <script>
          alert("Wrong username or password");
          window.location.href = "/login";
        </script>
      `);
    }

    await pool.query(
      `UPDATE users
       SET last_login_at = CURRENT_TIMESTAMP,
           last_seen_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [row.id]
    );

req.session.userId = row.id;
req.session.username = row.username;
req.session.isAdmin = row.is_admin;

if (req.session.pendingJoinCode) {
  const code = req.session.pendingJoinCode;
  req.session.pendingJoinCode = null;
  return res.redirect('/join/' + code);
}

const returnTo = req.session.returnTo || '/';
req.session.returnTo = null;

return res.redirect(returnTo);
   
  });
});

app.get('/change-password', requireLogin, (req, res) => {
  if (Number(req.session.isAdmin) === 1) {
    return db.all(`SELECT id, username FROM users ORDER BY username ASC`, [], (err, users) => {
      if (err) return res.send('Error loading users');

      const options = users.map(u => `
        <option value="${u.id}" ${u.id === req.session.userId ? 'selected' : ''}>
          ${u.username}
        </option>
      `).join('');

      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947"> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">

          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="icon" href="/favicon.ico?v=31">
          <title>Change Password</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>
        <body> ${renderSideNav(req)}
          <div class="page-wrap">
            <div class="form-card">
              <h1>Change Password</h1>

              <form method="POST" action="/change-password">
                <select name="target_user_id" required>
                  ${options}
                </select><br><br>

                <input type="password" name="new_password" placeholder="New password" required><br><br>
                <input type="password" name="confirm_password" placeholder="Confirm new password" required><br><br>

                <button type="submit">Update Password</button>
              </form>

              <br>
              <a href="/">Back Home</a>
            </div>
          </div>
        <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
        </html>
      `);
    });
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/favicon.ico?v=31">
      <title>Change Password</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>
    <body> ${renderSideNav(req)}
      <div class="page-wrap">
        <div class="form-card">
          <h1>Change Password</h1>

          <form method="POST" action="/change-password">
            <input type="password" name="current_password" placeholder="Current password" required><br><br>
            <input type="password" name="new_password" placeholder="New password" required><br><br>
            <input type="password" name="confirm_password" placeholder="Confirm new password" required><br><br>

            <button type="submit">Update Password</button>
          </form>

          <br>
          <a href="/">Back Home</a>
        </div>
      </div>
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});

app.post('/change-password', requireLogin, async (req, res) => {
  const isAdminUser = Number(req.session.isAdmin) === 1;

  const targetUserId = isAdminUser
    ? Number(req.body.target_user_id)
    : Number(req.session.userId);

  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.send('Invalid user');
  }

  if (!newPassword || !confirmPassword) {
    return res.send('All fields are required');
  }

  if (newPassword !== confirmPassword) {
    return res.send(`
      <script>
        alert("New passwords do not match");
        window.history.back();
      </script>
    `);
  }

  if (!isStrongPassword(newPassword)) {
    return res.send(`
      <script>
        alert("Password must be at least 8 characters and include uppercase, lowercase, and a number");
        window.history.back();
      </script>
    `);
  }

  try {
    if (!isAdminUser) {
      const result = await pool.query(
        `SELECT password FROM users WHERE id = $1`,
        [req.session.userId]
      );

      const user = result.rows[0];
      if (!user) return res.send('User not found');

      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) {
        return res.send(`
          <script>
            alert("Current password is wrong");
            window.history.back();
          </script>
        `);
      }
    }
const newHash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE users SET password = $1 WHERE id = $2`,
      [newHash, targetUserId]
    );

    res.send(`
      <script>
        alert("Password updated successfully");
        window.location.href = "/";
      </script>
    `);
  } catch (err) {
    console.error(err);
    res.send('Error updating password');
  }
});

app.get('/forgot-password', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/favicon.ico?v=31">
      <title>Forgot Password</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>

    <body> ${renderSideNav(req)}
      <div class="center-page">
        <div class="form-card">

          <h1>Forgot Password</h1>

          <p class="description">
            If you forgot your password, contact the site admin and include your username.
          </p>

          <div style="margin-top:20px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
  <a
    class="auth-btn"
    href="https://wa.me/972547588597?text=Hi%2C%20I%20forgot%20my%20password.%20My%20username%20is%3A">
    Contact via whatsapp
  </a>

  <a
    class="auth-btn secondary"
    href="https://wa.me/972547588597?text=%D7%94%D7%99%D7%99%2C%20%D7%A9%D7%9B%D7%97%D7%AA%D7%99%20%D7%90%D7%AA%20%D7%94%D7%A1%D7%99%D7%A1%D7%9E%D7%94.%20%D7%A9%D7%9D%20%D7%94%D7%9E%D7%A9%D7%AA%D7%9E%D7%A9%20%D7%A9%D7%9C%D7%99%20%D7%94%D7%95%D7%90%3A">
    יצירת קשר בווטסאפ
  </a>
</div>
          </div>

          <div style="margin-top:12px;">
            <a href="/login">Back to login</a>
          </div>

        </div>
      </div>
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) res.send('Logout error');
    else res.redirect('/');
  });
});

app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email']
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login'
  }),
  (req, res) => {
    req.session.userId = req.user.id;
    req.session.username = req.user.username;
    req.session.isAdmin = req.user.is_admin;

    res.redirect('/');
  }
);

// =========================
// STATIC / CONTENT PAGES
// =========================

app.get('/help', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">
     <title>How to Play</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>
    <body> ${renderSideNav(req)}
      <div class="page-wrap help-page">
        <div class="section-title help-title">How to Play</div>
        <div class="section-subtitle help-subtitle">Everything you need to know about the World Cup Challenge</div>

        <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

        <div class="help-card"><h3 class="help-card-title">What is World Cup Challenge?</h3><p class="help-text">World Cup Challenge is a prediction game for the FIFA World Cup. Predict match scores, spend your credits wisely, and compete for the top spot in the global leaderboard or inside your private leagues.</p></div>
        <div class="help-card"><h3 class="help-card-title">Credits System</h3><p class="help-text">Each player starts the tournament with <b>100 credits</b>.</p><p class="help-text">When the knockout stage begins, every player receives an additional <b>+50 credits</b>.</p><p class="help-text">Credits are limited, so every decision matters.</p></div>
        <div class="help-card"><h3 class="help-card-title">How to Bet</h3><p class="help-text">For each match, you choose the final score you predict and how many credits you want to place on that prediction.</p></div>
        <div class="help-card"><h3 class="help-card-title">Points System</h3><p class="help-text"><b>Exact score:</b> 3 points</p><p class="help-text"><b>Correct winner or draw:</b> 1 point</p><p class="help-text"><b>Wrong prediction:</b> 0 points</p></div>
        <div class="help-card"><h3 class="help-card-title">Tie-Breaker</h3><p class="help-text">If two players finish with the same number of points, the higher rank goes to the player who used fewer total credits.</p></div>
        <div class="help-card"><h3 class="help-card-title">Private Leagues</h3><p class="help-text">You can create or join private leagues and compete against specific groups.</p></div>
      </div>
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});

app.get('/install-app', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/favicon.ico?v=31">
      <link rel="stylesheet" href="/css/style.css">
      <title>Predict WorldCup</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
    </head>

    <body> ${renderSideNav(req)}
    
      <div class="page-wrap">
        <div class="form-card">
          <h1>Install Predict WorldCup</h1>

          <p>
            You can install Predict WorldCup on your phone like a real app.
          </p>

          <br>

          <h2>📱 iPhone (Safari)</h2>

          <ol style="text-align:left; max-width:500px; margin:auto;">
            <li>Open this website in Safari</li>
            <li>Tap the Share button</li>
            <li>Select <b>Add to Home Screen</b></li>
            <li>Tap Add</li>
          </ol>

          <br><br>

          <h2>🤖 Android (Chrome)</h2>

          <ol style="text-align:left; max-width:500px; margin:auto;">
            <li>Open this website in Chrome</li>
            <li>Tap the 3 dots menu</li>
            <li>Select <b>Install App</b></li>
          </ol>

          <br><br>

          <a href="/" class="auth-btn secondary">
            Back Home
          </a>
        </div>
      </div>
      <script>
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (isStandalone && window.location.pathname === '/install-app') {
    window.location.href = '/';
  }
</script>
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});


// =========================
// HOME
// =========================

app.get('/', (req, res) => {
  db.get(
    `
    SELECT *
    FROM games
    WHERE status IN ('future', 'live')
    ORDER BY game_date ASC, game_time ASC
    LIMIT 1
    `,
    [],
    (err, nextGame) => {
      if (err) {
        console.error(err);
        nextGame = null;
      }

      let greeting;
      let menu = '';

      if (req.session.username) {
        const user = `<a href="/profile/${req.session.userId}">${req.session.username}</a>`;
        greeting = `Welcome ${user}`;

        menu = `
          <div class="auth-links">
            <a href="/leagues" class="auth-btn secondary">Private Leagues</a>
            <a href="/profile/${req.session.userId}" class="auth-btn secondary">My Profile</a>
            <a href="/my-bets" class="auth-btn secondary">My Bets</a>
            <a href="/change-password" class="auth-btn secondary">Change Password</a>
            ${req.session.isAdmin === 1 ? `<a href="/admin" class="auth-btn secondary">Admin</a>` : ''}
            <a href="/logout" class="auth-btn danger">Logout</a>
          </div>
        `;
      } else {
        greeting = 'Welcome guest, please register or login';
        menu = `
          <div class="auth-links">
            <a href="/register" class="auth-btn register">Register</a>
            <a href="/login" class="auth-btn login">Login</a>
          </div>
        `;
      }

const isLive = nextGame && nextGame.status === 'live';

const nextMatchHtml = nextGame
  ? `
    <div class="next-match-card ${isLive ? 'next-match-live-card' : ''}">
      <div class="next-match-title">
        ${isLive ? '🔴 LIVE NOW' : 'Next Match'}
      </div>

      <div class="next-match-teams">
        <span class="team">
          ${nextGame.home_logo ? `<img src="${nextGame.home_logo}" class="team-logo">` : ''}
          ${nextGame.home_team}
        </span>

        <span class="vs">
          ${isLive
            ? `${nextGame.home_score ?? 0} - ${nextGame.away_score ?? 0}`
            : 'vs'}
        </span>

        <span class="team">
          ${nextGame.away_logo ? `<img src="${nextGame.away_logo}" class="team-logo">` : ''}
          ${nextGame.away_team}
        </span>
      </div>

      <div class="next-match-time">
        ${isLive
          ? `Minute: ${nextGame.live_minute ?? '-'}'`
          : `${nextGame.game_date} • ${nextGame.game_time}`}
      </div>

      ${isLive
        ? `
          <div class="next-match-live-status">
            Current score: ${nextGame.home_score ?? 0} - ${nextGame.away_score ?? 0}
          </div>
        `
        : `
          <div
            class="next-match-countdown"
            data-date="${nextGame.game_date}"
            data-time="${nextGame.game_time}">
          </div>
        `}
    </div>
  `
  : '';

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head> <link rel="manifest" href="/manifest.json">
        <link rel="apple-touch-icon" href="/favicon-v3.PNG">
<meta name="theme-color" content="#e5b947">
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="icon" href="/favicon.ico?v=31">
          <link rel="stylesheet" href="/css/style.css">
          <title>Predict Worldcup</title>
        </head>

        <body> ${renderSideNav(req)}
        <div class="install-banner">
  📱 Install Predict WorldCup on your phone
  <a href="/install-app">Learn how</a>
</div>
          <div id="helpOverlay" class="help-overlay">
            <div class="help-popup">
              <button class="help-close" onclick="closeHelpOverlay()">×</button>

              <h2>How to Play</h2>
              <p>Predict World Cup match scores and earn points.</p>

              <p><b>Exact score:</b> 3 points</p>
              <p><b>Correct winner / draw:</b> 1 point</p>
              <p><b>Wrong prediction:</b> 0 points</p>

              <p>You start with 100 credits. Use them wisely.</p>

              <a href="/help" class="auth-btn secondary">Full Rules</a>
            </div>
          </div>

          <div class="center-page">
            <div class="home-box">
              <h1>Predict WorldCup</h1>
              <p class="description">Join private leagues, predict World Cup matches, and spend your credits wisely.</p>

              ${nextMatchHtml}

              <div class="buttons">
                <a href="/help"><button>How to Play</button></a>
                <a href="/games"><button>Games</button></a>
                <a href="/leaderboard"><button>Leaderboard</button></a>
              </div>

              <div class="home-user-area">
                <h3>${greeting}</h3>
                ${menu}
              </div>
            </div>
          </div>

          <script>
  function closeHelpOverlay() {
    document.getElementById('helpOverlay').style.display = 'none';
    localStorage.setItem('seenHelpOverlay', 'true');
  }

  if (localStorage.getItem('seenHelpOverlay') === 'true') {
    document.getElementById('helpOverlay').style.display = 'none';
  }

  function updateNextMatchCountdown() {
    const el = document.querySelector('.next-match-countdown');

    if (!el) return;

    const date = el.dataset.date;
    const time = el.dataset.time;

    const target = new Date(date + 'T' + time + ':00Z');

    const diff = target - new Date();

    if (diff <= 0) {
      el.textContent = 'Betting closed / Match started';
      return;
    }

    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);
    const seconds = Math.floor((diff / 1000) % 60);

    el.textContent =
      'Starts in ' +
    
      String(hours).padStart(2, '0') + 'h ' +
      String(minutes).padStart(2, '0') + 'm ' +
      String(seconds).padStart(2, '0') + 's';
  }

  updateNextMatchCountdown();

  setInterval(updateNextMatchCountdown, 1000);
</script>
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js');
  }
</script>
        <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script>

<div id="welcomeNotice" class="side-notice">
  <button class="side-notice-close" onclick="closeNotice()">✕</button>

  <h3>📢 Tournament Reminder</h3>

  <p>Read the rules before placing predictions.</p>

  <p>
    <b>+50 bonus credits</b> will be awarded to all users when the knockout stage begins.
  </p>

  <a href="/help" class="mini-action-btn">
    Read Rules
  </a>
</div>
<div id="round32Notice" class="side-notice">
<button class="side-notice-close" onclick="closeRound32Notice()">✕</button>
  <h3>🎁 בונוס מיוחד!</h3>

  <p>
    משחקי <b>שלב 32 האחרונות</b> נוספו למערכת.
  </p>

  <p>
    כדי שכל המשתתפים יתחילו את שלב הנוקאאוט בצורה הוגנת,
    <b>כל המשתמשים קיבלו 25 קרדיטים נוספים.</b>
  </p>

  <p>
    מאחלים לכולם בהצלחה בהמשך הטורניר! ⚽🏆
  </p>

  <a href="/games" class="mini-action-btn">
    לצפייה במשחקים
  </a>

</div>

<script>
function closeRound32Notice() {
  document.getElementById('round32Notice')?.remove();
  localStorage.setItem('round32Bonus2026Closed', 'true');
}

window.addEventListener('load', () => {
  if (localStorage.getItem('round32Bonus2026Closed')) {
    document.getElementById('round32Notice')?.remove();
  }
});
</script>
<script>
function closeNotice() {
  document.getElementById('welcomeNotice').remove();
  localStorage.setItem('welcomeNoticeClosed', 'true');
}

window.addEventListener('load', () => {
  if (localStorage.getItem('welcomeNoticeClosed')) {
    document.getElementById('welcomeNotice')?.remove();
  }
});
</script>


</body>
        </html>
      `);
    }
  );
});

// =========================
// LEADERBOARD
// =========================

app.get('/leaderboard', (req, res) => {
 const sql = `
  SELECT
    u.id,
    u.username,
    u.credits_left,
    COALESCE(SUM(b.points_won), 0) AS total_points,
    COALESCE(SUM(
      CASE 
        WHEN b.home_guess = g.home_score 
         AND b.away_guess = g.away_score 
        THEN 1 ELSE 0 
      END
    ), 0) AS exact_hits,
    COALESCE(SUM(b.credits_used), 0) AS total_credits_used
  FROM users u
  LEFT JOIN bets b ON b.user_id = u.id
  LEFT JOIN games g ON g.id = b.game_id
  GROUP BY u.id, u.username, u.credits_left
  ORDER BY
    total_points DESC,
    exact_hits DESC,
    total_credits_used ASC,
    u.username ASC
`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.send('Error loading leaderboard');
    const top3 = rows.slice(0, 3);
    const rest = rows.slice(3);
    const podiumHtml = `
  <div class="podium-wrap">

    ${top3[1] ? `
      <div class="podium-card silver">
        <div class="podium-place">🥈</div>
        <div class="podium-name">${top3[1].username}</div>
        <div class="podium-points">${top3[1].total_points} pts</div>
        <div class="podium-credits">
  ${top3[0].credits_left} credits
</div>
      </div>
    ` : ''}

    ${top3[0] ? `
      <div class="podium-card gold">
        <div class="podium-place">🥇</div>
        <div class="podium-name">${top3[0].username}</div>
        <div class="podium-points">${top3[0].total_points} pts</div>
        <div class="podium-credits">
  ${top3[0].credits_left} credits
</div>
      </div>
    ` : ''}

    ${top3[2] ? `
      <div class="podium-card bronze">
        <div class="podium-place">🥉</div>
        <div class="podium-name">${top3[2].username}</div>
        <div class="podium-points">${top3[2].total_points} pts</div>
        <div class="podium-credits">
  ${top3[0].credits_left} credits
</div>
      </div>
    ` : ''}

  </div>
`;
    const tableRows = rest.map((r, index) => {
      const isMe = req.session.userId === r.id;
      return `
        <tr class="${isMe ? 'highlight-me' : ''}">
          <td class="rank-cell">${index + 4}</td>
          <td><a href="/profile/${r.id}">${r.username}</a>${isMe ? ' (me)' : ''}</td>
          <td class="points-cell">${r.total_points}</td>
          <td>${r.credits_left ?? 0}</td>
        </tr>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">       <title>Leaderboard</title>
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body> ${renderSideNav(req)}
        <div class="page-wrap">
          <div class="section-title">Leaderboard</div>
          <div class="section-subtitle">Global ranking of all players</div>
         <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>
          <div class="table-card">
            <table>
              <tr><th>Rank</th><th>Username</th><th>Points</th><th>Credits Left</th></tr>
              ${podiumHtml}
              ${tableRows}
            </table>
          </div>
        </div>
      <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});

// =========================
// PROFILE
// =========================

app.get('/profile/:id', (req, res) => {
  const profileUserId = Number(req.params.id);

  if (!Number.isInteger(profileUserId) || profileUserId <= 0) {
    return res.send('Invalid user id');
  }

  db.get(
    `
    SELECT
      u.id,
      u.username,
      u.credits_left,
      COALESCE(SUM(b.points_won), 0) AS total_points,
      COUNT(b.id) AS total_bets,

      COALESCE(SUM(CASE
        WHEN gm.status = 'finished'
         AND b.home_guess = gm.home_score
         AND b.away_guess = gm.away_score
        THEN 1 ELSE 0
      END), 0) AS exact_bets,

      COALESCE(SUM(CASE
        WHEN gm.status = 'finished'
         AND (
           (b.home_guess - b.away_guess > 0 AND gm.home_score - gm.away_score > 0)
           OR
           (b.home_guess - b.away_guess < 0 AND gm.home_score - gm.away_score < 0)
           OR
           (b.home_guess - b.away_guess = 0 AND gm.home_score - gm.away_score = 0)
         )
        THEN 1 ELSE 0
      END), 0) AS direction_bets,

      COALESCE(SUM(CASE
        WHEN gm.status = 'finished'
        THEN 1 ELSE 0
      END), 0) AS finished_bets

    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    LEFT JOIN games gm ON gm.id = b.game_id
    WHERE u.id = ?
    GROUP BY u.id, u.username, u.credits_left
    `,
    [profileUserId],
    (err, userStats) => {
      if (err) return res.send('Error loading profile');
      if (!userStats) return res.send('User not found');

      db.get(
        `
        SELECT
          gm.home_team,
          gm.away_team,
          gm.home_score,
          gm.away_score,
          gm.stage,
          b.home_guess,
          b.away_guess,
          b.credits_used,
          b.points_won
        FROM bets b
        JOIN games gm ON gm.id = b.game_id
        WHERE b.user_id = ?
        ORDER BY b.points_won DESC, gm.game_date DESC, gm.game_time DESC
        LIMIT 1
        `,
        [profileUserId],
        (err2, bestBet) => {
          if (err2) return res.send('Error loading best bet');

          const exactBets = Number(userStats.exact_bets || 0);
          const directionBets = Number(userStats.direction_bets || 0);
          const totalBets = Number(userStats.total_bets || 0);
          const finishedBets = Number(userStats.finished_bets || 0);

          const exactRate = finishedBets > 0
            ? ((exactBets / finishedBets) * 100).toFixed(1)
            : '0.0';

          const directionRate = finishedBets > 0
            ? ((directionBets / finishedBets) * 100).toFixed(1)
            : '0.0';

          res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link rel="icon" href="/favicon.ico?v=31">
              <title>User Profile</title>
              <link rel="stylesheet" href="/css/style.css">
            </head>
            <body> ${renderSideNav(req)}
              <div class="profile-page">
                <div class="profile-card">
                  <div class="profile-title">${userStats.username}</div>
                  <div class="profile-subtitle">Player profile and tournament stats</div>

                  <div class="profile-stats">
                    <div class="stat-box">
                      <div class="stat-label">Total Points</div>
                      <div class="stat-value">${userStats.total_points}</div>
                    </div>

                    <div class="stat-box">
                      <div class="stat-label">Credits Left</div>
                      <div class="stat-value">${userStats.credits_left ?? 0}</div>
                    </div>

                    <div class="stat-box">
                      <div class="stat-label">Total Bets</div>
                      <div class="stat-value">${totalBets}</div>
                    </div>

                    <div class="stat-box">
                      <div class="stat-label">Finished Bets</div>
                      <div class="stat-value">${finishedBets}</div>
                    </div>

                    <div class="stat-box">
                      <div class="stat-label">Exact Hit Rate</div>
                      <div class="stat-value">${exactRate}%</div>
                    </div>

                    <div class="stat-box">
                      <div class="stat-label">Direction Rate</div>
                      <div class="stat-value">${directionRate}%</div>
                    </div>
                  </div>

                  <div class="profile-section">
                    <h3>Best Bet</h3>
                    ${
                      bestBet
                        ? `
                          <div class="best-guess-row"><b>Match:</b> ${bestBet.home_team} vs ${bestBet.away_team}</div>
                          <div class="best-guess-row"><b>Your Guess:</b> ${bestBet.home_guess} : ${bestBet.away_guess}</div>
                          <div class="best-guess-row"><b>Final Score:</b> ${bestBet.home_score ?? '-'} : ${bestBet.away_score ?? '-'}</div>
                          <div class="best-guess-row"><b>Stage:</b> ${formatStage(bestBet.stage)}</div>
                          <div class="best-guess-row"><b>Credits Used:</b> ${bestBet.credits_used}</div>
                          <div class="best-guess-row"><b>Points Earned:</b> ${bestBet.points_won ?? 0}</div>
                        `
                        : `<div class="best-guess-row">No bets yet</div>`
                    }
                  </div>

                </div>
              </div>
            <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
            </html>
          `);
        }
      );
    }
  );
});

// =========================
// GAMES
// =========================

app.get('/games', (req, res) => {
  const isLoggedIn = !!req.session.username;
  const userId = req.session.userId || null;
  const activeLeagueId = req.session.activeLeagueId || null;

  db.get(`SELECT credits_left FROM users WHERE id = ?`, [userId], (creditsErr, userRow) => {
    const creditsLeft = userRow?.credits_left ?? 0;

    const sql = isLoggedIn
      ? `
        SELECT
          g.*,
          c.name AS competition_name,
          b.home_guess AS my_home_guess,
          b.away_guess AS my_away_guess,
          b.points_won AS my_points,
          b.credits_used AS my_credits_used,
          CASE WHEN pm.game_id IS NULL THEN 0 ELSE 1 END AS is_pinned
        

        FROM games g
        LEFT JOIN competitions c ON c.id = g.competition_id
        LEFT JOIN bets b ON b.game_id = g.id AND b.user_id = ?
        LEFT JOIN pinned_matches pm
  ON pm.game_id = g.id AND pm.user_id = ?
        WHERE g.status IN ('future','live','finished')
ORDER BY is_pinned DESC, g.game_date ASC, g.game_time ASC
      `
      : `
        SELECT g.*, c.name AS competition_name
        FROM games g
        LEFT JOIN competitions c ON c.id = g.competition_id
        WHERE g.status IN ('future','live','finished')
        ORDER BY g.game_date ASC, g.game_time ASC
      `;

const params = isLoggedIn ? [userId, userId] : [];
    db.all(sql, params, (err, games) => {
      if (err) {
        console.error(err);
        return res.send('Error loading games');
      }



      const now = getIsraelNowParts();
      const todayStr = now.date;
      const nowTime = now.time;
      let todayMarked = false;
      let fallbackMarked = false;
      let gamesHtml = '';

      let relevantGameMarked = false;

      games.forEach(game => {
        let block = '';
        let gameAnchor = '';

        if (!todayMarked && game.game_date === todayStr) {
          gameAnchor = 'id="today-game"';
          todayMarked = true;
        } else if (!todayMarked && !fallbackMarked) {
          if (game.game_date > todayStr || (game.game_date === todayStr && game.game_time > nowTime)) {
            gameAnchor = 'id="today-game"';
            fallbackMarked = true;
          }
        }

        if (!isLoggedIn) {
          block = game.status === 'finished'
            ? `<div class="result-panel"><div class="result-panel-title">Final Result</div><div class="result-score">${game.home_score} : ${game.away_score}</div><div class="result-subline">Register or login to see bets and points</div></div>`
            : `<div class="guess-panel"><div class="guess-panel-title">Make your prediction</div><div class="guess-form-row"><input class="guess-score-input" type="number" placeholder="?" disabled><div class="guess-colon">:</div><input class="guess-score-input" type="number" placeholder="?" disabled></div><div class="guess-help">Register or login to bet on this match</div></div>`;
        } else {
          const alreadyBet = game.my_home_guess !== null && game.my_home_guess !== undefined;
          const openForBetting = game.status === 'future' && canGuess(game.game_date, game.game_time);

          if (game.status === 'finished') {
            block = `<div class="result-panel"><div class="result-panel-title">Final Result</div><div class="result-score">${game.home_score} : ${game.away_score}</div><div class="result-subline"><b>My Guess:</b> ${alreadyBet ? `${game.my_home_guess} : ${game.my_away_guess}` : 'Not bet'}</div><div class="result-subline"><b>Credits Used:</b> ${game.my_credits_used ?? 0}</div><div class="result-subline"><b>Points Earned:</b> ${game.my_points ?? 0}</div></div>`;
          } else if (!openForBetting) {
            block = alreadyBet
              ? `<div class="result-panel"><div class="result-panel-title">Betting Closed</div><div class="result-score">${game.my_home_guess} : ${game.my_away_guess}</div><div class="result-subline"><b>Credits Used:</b> ${game.my_credits_used ?? 0}</div><div class="result-subline">Your bet was saved before kickoff</div></div>`
              : `<div class="result-panel"><div class="result-panel-title">Betting Closed</div><div class="result-subline">The match already started</div></div>`;
          } else {
            block = `
              <div class="guess-panel">
                <div class="guess-panel-title">${alreadyBet ? 'Update your bet' : 'Make your bet'}</div>
                <form action="/bet" method="POST">
                  <input type="hidden" name="game_id" value="${game.id}">
                  <div class="guess-form-row">
                    <input class="guess-score-input" type="number" name="home_guess" min="0" required value="${alreadyBet ? game.my_home_guess : ''}">
                    <div class="guess-colon">:</div>
                    <input class="guess-score-input" type="number" name="away_guess" min="0" required value="${alreadyBet ? game.my_away_guess : ''}">
                  </div>
                  <div style="margin-top: 12px;"><label><b>Credits to bet:</b></label><input type="number" name="credits_used" min="1" required value="${alreadyBet ? (game.my_credits_used ?? 1) : 1}" style="width:80px;"></div>
                  <button class="guess-action-btn" type="submit">${alreadyBet ? 'Update Bet' : 'Submit Bet'}</button>
                </form>
                <div class="guess-help">Credits left: ${creditsLeft}</div>
              </div>
            `;
          }
        }

        const liveBlock = game.status === 'live' ? `
  <div class="live-match-pill">
    LIVE ${game.live_minute ? `• ${game.live_minute}'` : ''}
    | ${game.home_score ?? 0} - ${game.away_score ?? 0}
  </div>
` : '';

const scoreBlock = game.status === 'live' ? `
  <div class="prediction-vs-result">
    <div><b>Current result:</b> ${game.home_score ?? 0} - ${game.away_score ?? 0}</div>
  </div>
` : '';

const isRelevantGame =
  !relevantGameMarked &&
  (game.status === 'live' || game.status === 'future');

const relevantId = isRelevantGame
  ? 'relevant-game'
  : '';

if (isRelevantGame) {
  relevantGameMarked = true;
}
        gamesHtml += `
                   <div
                  class="game-card"
                  id="${relevantId || `game-${game.id}`}"
                  ${gameAnchor}
                  data-search="${game.home_team} ${game.away_team} ${formatStage(game.stage)} ${game.game_date}"
                >
            <h3 class="teams-row">
              <span class="team">
                ${game.home_logo ? `<img src="${game.home_logo}" alt="${game.home_team}" class="team-logo">` : ''}
                <a href="/nation/${encodeURIComponent(game.home_team)}">${game.home_team}</a>
              </span>

              <span class="vs">vs</span>

              <span class="team">
                ${game.away_logo ? `<img src="${game.away_logo}" alt="${game.away_team}" class="team-logo">` : ''}
                <a href="/nation/${encodeURIComponent(game.away_team)}">${game.away_team}</a>
              </span>
            </h3>

            <p><b>Stage:</b> ${formatStage(game.stage)}</p>
            <p>${game.game_date} | ${game.game_time}</p>
${liveBlock}
${scoreBlock}
<div class="game-card-actions">

  <a href="/game/${game.id}" class="mini-action-btn">
    Match
  </a>

  ${isLoggedIn ? `
    <form
      method="POST"
      action="${Number(game.is_pinned) === 1 ? '/unpin-match' : '/pin-match'}"
    >
      <input type="hidden" name="game_id" value="${game.id}">

      <button type="submit" class="mini-action-btn">
        ${Number(game.is_pinned) === 1 ? '★' : '☆'}
      </button>
    </form>
  ` : ''}

</div>

            ${block}
          </div>
        `;
      });

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">      <title>Game list</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>
        <body> ${renderSideNav(req)}
          <div class="page-wrap">
            <h1>All Games</h1>
            ${isLoggedIn ? `<h3 class="muted">Connected as <a href="/profile/${req.session.userId}">${req.session.username}</a> | Credits left: ${creditsLeft}</h3>` : `<h3 class="muted">User not logged in</h3>`}
            
            <div class="games-search-box">
  <input
    id="gamesSearch"
    type="text"
    placeholder="Search team or stage..."
    oninput="filterGames()"
  >
  <div id="searchEasterEgg"></div>
</div>
            ${gamesHtml || '<p>No games to display</p>'}
            <script>
              const el = document.getElementById('today-game');
              if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
            </script>
          </div>


  <script>
  const easterEggs = [
    { keys: ['messi', 'מסי'], emoji: '🐐' },
    { keys: ['ronaldo', 'cr7', 'cristiano', 'רונאלדו'], emoji: '🐫' },
    { keys: ['mbappe', 'אמבפה'], emoji: '🐢' },
    { keys: ['neymar', 'ניימאר'], emoji: '🎭' },
    { keys: ['haaland', 'האלנד'], emoji: '🤖' },
    { keys: ['modric', 'מודריץ'], emoji: '🎻' },
    { keys: ['salah', 'סלאח'], emoji: '⚡' },
    { keys: ['zidane', 'זידאן'], emoji: '🧠' },
    { keys: ['maradona', 'מראדונה'], emoji: '🪄' },
    { keys: ['pele', 'פלה'], emoji: '👑' },
    { keys: ['iniesta', 'אינייסטה'], emoji: '🎨' },
    { keys: ['xavi', 'צאבי'], emoji: '🧩' },
    { keys: ['ramos', 'ראמוס'], emoji: '🟥' },
    { keys: ['suarez', 'סוארז'], emoji: '🦷' },
    { keys: ['buffon', 'בופון'], emoji: '🧤' },
    { keys: ['casillas', 'קסיאס'], emoji: '🧱' },
    { keys: ['kane', 'קיין'], emoji: '🎯' },
    { keys: ['yamal', 'ימאל'], emoji: '✨' },
    { keys: ['kroos', 'קרוס'], emoji: '🎼' },
    { keys: ['ibrahimovic', 'zlatan', 'איברהימוביץ'], emoji: '🦁' },
    { keys: ['pirlo', 'פירלו'], emoji: '🍷' },
    { keys: ['kaka', 'קאקה'], emoji: '✝️' },
    { keys: ['ronaldinho', 'רונאלדיניו'], emoji: '😄' },
    { keys: ['beckham', 'בקהאם'], emoji: '🎩' },
    { keys: ['muller', 'מולר'], emoji: '🦊' },
    { keys: ['lewandowski', 'לבנדובסקי'], emoji: '🎯' },
    { keys: ['vardy', 'ורדי'], emoji: '🍻' },
    { keys: ['griezmann', 'גריזמן'], emoji: '🎮' },
    { keys: ['pogba', 'פוגבה'], emoji: '🕺' },
    { keys: ['kante', 'קאנטה'], emoji: '🔋' },
    { keys: ['hakimi', 'חכימי'], emoji: '🏎️' },
    { keys: ['osimhen', 'אוסימן'], emoji: '🦅' },
    { keys: ['son', 'סון'], emoji: '😊' },
    { keys: ['kim min jae', 'קים מין גה'], emoji: '🧱' }
  ];

  function filterGames() {
    const input = document.getElementById('gamesSearch');
    const egg = document.getElementById('searchEasterEgg');

    if (!input) return;

    const q = input.value.toLowerCase();

    const cards = document.querySelectorAll('.game-card');

    cards.forEach(card => {
      const text = (card.dataset.search || '').toLowerCase();
      card.style.display = text.includes(q) ? '' : 'none';
    });

    let foundEgg = null;

    for (const item of easterEggs) {
      if (item.keys.some(k => q.includes(k))) {
        foundEgg = item;
        break;
      }
    }

    if (foundEgg && egg) {
  egg.textContent = foundEgg.emoji;

  egg.classList.remove('animate-search-egg');
  void egg.offsetWidth;
  egg.classList.add('animate-search-egg');
}
  }
</script>
<div class="donate-tab" id="donateTab">
  ❤️ Donate
</div>

<div id="donateBox" class="donate-box">
  <button class="close-donate-btn" onclick="closeDonateBox(event)">
    ✕
  </button>

  <div class="donate-title">
    Support WorldCup Predict
  </div>

  <div class="donate-text">
    Enjoying the project? You can support it here ❤️
  </div>

  <div class="donate-buttons">
    <a href="https://paypal.me/ZoharBenShlomo/10" target="_blank">₪10</a>
    <a href="https://paypal.me/ZoharBenShlomo/20" target="_blank">₪20</a>
    <a href="https://paypal.me/ZoharBenShlomo/30" target="_blank">₪30</a>
  </div>
</div>

<script>
  const donateTab = document.getElementById('donateTab');
  const donateBox = document.getElementById('donateBox');

  let isDraggingDonate = false;
  let didDragDonate = false;
  let startY = 0;
  let startTop = 0;

  donateTab.addEventListener('pointerdown', (e) => {
    isDraggingDonate = true;
    didDragDonate = false;
    startY = e.clientY;
    startTop = donateTab.offsetTop;
    donateTab.setPointerCapture(e.pointerId);
  });

  donateTab.addEventListener('pointermove', (e) => {
    if (!isDraggingDonate) return;

    const diff = e.clientY - startY;

    if (Math.abs(diff) > 4) {
      didDragDonate = true;
    }

    const newTop = startTop + diff;
    const maxTop = window.innerHeight - donateTab.offsetHeight - 20;

    donateTab.style.top = Math.max(20, Math.min(newTop, maxTop)) + 'px';
  });

  donateTab.addEventListener('pointerup', (e) => {
    isDraggingDonate = false;
    donateTab.releasePointerCapture(e.pointerId);

    if (!didDragDonate) {
      donateBox.classList.toggle('show-donate-box');
    }
  });

  function closeDonateBox(e) {
    e.stopPropagation();
    donateBox.classList.remove('show-donate-box');
  }
</script>
        <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script><script>
window.addEventListener('load', () => {
  const target = document.getElementById('relevant-game');

  if (target) {
    target.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
});
</script></body>
        </html>
      `);
    });
  });
});

app.get('/game/:id', (req, res) => {
  const gameId = Number(req.params.id);

  if (!Number.isInteger(gameId)) {
    return res.send('Invalid match');
  }

  const userId = req.session.userId || null;

  const sql = `
    SELECT
      g.*,
      c.name AS competition_name,
      b.home_guess AS my_home_guess,
      b.away_guess AS my_away_guess,
      b.credits_used AS my_credits_used,
      b.points_won AS my_points
    FROM games g
    LEFT JOIN competitions c ON c.id = g.competition_id
    LEFT JOIN bets b
      ON b.game_id = g.id
      AND b.user_id = ?
    WHERE g.id = ?
  `;

  db.get(sql, [userId, gameId], (err, game) => {
    if (err || !game) {
      console.error(err);
      return res.send('Match not found');
    }

    const alreadyBet = game.my_home_guess !== null && game.my_home_guess !== undefined;
    const openForBetting = game.status === 'future' && canGuess(game.game_date, game.game_time);

let statusHtml;

if (game.status === 'live') {

  statusHtml = `
    <div class="match-final-score">
      ${game.home_score} : ${game.away_score}
    </div>

    <div class="live-pill">
      🔴 LIVE ${game.live_minute || ''}'
    </div>
  `;

} else if (game.status === 'finished') {

  statusHtml = `
    <div class="match-final-score">
      ${game.home_score} : ${game.away_score}
    </div>
  `;

  if (game.live_status === 'AET') {

    statusHtml += `
      <div class="status-pill">
        Finished after extra time
      </div>
    `;

  } else if (game.live_status === 'PEN') {

    const homeWon =
      Number(game.penalty_home_score) >
      Number(game.penalty_away_score);

    statusHtml += `
      <div class="status-pill">
        🏆
        ${homeWon ? game.home_team : game.away_team}
        won on penalties
        (${game.penalty_home_score}-${game.penalty_away_score})
      </div>
    `;
  }

} else {

  statusHtml = `
    <div
      class="next-match-countdown match-countdown"
      data-date="${game.game_date}"
      data-time="${game.game_time}">
    </div>
  `;
}

    const predictionHtml = req.session.userId
      ? `
        <div class="match-page-card">
          <div class="match-section-title">Your Prediction</div>

          ${
            alreadyBet
              ? `
                <div class="my-prediction-score">
                  ${game.my_home_guess} : ${game.my_away_guess}
                </div>

                <div class="match-page-meta">
                  Credits used: ${game.my_credits_used ?? 0}
                </div>

                <div class="match-page-meta">
                  Points earned: ${game.my_points ?? 0}
                </div>
              `
              : `
                <div class="match-page-meta">
                  You haven't predicted this match yet.
                </div>
              `
          }

          ${
            openForBetting
              ? `
                <a href="/games#game-${game.id}" class="secondary-btn match-action-btn">
                  ${alreadyBet ? 'Update Prediction' : 'Make Prediction'}
                </a>
              `
              : `
                <div class="status-pill">
                  ${game.status === 'finished' ? 'Match finished' : 'Betting closed'}
                </div>
              `
          }
        </div>
      `
      : `
        <div class="match-page-card">
          <div class="match-section-title">Prediction</div>
          <div class="match-page-meta">Login to predict this match.</div>
          <a href="/login" class="secondary-btn match-action-btn">Login</a>
        </div>
      `;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">

        <link rel="manifest" href="/manifest.json">
        <link rel="apple-touch-icon" href="/favicon-v3.PNG">
        <meta name="theme-color" content="#e5b947">

        <link rel="stylesheet" href="/css/style.css">

        <title>${game.home_team} vs ${game.away_team}</title>
      </head>

      <body> ${renderSideNav(req)}
        <div class="page-wrap match-page-wrap">

 <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

          <div class="match-page-card match-hero-card">
            <div class="match-stage">
              ${formatStage(game.stage)}
            </div>

            <h1 class="match-page-title">
              <span class="team">
                ${game.home_logo ? `<img src="${game.home_logo}" class="team-logo">` : ''}
                <a href="/nation/${encodeURIComponent(game.home_team)}">${game.home_team}</a>
              </span>

              <span class="vs">vs</span>

              <span class="team">
                ${game.away_logo ? `<img src="${game.away_logo}" class="team-logo">` : ''}
                <a href="/nation/${encodeURIComponent(game.away_team)}">${game.away_team}</a>
              </span>
            </h1>

            <div class="match-page-meta">
              ${game.game_date} • ${game.game_time}
            </div>

            <div class="match-page-meta">
              ${game.competition_name || 'World Cup 2026'}
            </div>

            ${game.venue ? `<div class="match-page-meta">🏟️ ${game.venue}</div>` : ''}

            ${statusHtml}

            <div class="match-atmosphere">
              Football history is waiting to be written.
            </div>
          </div>

          ${predictionHtml}

          <div class="match-page-card">
            <div class="match-section-title">Match Details</div>

            <div class="profile-stats">
              <div class="stat-box">
                <div class="stat-label">Status</div>
                <div class="stat-value">
  ${
    game.status === 'live'
      ? `🔴 LIVE ${game.live_minute || ''}'`
      : game.live_status === 'PEN'
        ? 'Finished (Penalties)'
        : game.live_status === 'AET'
          ? 'Finished (Extra Time)'
          : game.status
  }
</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Stage</div>
                <div class="stat-value">${formatStage(game.stage)}</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Competition</div>
                <div class="stat-value">${game.competition_name || 'World Cup 2026'}</div>
              </div>
            </div>
          </div>

        </div>

        <script>
          function updateMatchCountdown() {
            const el = document.querySelector('.match-countdown');
            if (!el) return;

            const target = new Date(el.dataset.date + 'T' + el.dataset.time + ':00Z');
            const diff = target - new Date();

            if (diff <= 0) {
              el.textContent = 'Betting closed / Match started';
              return;
            }

            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
            const minutes = Math.floor((diff / (1000 * 60)) % 60);
            const seconds = Math.floor((diff / 1000) % 60);

            el.textContent =
              'Starts in ' +
              days + 'd ' +
              String(hours).padStart(2, '0') + 'h ' +
              String(minutes).padStart(2, '0') + 'm ' +
              String(seconds).padStart(2, '0') + 's';
          }

          updateMatchCountdown();
          setInterval(updateMatchCountdown, 1000);
        </script>
      <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});


// =========================
// BETS
// =========================

app.post('/bet', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const gameId = Number(req.body.game_id);
  const homeGuess = Number(req.body.home_guess);
  const awayGuess = Number(req.body.away_guess);
  const creditsUsed = Number(req.body.credits_used);

  if (!Number.isInteger(gameId) || gameId <= 0) return res.send('Invalid game id');
  if (!Number.isInteger(homeGuess) || homeGuess < 0) return res.send('Home score must be a non-negative integer');
  if (!Number.isInteger(awayGuess) || awayGuess < 0) return res.send('Away score must be a non-negative integer');
  if (!Number.isInteger(creditsUsed) || creditsUsed <= 0) return res.send('Credits used must be a positive integer');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const gameResult = await client.query(`SELECT id, status, game_date, game_time, stage FROM games WHERE id = $1`, [gameId]);
    const game = gameResult.rows[0];
    if (!game) {
      await client.query('ROLLBACK');
      return res.send('Game not found');
    }

    if (game.status !== 'future' || !canGuess(game.game_date, game.game_time)) {
      await client.query('ROLLBACK');
      return res.send('Betting is closed for this match');
    }

   const maxCreditsForStage = getStageMaxCredits(game.stage);

if (creditsUsed > maxCreditsForStage) {
  await client.query('ROLLBACK');

  return res.send(`
    <script>
      alert("Maximum credits for this stage is ${maxCreditsForStage}");
      window.history.back();
    </script>
  `);
}

    const userResult = await client.query(`SELECT id, credits_left FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.send('User not found');
    }

    const existingResult = await client.query(`SELECT id, credits_used FROM bets WHERE user_id = $1 AND game_id = $2`, [userId, gameId]);
    const existingBet = existingResult.rows[0];
    const oldCreditsUsed = existingBet ? Number(existingBet.credits_used || 0) : 0;
    const effectiveCreditsLeft = Number(user.credits_left || 0) + oldCreditsUsed;

    if (creditsUsed > effectiveCreditsLeft) {
      await client.query('ROLLBACK');
      return res.send(`
    <script>
      alert("Not enough credits}");
      window.history.back();
    </script>
  `);
    }

    const newCreditsLeft = effectiveCreditsLeft - creditsUsed;

    await client.query(`UPDATE users SET credits_left = $1 WHERE id = $2`, [newCreditsLeft, userId]);
    await client.query(
      `
      INSERT INTO bets (user_id, game_id, home_guess, away_guess, credits_used, points_won)
      VALUES ($1, $2, $3, $4, $5, 0)
      ON CONFLICT (user_id, game_id) DO UPDATE SET
        home_guess = EXCLUDED.home_guess,
        away_guess = EXCLUDED.away_guess,
        credits_used = EXCLUDED.credits_used,
        points_won = 0,
        created_at = CURRENT_TIMESTAMP
      `,
      [userId, gameId, homeGuess, awayGuess, creditsUsed]
    );

    await client.query('COMMIT');
    res.redirect('/games#game-' + gameId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.send('Error saving bet');
  } finally {
    client.release();
  }
});

app.get('/my-bets', requireLogin, (req, res) => {
  const userId = req.session.userId;

  const sql = `
    SELECT
      b.id,
      b.home_guess,
      b.away_guess,
      b.credits_used,
      b.points_won,
      b.created_at,
      g.id AS game_id,
      g.home_team,
      g.away_team,
      g.game_date,
      g.game_time,
      g.home_score,
      g.away_score,
      g.status,
      g.stage,
      g.home_logo,
      g.away_logo
    FROM bets b
    JOIN games g ON g.id = b.game_id
    WHERE b.user_id = ?
    ORDER BY CASE WHEN g.status = 'future' THEN 0 ELSE 1 END, g.game_date ASC, g.game_time ASC
  `;

  db.all(sql, [userId], (err, bets) => {
    if (err) return res.send('Error loading bets');

    const cards = bets.map(b => {
      const isFinished = b.status === 'finished';

      return `
        <div class="bet-card">
          <div class="bet-card-top">
            <div class="bet-teams">
              <span class="team">${b.home_logo ? `<img src="${b.home_logo}" alt="${b.home_team}" class="team-logo">` : ''}${b.home_team}</span>
              <span class="vs">vs</span>
              <span class="team">${b.away_logo ? `<img src="${b.away_logo}" alt="${b.away_team}" class="team-logo">` : ''}${b.away_team}</span>
            </div>
          </div>
          <div class="bet-meta">
            <span><b>Stage:</b> ${formatStage(b.stage)}</span>
            <span><b>Date:</b> ${b.game_date} | ${b.game_time}</span>
            <span><b>Status:</b> ${isFinished ? 'Finished' : 'Open / Upcoming'}</span>
          </div>
          <div class="bet-details">
            <div class="bet-box"><div class="bet-label">My Bet</div><div class="bet-value">${b.home_guess} : ${b.away_guess}</div></div>
            <div class="bet-box"><div class="bet-label">Credits Used</div><div class="bet-value">${b.credits_used}</div></div>
            <div class="bet-box"><div class="bet-label">Points Won</div><div class="bet-value">${b.points_won ?? 0}</div></div>
            <div class="bet-box"><div class="bet-label">Final Result</div><div class="bet-value">${isFinished ? `${b.home_score} : ${b.away_score}` : '- : -'}</div></div>
          </div>
          ${!isFinished && canGuess(b.game_date, b.game_time) ? `<div class="bet-footer-note">You can still update this bet from the Games page.</div>` : ''}
        </div>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">
      <title>My Bets</title>
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body> ${renderSideNav(req)}
        <div class="page-wrap">
          <div class="section-title">My Bets</div>
          <div class="section-subtitle">Track all your World Cup predictions in one place</div>

          <div class="bets-page">${cards || `<div class="empty-state">You have not placed any bets yet.</div>`}</div>
        </div>
      <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});

app.post('/pin-match', requireLogin, async (req, res) => {
  const gameId = Number(req.body.game_id);

  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.send('Invalid game');
  }

  await pool.query(
    `INSERT INTO pinned_matches (user_id, game_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, game_id) DO NOTHING`,
    [req.session.userId, gameId]
  );

  res.redirect('/games');
});

app.post('/unpin-match', requireLogin, async (req, res) => {
  const gameId = Number(req.body.game_id);

  await pool.query(
    `DELETE FROM pinned_matches
     WHERE user_id = $1 AND game_id = $2`,
    [req.session.userId, gameId]
  );

  res.redirect('/games');
});

// =========================
// PRIVATE LEAGUES
// =========================

app.post('/league/create', requireLogin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.send('League name is required');

  const joinCode = makeJoinCode();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const leagueResult = await client.query(
      `INSERT INTO leagues (name, join_code, owner_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [name, joinCode, req.session.userId]
    );

    const leagueId = leagueResult.rows[0].id;

    await client.query(
      `INSERT INTO league_members (league_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [leagueId, req.session.userId]
    );

    await client.query('COMMIT');
    req.session.activeLeagueId = leagueId;
    res.redirect('/leagues');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.send('Error creating league');
  } finally {
    client.release();
  }
});

app.post('/league/join', requireLogin, (req, res) => {
  const code = String(req.body.join_code || '').trim().toUpperCase();

  if (!code) return res.send('Join code is required');

  db.get(
    `SELECT id FROM leagues WHERE join_code = ?`,
    [code],
    (err, league) => {
      if (err || !league) return res.send('League code not found');

      db.run(
        `
        INSERT INTO league_members (league_id, user_id)
        VALUES (?, ?)
        ON CONFLICT (league_id, user_id) DO NOTHING
        `,
        [league.id, req.session.userId],
        async function (err2) {
          if (err2) return res.send('Error joining league');

          if (this.changes > 0) {
            await pool.query(
              `
              INSERT INTO league_messages (league_id, user_id, message)
              VALUES ($1, $2, $3)
              `,
              [
                league.id,
                req.session.userId,
                `🎉 ${req.session.username} joined the league`
              ]
            );
          }

          res.redirect('/leagues');
        }
      );
    }
  );
});


app.post('/league/delete', isAdmin, async (req, res) => {
  const leagueId = Number(req.body.league_id);

  if (!Number.isInteger(leagueId) || leagueId <= 0) {
    return res.send('Invalid league id');
  }

  try {
    await pool.query(`DELETE FROM league_members WHERE league_id = $1`, [leagueId]);
    await pool.query(`DELETE FROM leagues WHERE id = $1`, [leagueId]);

    res.redirect('/leagues');
  } catch (err) {
    console.error(err);
    res.send('Error deleting league');
  }
});

app.get('/leagues', requireLogin, (req, res) => {
  const isAdminUser = Number(req.session.isAdmin) === 1;

  const sql = isAdminUser
    ? `
      SELECT
  l.id,
  l.name,
  l.join_code,
  l.owner_user_id,
COUNT(CASE
  WHEN lm.id > COALESCE(cr.last_seen_message_id, 0)
  THEN 1
END) AS unread_count
FROM leagues l
LEFT JOIN league_messages lm ON lm.league_id = l.id
LEFT JOIN chat_reads cr
  ON cr.league_id = l.id
  AND cr.user_id = ?
GROUP BY l.id, l.name, l.join_code, l.owner_user_id, cr.last_seen_message_id
ORDER BY l.name
    `
    : `
     SELECT
  l.id,
  l.name,
  l.join_code,
  l.owner_user_id,
COUNT(CASE
  WHEN lm.id > COALESCE(cr.last_seen_message_id, 0)
  THEN 1
END) AS unread_count
FROM leagues l
JOIN league_members m ON m.league_id = l.id
LEFT JOIN league_messages lm ON lm.league_id = l.id
LEFT JOIN chat_reads cr
  ON cr.league_id = l.id
  AND cr.user_id = ?
WHERE m.user_id = ?
GROUP BY l.id, l.name, l.join_code, l.owner_user_id, cr.last_seen_message_id
ORDER BY l.name
    `;

const params = isAdminUser
  ? [req.session.userId]
  : [req.session.userId, req.session.userId];

  db.all(sql, params, (err, rows) => {
    if (err) return res.send('Error loading leagues');


const list = rows.map(r => `
  <div class="league-card">
    <div class="league-title">${r.name}</div>
    <div class="league-meta"><b>Join Code:</b> ${r.join_code}</div>


    <div class="league-actions">


      <a class="secondary-btn" href="/leaderboard/${r.id}">
        Leaderboard
      </a>

<a class="secondary-btn chat-league-btn" href="/league/${r.id}/chat">
  Chat
  ${Number(r.unread_count) > 0 ? `<span class="chat-count">${r.unread_count}</span>` : ''}
</a>

      <button
        type="button"
        onclick="copyLeagueLink('${r.join_code}')"
        class="secondary-btn">
        Copy Invite Link
      </button>
      <a class="secondary-btn" href="/league/${r.id}/prizes">
  Prizes
</a>

${isAdminUser ? `        <form
          method="POST"
          action="/league/delete"
          style="display:inline;"
          onsubmit="return confirm('Delete this league?');">
          <input type="hidden" name="league_id" value="${r.id}">
          <button type="submit" class="auth-btn danger">Delete League</button>
        </form>
      ` : ''}
    </div>
  </div>
`).join('');

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="icon" href="/favicon.ico?v=31">
          <title>private Leagues</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>

        <body> ${renderSideNav(req)}
          <div class="page-wrap">
            <div class="section-title">My private Leagues</div>
            <div class="section-subtitle">
              Create a league, join one, and compete with privates
            </div>




            <div class="leagues-grid">
              ${list || `
                <div class="league-card">
                  <div class="league-title">No leagues yet</div>
                  <div class="league-meta">Create one or join one below.</div>
                </div>
              `}
            </div>

            <div class="form-card">
              <h3>Create League</h3>
              <p>Start a private World Cup competition and invite privates with a join code.</p>
              <form method="POST" action="/league/create">
                <input name="name" placeholder="League name" required>
                <button type="submit">Create League</button>
              </form>
            </div>

            <div class="form-card">
              <h3>Join League</h3>
              <p>Enter a join code to join an existing private league.</p>
              <form method="POST" action="/league/join">
                <input name="join_code" placeholder="Join code" required>
                <button type="submit">Join League</button>
              </form>
            </div>
          </div>

          <script>
            function copyLeagueLink(code) {
              const url = window.location.origin + '/join/' + code;

              navigator.clipboard.writeText(url)
                .then(function () {
                  alert('Invite link copied!');
                })
                .catch(function () {
                  prompt('Copy this invite link:', url);
                });
            }
          </script>
        <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
        </html>
      `);
    }
  );
});


app.get('/join/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();

  if (!req.session.userId) {
    req.session.pendingJoinCode = code;
    return res.redirect('/login');
  }

  db.get(
    `SELECT id FROM leagues WHERE join_code = ?`,
    [code],
    (err, league) => {
      if (err || !league) {
        return res.send('League not found');
      }

      db.run(
        `INSERT INTO league_members (league_id, user_id)
         VALUES (?, ?)
         ON CONFLICT (league_id, user_id) DO NOTHING`,
        [league.id, req.session.userId],
        (err2) => {
          if (err2) {
            console.error(err2);
            return res.send('Error joining league');
          }

          res.redirect('/leagues');
        }
      );
    }
  );
});

app.get('/leaderboard/:leagueId', requireLogin, (req, res) => {
  const leagueId = Number(req.params.leagueId);
  if (!Number.isInteger(leagueId) || leagueId <= 0) return res.send('Invalid league id');

  db.get(
    `SELECT
   l.id,
   l.name,
   l.prize_1,
   l.prize_2,
   l.prize_3,
   l.prize_4,
   l.prize_5
 FROM leagues l
     JOIN league_members lm ON lm.league_id = l.id
     WHERE l.id = ? AND lm.user_id = ?`,
    [leagueId, req.session.userId],
    (err, league) => {
      if (err || !league) return res.send('No access to this league');

     const sql = `
  SELECT
    u.id,
    u.username,
    u.credits_left,
    COALESCE(SUM(b.points_won), 0) AS total_points,
    COALESCE(SUM(
      CASE 
        WHEN b.home_guess = g.home_score 
         AND b.away_guess = g.away_score 
        THEN 1 ELSE 0 
      END
    ), 0) AS exact_hits,
    COALESCE(SUM(b.credits_used), 0) AS total_credits_used
  FROM league_members lm
  JOIN users u ON u.id = lm.user_id
  LEFT JOIN bets b ON b.user_id = u.id
  LEFT JOIN games g ON g.id = b.game_id
  WHERE lm.league_id = ?
  GROUP BY u.id, u.username, u.credits_left
  ORDER BY
    total_points DESC,
    exact_hits DESC,
    total_credits_used ASC,
    u.username ASC
`;

      db.all(sql, [leagueId], (err2, rows) => {
        if (err2) return res.send('Error loading league leaderboard');



const prizesHtml =
  league.prize_1 || league.prize_2 || league.prize_3 || league.prize_4 || league.prize_5
    ? `
      <div class="league-prizes-preview">
        <b>League Prizes</b>
        ${league.prize_1 ? `<div>🥇 ${league.prize_1}</div>` : ''}
        ${league.prize_2 ? `<div>🥈 ${league.prize_2}</div>` : ''}
        ${league.prize_3 ? `<div>🥉 ${league.prize_3}</div>` : ''}
        ${league.prize_4 ? `<div>4th: ${league.prize_4}</div>` : ''}
        ${league.prize_5 ? `<div>5th: ${league.prize_5}</div>` : ''}
      </div>
    `
    : `
      <div class="league-prizes-preview">
        <b>No prizes set yet</b>
        <div>League creator can add prizes from the league page.</div>
      </div>
    `;

        
        const tableRows = rows.map((r, index) => {
          const isMe = r.id === req.session.userId;
          return `<tr class="${isMe ? 'highlight-me' : ''}"><td>${index + 1}</td><td><a href="/profile/${r.id}">${r.username}</a>${isMe ? ' (me)' : ''}</td><td>${r.total_points}</td><td>${r.credits_left ?? 0}</td></tr>`;
        }).join('');

        res.send(`
          <!DOCTYPE html>
          <html lang="en">
          <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947"><meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">     
  <title>League Leaderboard</title><link rel="stylesheet" href="/css/style.css"></head>
          <body> ${renderSideNav(req)}<div class="page-wrap"><div class="section-title">League Leaderboard</div><div class="section-subtitle">${league.name}</div>
         
         
          ${prizesHtml}

<div class="table-card">
          <table><tr><th>Rank</th><th>User</th><th>Points</th><th>Credits Left</th></tr>${tableRows || '<tr><td colspan="4">No data</td></tr>'}</table></div></div><div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
          </html>
        `);
      });
    }
  );
});



app.get('/league/:id/chat', requireLogin, async (req, res) => {
  const leagueId = Number(req.params.id);

  if (!Number.isInteger(leagueId) || leagueId <= 0) {
    return res.send('Invalid league');
  }

  const memberCheck = await pool.query(
    `SELECT 1 FROM league_members WHERE league_id = $1 AND user_id = $2`,
    [leagueId, req.session.userId]
  );

  if (memberCheck.rows.length === 0) {
    return res.send('You are not a member of this league');
  }

  const latestResult = await pool.query(
  `SELECT COALESCE(MAX(id), 0) AS latest_id
   FROM league_messages
   WHERE league_id = $1`,
  [leagueId]
);

const latestId = Number(latestResult.rows[0].latest_id || 0);

await pool.query(
  `
  INSERT INTO chat_reads (user_id, league_id, last_seen_message_id)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id, league_id) DO UPDATE SET
    last_seen_message_id = EXCLUDED.last_seen_message_id
  `,
  [req.session.userId, leagueId, latestId]
);

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="/css/style.css">
      <title>League Chat</title>
    </head>
    <body> ${renderSideNav(req)}
      <div class="page-wrap">
  <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

        <div class="form-card">
          <h1>League Chat</h1>

          <div id="chatMessages" class="chat-box"></div>

          <form id="chatForm" class="chat-form">
            <input id="chatInput" maxlength="300" placeholder="Write a message..." required>
            <button type="submit">Send</button>
          </form>
        </div>
      </div>

      
       
  <script>
  const leagueId = ${leagueId};

  function formatChatTime(value) {
    if (!value) return '';

    const date = new Date(value);
    const now = new Date();

    const israelDate = new Date(
      date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })
    );

    const israelNow = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })
    );

    const startOfDay = d =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate());

    const diffDays = Math.round(
      (startOfDay(israelNow) - startOfDay(israelDate)) / 86400000
    );

    const time = israelDate.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    if (diffDays === 0) return 'Today ' + time;
    if (diffDays === 1) return 'Yesterday ' + time;
    if (diffDays === -1) return 'Tomorrow ' + time;

    const day = israelDate.getDate();
    const month = israelDate.getMonth() + 1;
    const year = String(israelDate.getFullYear()).slice(2);

    return day + '/' + month + '/' + year + ' ' + time;
  }

  function isNearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  async function loadMessages() {
    const res = await fetch('/league/' + leagueId + '/chat/messages');
    const messages = await res.json();

    const box = document.getElementById('chatMessages');

    const oldScrollTop = box.scrollTop;
    const oldScrollHeight = box.scrollHeight;
    const shouldStickToBottom = isNearBottom(box);

    box.innerHTML = messages.map(m => \`
      <div class="chat-message" dir="auto">
        <div class="chat-meta">
          <b>\${m.username}</b>
          <span>\${formatChatTime(m.created_at)}</span>
        </div>
        <div class="chat-text" dir="auto">\${m.message}</div>
      </div>
    \`).join('');

    if (shouldStickToBottom) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop =
        oldScrollTop + (box.scrollHeight - oldScrollHeight);
    }
  }

  document.getElementById('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const input = document.getElementById('chatInput');
    const message = input.value.trim();

    if (!message) return;

    await fetch('/league/' + leagueId + '/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    input.value = '';
    await loadMessages();

    const box = document.getElementById('chatMessages');
    box.scrollTop = box.scrollHeight;
  });

  loadMessages();
  setInterval(loadMessages, 2000);
</script>
      
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});

app.get('/league/:id/chat/messages', requireLogin, async (req, res) => {
  const leagueId = Number(req.params.id);

  const memberCheck = await pool.query(
    `SELECT 1 FROM league_members WHERE league_id = $1 AND user_id = $2`,
    [leagueId, req.session.userId]
  );

  if (memberCheck.rows.length === 0) {
    return res.status(403).json([]);
  }

  const result = await pool.query(
    `
    SELECT lm.message, lm.created_at, u.username
    FROM league_messages lm
    JOIN users u ON u.id = lm.user_id
    WHERE lm.league_id = $1
    ORDER BY lm.created_at ASC
    LIMIT 100
    `,
    [leagueId]
  );

  res.json(result.rows);
});

app.post('/league/:id/chat/send', requireLogin, async (req, res) => {
  const leagueId = Number(req.params.id);
  const message = String(req.body.message || '').trim();

  if (!message || message.length > 300) {
    return res.status(400).json({ ok: false });
  }

  const memberCheck = await pool.query(
    `SELECT 1 FROM league_members WHERE league_id = $1 AND user_id = $2`,
    [leagueId, req.session.userId]
  );

  if (memberCheck.rows.length === 0) {
    return res.status(403).json({ ok: false });
  }

  await pool.query(
    `
    INSERT INTO league_messages (league_id, user_id, message)
    VALUES ($1, $2, $3)
    `,
    [leagueId, req.session.userId, message]
  );

  res.json({ ok: true });
});
// =========================
// league prizes
// =========================
app.get('/league/:id/prizes', requireLogin, async (req, res) => {
  const leagueId = Number(req.params.id);

  if (!Number.isInteger(leagueId) || leagueId <= 0) {
    return res.send('Invalid league');
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM leagues
      WHERE id = $1
      `,
      [leagueId]
    );

    const league = result.rows[0];

    if (!league) {
      return res.send('League not found');
    }

    const canEdit =
      Number(req.session.isAdmin) === 1 ||
      Number(req.session.userId) === Number(league.owner_user_id);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/css/style.css">
        <title>League Prizes</title>
      </head>

      <body>
        ${renderSideNav(req)}

        <div class="page-wrap">
          <a href="javascript:history.back()" class="back-btn">
            ← Back
          </a>

          <div class="form-card">
            <h1>${league.name} Prizes</h1>

            <p class="muted">
              Define what each top position wins in this league.
            </p>

            <form method="POST" action="/league/${league.id}/prizes">
                <input type="hidden" name="return_to" value="${req.get('referer') || '/leagues'}">
              <input
                name="prize_1"
                placeholder="🥇 First place prize"
                value="${league.prize_1 || ''}"
                ${canEdit ? '' : 'readonly'}
              >

              <input
                name="prize_2"
                placeholder="🥈 Second place prize"
                value="${league.prize_2 || ''}"
                ${canEdit ? '' : 'readonly'}
              >

              <input
                name="prize_3"
                placeholder="🥉 Third place prize"
                value="${league.prize_3 || ''}"
                ${canEdit ? '' : 'readonly'}
              >

              <input
                name="prize_4"
                placeholder="4th place prize"
                value="${league.prize_4 || ''}"
                ${canEdit ? '' : 'readonly'}
              >

              <input
                name="prize_5"
                placeholder="5th place prize"
                value="${league.prize_5 || ''}"
                ${canEdit ? '' : 'readonly'}
              >

              ${
                canEdit
                  ? `<button type="submit">Save Prizes</button>`
                  : `<p class="muted">Only the league creator or admin can edit prizes.</p>`
              }
            </form>
          </div>
        </div>
      </body>
      </html>
    `);
} catch (err) {
  console.error(err);
  res.send(err.message);
}
});

app.post('/league/:id/prizes', requireLogin, async (req, res) => {
  const leagueId = Number(req.params.id);

  if (!Number.isInteger(leagueId) || leagueId <= 0) {
    return res.send('Invalid league');
  }

  try {
    const leagueResult = await pool.query(
      `
      SELECT owner_user_id
      FROM leagues
      WHERE id = $1
      `,
      [leagueId]
    );

    const league = leagueResult.rows[0];

    if (!league) {
      return res.send('League not found');
    }

    const canEdit =
      Number(req.session.isAdmin) === 1 ||
      Number(req.session.userId) === Number(league.owner_user_id);

    if (!canEdit) {
      return res.send('Not allowed');
    }

    await pool.query(
      `
      UPDATE leagues
      SET
        prize_1 = $1,
        prize_2 = $2,
        prize_3 = $3,
        prize_4 = $4,
        prize_5 = $5
      WHERE id = $6
      `,
      [
        req.body.prize_1 || null,
        req.body.prize_2 || null,
        req.body.prize_3 || null,
        req.body.prize_4 || null,
        req.body.prize_5 || null,
        leagueId
      ]
    );

    await pool.query(
  `
  INSERT INTO league_messages (league_id, user_id, message)
  VALUES ($1, $2, $3)
  `,
  [
    leagueId,
    req.session.userId,
    '🏆 League prizes were updated'
  ]
);
res.redirect(req.body.return_to || '/leagues');
  } catch (err) {
    console.error(err);
    res.send('Error saving prizes');
  }
});

// =========================
// CHATS
// =========================

app.get('/chats', requireLogin, (req, res) => {
  const sql = `
  SELECT
    l.id,
    l.name,

    COUNT(CASE
      WHEN lm.id > COALESCE(cr.last_seen_message_id, 0)
      THEN 1
    END) AS unread_count,

    MAX(lm.created_at) AS last_message_at,

    (
      SELECT lm2.message
      FROM league_messages lm2
      WHERE lm2.league_id = l.id
      ORDER BY lm2.id DESC
      LIMIT 1
    ) AS last_message

  FROM leagues l
  JOIN league_members m ON m.league_id = l.id
  LEFT JOIN league_messages lm ON lm.league_id = l.id
  LEFT JOIN chat_reads cr
    ON cr.league_id = l.id
    AND cr.user_id = ?

  WHERE m.user_id = ?

  GROUP BY l.id, l.name, cr.last_seen_message_id
  ORDER BY last_message_at DESC, l.name ASC
`;

  db.all(sql, [req.session.userId, req.session.userId], (err, rows) => {
    if (err) {
      console.error(err);
      return res.send('Error loading chats');
    }

  const chatsHtml = rows.map(r => `
  <a href="/league/${r.id}/chat" class="chat-list-card" dir="auto">
    <div class="chat-list-main">
      <div class="chat-list-title">${r.name}</div>

      <div class="chat-list-preview" dir="auto">
        ${r.last_message ? r.last_message : 'No messages yet'}
      </div>

      <div class="chat-list-meta" data-time="${r.last_message_at || ''}">
        ${r.last_message_at ? '' : 'No messages yet'}
      </div>
    </div>

    ${Number(r.unread_count) > 0 ? `
      <div class="chat-list-count">${r.unread_count}</div>
    ` : `
      <div class="chat-list-open">Open</div>
    `}
  </a>
`).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/css/style.css">
        <title>Chats</title>
      </head>
      <body> ${renderSideNav(req)}
        <div class="page-wrap">
 <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

          <h1>Chats</h1>
            <div class="section-subtitle">
              Choose a league chat and continue the conversation
            </div>

          <div class="form-card">
          <a href="/chat" class="chat-list-card">
  <div class="chat-list-main">
    <div class="chat-list-title">Global Chat</div>
    <div class="chat-list-preview">Talk with everyone on Predict World Cup</div>
    <div class="chat-list-meta">Public chat</div>
  </div>

  <div class="chat-list-open">Open</div>
</a>
            ${chatsHtml || '<p>No chats yet</p>'}
          </div>
        </div>
        <script>
  function formatIsraelChatTime(value) {
    if (!value) return '';

    const date = new Date(value);
    const now = new Date();

    const israelDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));

    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

    const diffDays = Math.round(
      (startOfDay(israelNow) - startOfDay(israelDate)) / 86400000
    );

    const time = israelDate.toLocaleTimeString('he-IL', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    if (diffDays === 0) return 'today ' + time;
    if (diffDays === 1) return 'yesterday ' + time;
    if (diffDays === -1) return 'tomorrow ' + time;

    const day = israelDate.getDate();
    const month = israelDate.getMonth() + 1;
    const year = String(israelDate.getFullYear()).slice(2);

    return day + '/' + month + '/' + year + ' ' + time;
  }

  document.querySelectorAll('[data-time]').forEach(el => {
    const value = el.dataset.time;
    if (value) el.textContent = formatIsraelChatTime(value);
  });
</script>
      </body>
      </html>
    `);
  });
});

app.get('/chat', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="/css/style.css">
      <title>Global Chat</title>
    </head>
    <body> ${renderSideNav(req)}
      <div class="page-wrap">
        <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

        <div class="form-card">
          <h1>Global Chat</h1>

          <div id="chatMessages" class="chat-box"></div>

          <form id="chatForm" class="chat-form">
            <input id="chatInput" maxlength="300" placeholder="Write a message..." required>
            <button type="submit">Send</button>
          </form>
        </div>
      </div>

      <script>
        function formatChatTime(value) {
          if (!value) return '';

          const date = new Date(value);
          const now = new Date();

          const israelDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
          const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));

          const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

          const diffDays = Math.round(
            (startOfDay(israelNow) - startOfDay(israelDate)) / 86400000
          );

          const time = israelDate.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          });

          if (diffDays === 0) return 'Today ' + time;
          if (diffDays === 1) return 'Yesterday ' + time;
          if (diffDays === -1) return 'Tomorrow ' + time;

          return israelDate.getDate() + '/' + (israelDate.getMonth() + 1) + '/' + String(israelDate.getFullYear()).slice(2) + ' ' + time;
        }

        function isNearBottom(box) {
          return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }

        async function loadMessages() {
          const res = await fetch('/chat/messages');
          const messages = await res.json();

          const box = document.getElementById('chatMessages');

          const oldScrollTop = box.scrollTop;
          const oldScrollHeight = box.scrollHeight;
          const shouldStickToBottom = isNearBottom(box);

          box.innerHTML = messages.map(m => \`
            <div class="chat-message" dir="auto">
              <div class="chat-meta">
                <b>\${m.username}</b>
                <span>\${formatChatTime(m.created_at)}</span>
              </div>
              <div class="chat-text" dir="auto">\${m.message}</div>
            </div>
          \`).join('');

          if (shouldStickToBottom) {
            box.scrollTop = box.scrollHeight;
          } else {
            box.scrollTop = oldScrollTop + (box.scrollHeight - oldScrollHeight);
          }
        }

        document.getElementById('chatForm').addEventListener('submit', async (e) => {
          e.preventDefault();

          const input = document.getElementById('chatInput');
          const message = input.value.trim();

          if (!message) return;

          await fetch('/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
          });

          input.value = '';
          await loadMessages();

          const box = document.getElementById('chatMessages');
          box.scrollTop = box.scrollHeight;
        });

        loadMessages();
        setInterval(loadMessages, 2000);
      </script>
    </body>
    </html>
  `);
});

app.get('/chat/messages', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT gm.message, gm.created_at, u.username
      FROM global_messages gm
      JOIN users u ON u.id = gm.user_id
      ORDER BY gm.created_at ASC
      LIMIT 150
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.post('/chat/send', requireLogin, async (req, res) => {
  const message = String(req.body.message || '').trim();

  if (!message || message.length > 300) {
    return res.status(400).json({ ok: false });
  }

  try {
    await pool.query(
      `
      INSERT INTO global_messages (user_id, message)
      VALUES ($1, $2)
      `,
      [req.session.userId, message]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get('/chat/latest-id', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT COALESCE(MAX(lm.id), 0) AS latest_id
      FROM league_messages lm
      JOIN league_members mem ON mem.league_id = lm.league_id
      WHERE mem.user_id = $1
      `,
      [req.session.userId]
    );

    res.json({ latestId: Number(result.rows[0].latest_id || 0) });
  } catch (err) {
    console.error(err);
    res.json({ latestId: 0 });
  }
});

app.get('/chat/notifications', requireLogin, async (req, res) => {
  const sinceId = Number(req.query.sinceId || 0);

  try {
    const result = await pool.query(
      `
      SELECT
        lm.id,
        lm.league_id,
        lm.message,
        u.username,
        l.name AS league_name
      FROM league_messages lm
      JOIN users u ON u.id = lm.user_id
      JOIN leagues l ON l.id = lm.league_id
      JOIN league_members mem ON mem.league_id = lm.league_id
      WHERE mem.user_id = $1
        AND lm.user_id <> $1
        AND lm.id > $2
      ORDER BY lm.id ASC
      LIMIT 5
      `,
      [req.session.userId, sinceId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// =========================
// ADMIN
// =========================

app.get('/admin', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/admin/users', isAdmin, (req, res) => {
  const sql = `
    SELECT u.id, u.username, u.is_admin, u.credits_left, COALESCE(SUM(b.points_won), 0) AS total_points
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id, u.username, u.is_admin, u.credits_left
    ORDER BY u.username ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.send('Error loading users');

    const tableRows = rows.map(u => `
      <tr>
        <td>${u.id}</td><td>${u.username}</td><td>${u.is_admin === 1 ? 'Yes' : 'No'}</td><td>${u.total_points}</td><td>${u.credits_left ?? 0}</td>
        <td>
          <form method="POST" action="/admin/reset-user-points" style="display:inline;"><input type="hidden" name="user_id" value="${u.id}"><button type="submit" class="secondary-btn">Reset Points</button></form>
          <form method="POST" action="/admin/reset-user-credits" style="display:inline;"><input type="hidden" name="user_id" value="${u.id}"><button type="submit" class="secondary-btn">Reset Credits</button></form>
          ${u.id === req.session.userId ? `<button type="button" class="secondary-btn" disabled>Delete</button>` : `<form method="POST" action="/admin/delete-user" style="display:inline;" onsubmit="return confirm('Delete this user?');"><input type="hidden" name="user_id" value="${u.id}"><button type="submit" class="auth-btn danger">Delete</button></form>`}
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947"><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">
  <title>Admin Users</title><link rel="stylesheet" href="/css/style.css"></head>
      <body> ${renderSideNav(req)}<div class="page-wrap"><div class="section-title">Admin Users</div><div class="section-subtitle">Manage users, reset points, and remove accounts</div><div <a href="javascript:history.back()" class="back-btn">
  ← Back
</a>
<div class="table-card"><table><tr><th>ID</th><th>Username</th><th>Admin</th><th>Total Points</th><th>Credits Left</th><th>Actions</th></tr>${tableRows || `<tr><td colspan="6">No users found</td></tr>`}</table></div></div><div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});

app.post('/admin/delete-user', isAdmin, async (req, res) => {
  const userId = Number(req.body.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return res.send('Invalid user id');
  if (userId === req.session.userId) return res.send('You cannot delete yourself');

  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    res.send('Error deleting user');
  }
});

app.post('/admin/reset-user-points', isAdmin, (req, res) => {
  const userId = Number(req.body.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return res.send('Invalid user id');

  db.run(`UPDATE bets SET points_won = 0 WHERE user_id = ?`, [userId], (err) => {
    if (err) return res.send('Error resetting points');
    res.redirect('/admin/users');
  });
});

app.post('/admin/reset-user-credits', isAdmin, (req, res) => {
  const userId = Number(req.body.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return res.send('Invalid user id');

  db.run(`UPDATE users SET credits_left = 100, knockout_bonus_given = 0 WHERE id = ?`, [userId], (err) => {
    if (err) return res.send('Error resetting credits');
    res.redirect('/admin/users');
  });
});

app.get('/admin/add-game', isAdmin, (req, res) => {
  db.all(`SELECT id, name FROM competitions ORDER BY name`, [], (err, comps) => {
    if (err) return res.send('Error loading competitions');

    const options = comps.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947"><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">     
<title>Add Game</title></head>
      <body> ${renderSideNav(req)}<h1>Add New Game</h1><form action="/admin/add-game" method="POST"><label>Competition:<select name="competition_id" required>${options}</select></label><br><br><label>Home Team:<input type="text" name="home_team" required></label><br><br><label>Away Team:<input type="text" name="away_team" required></label><br><br><label>Date:<input type="date" name="game_date" required></label><br><br><label>Time:<input type="time" name="game_time" required></label><br><br><button type="submit">Add Game</button></form><br><a href="/admin">Back to Admin</a><div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});

app.post('/admin/add-game', isAdmin, (req, res) => {
  const { home_team, away_team, game_date, game_time, competition_id } = req.body;
  const compId = Number(competition_id);
  if (!Number.isInteger(compId) || compId <= 0) return res.send('Invalid competition');

  db.run(
    `INSERT INTO games (home_team, away_team, game_date, game_time, status, competition_id)
     VALUES (?, ?, ?, ?, 'future', ?)`,
    [home_team, away_team, game_date, game_time, compId],
    (err) => {
      if (err) return res.send('Error adding game');
      res.redirect('/games');
    }
  );
});

app.get('/admin/results', isAdmin, (req, res) => {
  db.all(
    `SELECT g.*, c.name AS competition_name FROM games g LEFT JOIN competitions c ON c.id = g.competition_id ORDER BY g.game_date, g.game_time`,
    [],
    (err, games) => {
      if (err) return res.send('Error loading games');

      const html = games.map(g => {
        const hasResult = g.home_score !== null && g.away_score !== null;
        return `<div><h3>${g.home_team} vs ${g.away_team}</h3><p><b>Competition:</b> ${g.competition_name || 'World Cup 2026'}</p><p>${g.game_date} | ${g.game_time}</p><p><b>Stage:</b> ${formatStage(g.stage)}</p><p><b>Result:</b> ${hasResult ? `${g.home_score}:${g.away_score}` : 'Empty'}</p><form action="/admin/set-result" method="POST"><input type="hidden" name="game_id" value="${g.id}"><input type="number" name="home_score" min="0" required style="width:60px;" value="${hasResult ? g.home_score : ''}"> : <input type="number" name="away_score" min="0" required style="width:60px;" value="${hasResult ? g.away_score : ''}"><button type="submit">Set</button></form></div><hr>`;
      }).join('');

      res.send(`<!DOCTYPE html><html lang="en"><head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=31">
        <title>Set Results</title></head><body> ${renderSideNav(req)}<h1>Set Results (Admin)</h1>${html || '<p>No games</p>'}<a href="/admin">Back to Admin</a><div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body></html>`);
    }
  );
});

app.post('/admin/set-result', isAdmin, async (req, res) => {
  const gameId = Number(req.body.game_id);
  const homeScore = Number(req.body.home_score);
  const awayScore = Number(req.body.away_score);

  if (!Number.isInteger(gameId) || gameId <= 0) return res.send('Invalid game id');
  if (!Number.isInteger(homeScore) || homeScore < 0 || !Number.isInteger(awayScore) || awayScore < 0) return res.send('Result cannot be negative');

  try {
    await pool.query(`UPDATE games SET home_score = $1, away_score = $2, status = 'finished' WHERE id = $3`, [homeScore, awayScore, gameId]);

    const betsResult = await pool.query(
      `SELECT b.id, b.home_guess, b.away_guess, b.credits_used, gm.stage FROM bets b JOIN games gm ON gm.id = b.game_id WHERE b.game_id = $1`,
      [gameId]
    );

    for (const b of betsResult.rows) {
      const base = calcPoints(b.home_guess, b.away_guess, homeScore, awayScore, b.stage);
      const pts = base * b.credits_used;
      await pool.query(`UPDATE bets SET points_won = $1 WHERE id = $2`, [pts, b.id]);
    }

    res.redirect('/admin/results');
  } catch (err) {
    console.error(err);
    res.send('Error updating game');
  }
});

app.get('/admin/clear-games', isAdmin, (req, res) => {
  db.run(`DELETE FROM games`, [], (err) => {
    if (err) return res.send('Error deleting games');
    res.send('All games deleted');
  });
});

app.post('/admin/sync-games', isAdmin, async (req, res) => {
  try {
    await syncGamesFromApi();
    res.redirect('/games');
  } catch (err) {
    console.error(err);
    res.send('Game sync error: ' + err.message);
  }
});


app.get('/admin/stats', isAdmin, async (req, res) => {
  const users = await pool.query(`SELECT COUNT(*) FROM users`);
  const bets = await pool.query(`SELECT COUNT(*) FROM bets`);
  const online = await pool.query(`
    SELECT COUNT(*) 
    FROM users 
    WHERE last_seen_at >= NOW() - INTERVAL '5 minutes'
  `);

  const recent = await pool.query(`
    SELECT username, last_login_at
    FROM users
    ORDER BY last_login_at DESC NULLS LAST
    LIMIT 10
  `);

  const list = recent.rows.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.last_login_at || '-'}</td>
    </tr>
  `).join('');

  res.send(`
    <html>
    <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947">
      <title>Admin Stats</title>
      <link rel="stylesheet" href="/css/style.css">
     <link rel="icon" href="/favicon.ico?v=31">
    </head>
    <body> ${renderSideNav(req)}
      <div class="page-wrap">
        <h1>Admin Stats</h1>

        <div class="profile-stats">
          <div class="stat-box">
            <div class="stat-label">Users</div>
            <div class="stat-value">${users.rows[0].count}</div>
          </div>

          <div class="stat-box">
            <div class="stat-label">Online Now</div>
            <div class="stat-value">${online.rows[0].count}</div>
          </div>

          <div class="stat-box">
            <div class="stat-label">Total Bets</div>
            <div class="stat-value">${bets.rows[0].count}</div>
          </div>
        </div>

        <h3>Recent Logins</h3>

        <div class="table-card">
          <table>
            <tr>
              <th>User</th>
              <th>Last Login</th>
            </tr>
            ${list}
          </table>
        </div>

        <br>
        <a href="/admin">Back to Admin</a>
      </div>
    <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
    </html>
  `);
});

app.get('/analytics', isAdmin, async (req, res) => {
  try {
    const usersResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM users
    `);

    const newUsersTodayResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE created_at >= CURRENT_DATE
    `);

    const leaguesResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM leagues
    `);

    const betsResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM bets
    `);

    const gamesResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM games
    `);

    const finishedGamesResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM games
      WHERE status = 'finished'
    `);

    const leagueMessagesResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM league_messages
    `);

    const globalMessagesResult = await pool.query(`
      SELECT COUNT(*) AS count
      FROM global_messages
    `);

    const newestUsersResult = await pool.query(`
      SELECT username, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const newestUsersHtml = newestUsersResult.rows.map(u => `
      <div class="analytics-list-item">
        <b>${u.username}</b>
        <span>${new Date(u.created_at).toLocaleString()}</span>
      </div>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/css/style.css">
        <title>Admin Analytics</title>
      </head>

      <body>
        ${renderSideNav(req)}

        <div class="page-wrap">
          <a href="javascript:history.back()" class="back-btn">← Back</a>

          <div class="section-title">Admin Analytics</div>
          <div class="section-subtitle">
            Site activity overview
          </div>

          <div class="analytics-grid">
            <div class="analytics-card">
              <div class="analytics-value">${usersResult.rows[0].count}</div>
              <div class="analytics-label">Users</div>
            </div>

            <div class="analytics-card">
              <div class="analytics-value">${newUsersTodayResult.rows[0].count}</div>
              <div class="analytics-label">New Today</div>
            </div>

            <div class="analytics-card">
              <div class="analytics-value">${leaguesResult.rows[0].count}</div>
              <div class="analytics-label">Private Leagues</div>
            </div>

            <div class="analytics-card">
              <div class="analytics-value">${betsResult.rows[0].count}</div>
              <div class="analytics-label">Predictions</div>
            </div>

            <div class="analytics-card">
              <div class="analytics-value">${finishedGamesResult.rows[0].count}/${gamesResult.rows[0].count}</div>
              <div class="analytics-label">Finished Games</div>
            </div>

            <div class="analytics-card">
              <div class="analytics-value">
                ${Number(leagueMessagesResult.rows[0].count) + Number(globalMessagesResult.rows[0].count)}
              </div>
              <div class="analytics-label">Chat Messages</div>
            </div>
          </div>

          <div class="form-card">
            <h2>Newest Users</h2>
            ${newestUsersHtml || '<p>No users yet</p>'}
          </div>
        </div>
      </body>
      </html>
    `);
} catch (err) {
  console.error(err);
  res.send(err.message);
}
});

app.post('/admin/grant-knockout-bonus', isAdmin, (req, res) => {
  db.run(
    `UPDATE users SET credits_left = credits_left + 50, knockout_bonus_given = 1 WHERE knockout_bonus_given = 0`,
    [],
    (err) => {
      if (err) return res.send('Error granting knockout bonus');
      res.redirect('/admin/users');
    }
  );
});

// =========================
// UPDATE USER
// =========================

app.get('/update-user', requireLogin, (req, res) => {
  const userId = req.session.userId;

  db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err || !row) return res.send('Error loading user');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head> <link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e5b947"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Update User</title></head>
<link rel="icon" href="/favicon.ico?v=31">
   <body> ${renderSideNav(req)}<h1>Update User</h1><form action="/update-user" method="POST"><label>Username:<input type="text" name="username" value="${row.username}"></label><br><br><label>Password:<input type="password" name="password" placeholder="Use Change Password page"></label><br><br><button type="submit">Update</button></form><div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  });
});

app.post('/update-user', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const username = String(req.body.username || '').trim();

  if (!username) return res.send('Username is required');

  try {
    await pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [username, userId]);
    req.session.username = username;
    res.redirect(`/profile/${userId}`);
  } catch (err) {
    if (err.code === '23505') return res.send('Username already exists');
    console.error(err);
    res.send('Error updating user');
  }
});

// =========================
// Nation page
// =========================

app.get('/nation/:name', async (req, res) => {
  const nationName = req.params.name;

  const nationFacts = {
    Argentina: '🏆 FIFA World Cup 2022 Winner',
    France: '🏆 FIFA World Cup 2018 Winner',
    Spain: '🏆 FIFA World Cup 2010 Winner',
    Germany: '🏆 FIFA World Cup 2014 Winner',
    Brazil: '⭐ 5x World Champion',
    Croatia: '🥈 Runner-up in 2018',
    Morocco: '🔥 Historic 2022 Semi-Finalist'
  };
  const nationTrophies = {
  Argentina: [1978, 1986, 2022],
  Brazil: [1958, 1962, 1970, 1994, 2002],
  France: [1998, 2018],
  Germany: [1954, 1974, 1990, 2014],
  Italy: [1934, 1938, 1982, 2006],
  Spain: [2010],
  England: [1966],
  Uruguay: [1930, 1950]
};

const fact = nationFacts[nationName] || '';
const trophies = nationTrophies[nationName] || [];
  try {
    const gamesResult = await pool.query(
      `
      SELECT *
      FROM games
      WHERE home_team = $1 OR away_team = $1
      ORDER BY game_date ASC, game_time ASC
      `,
      [nationName]
    );
    const topPredictorResult = await pool.query(
      `
      SELECT
        u.id,
        u.username,
        COALESCE(SUM(b.points_won), 0) AS team_points
      FROM bets b
      JOIN users u ON u.id = b.user_id
      JOIN games g ON g.id = b.game_id
      WHERE g.home_team = $1 OR g.away_team = $1
      GROUP BY u.id, u.username
      ORDER BY team_points DESC, u.username ASC
      LIMIT 1
      `,
      [nationName]
    );

    const topPredictor = topPredictorResult.rows[0];

const nationThemes = {
  Argentina: 'theme-argentina',
  Brazil: 'theme-brazil',
  France: 'theme-france',
  Spain: 'theme-spain',
  Germany: 'theme-germany',
  England: 'theme-england',
  Portugal: 'theme-portugal',
  Netherlands: 'theme-netherlands',
  Belgium: 'theme-belgium',
  Italy: 'theme-italy',
  Croatia: 'theme-croatia',
  Morocco: 'theme-morocco',
  USA: 'theme-usa',
  Mexico: 'theme-mexico',
  Canada: 'theme-canada',
  Uruguay: 'theme-uruguay',
  Colombia: 'theme-colombia',
  Japan: 'theme-japan',
  'Korea Republic': 'theme-korea',
  Australia: 'theme-australia',
  Switzerland: 'theme-switzerland',
  Denmark: 'theme-denmark',
  Poland: 'theme-poland',
  Serbia: 'theme-serbia',
  Senegal: 'theme-senegal',
  Ghana: 'theme-ghana',
  Nigeria: 'theme-nigeria',
  Cameroon: 'theme-cameroon',
  Tunisia: 'theme-tunisia',
  Egypt: 'theme-egypt',
  'Saudi Arabia': 'theme-saudi',
  Iran: 'theme-iran',
  Qatar: 'theme-qatar'
};

const nationThemeClass = nationThemes[nationName] || '';

        const games = gamesResult.rows;

        if (games.length === 0) {
          return res.send('Nation not found');
        }

        const logo =
          games[0].home_team === nationName
            ? games[0].home_logo
            : games[0].away_logo;

        let wins = 0;
        let draws = 0;
        let losses = 0;
        let goalsFor = 0;
        let goalsAgainst = 0;

        games.forEach(g => {
          if (g.status !== 'finished') return;

          const isHome = g.home_team === nationName;
          const teamGoals = isHome ? g.home_score : g.away_score;
          const oppGoals = isHome ? g.away_score : g.home_score;

          goalsFor += Number(teamGoals || 0);
          goalsAgainst += Number(oppGoals || 0);

          if (teamGoals > oppGoals) wins++;
          else if (teamGoals < oppGoals) losses++;
          else draws++;
        });

    const gamesHtml = games.map(g => {
      const isFinished = g.status === 'finished';

      return `
        <div class="game-card">
          <div class="teams-row">
            <span class="team">
              ${g.home_logo ? `<img src="${g.home_logo}" class="team-logo">` : ''}
              ${g.home_team}
            </span>

            <span class="vs">vs</span>

            <span class="team">
              ${g.away_logo ? `<img src="${g.away_logo}" class="team-logo">` : ''}
              ${g.away_team}
            </span>
          </div>

          <div class="league-meta">${g.game_date} • ${g.game_time}</div>
          <div class="league-meta">${formatStage(g.stage)}</div>

          ${
            isFinished
              ? `<div class="result-score">${g.home_score} : ${g.away_score}</div>`
              : `<div class="guess-help">Upcoming Match</div>`
          }
        </div>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" href="/favicon.ico?v=31">
        <link rel="stylesheet" href="/css/style.css">
        <title>${nationName}</title>
      </head>

      <body class="${nationThemeClass}">
        <div class="page-wrap">
<a href="javascript:history.back()" class="back-btn">
  ← Back
</a>

          <div class="profile-card">
            ${logo ? `<img src="${logo}" class="team-logo" style="width:80px;height:80px;">` : ''}

            <h1>${nationName}</h1>

            ${fact ? `<div class="team-fact">${fact}</div>` : ''}

            ${
  trophies.length
    ? `
      <div class="trophy-cabinet">
        <div class="trophy-title">
          🏆 World Cup Titles
        </div>

        <div class="trophy-years">
          ${trophies.join(' • ')}
        </div>
      </div>
    `
    : ''
}

            <div class="profile-stats">
              <div class="stat-box">
                <div class="stat-label">Wins</div>
                <div class="stat-value">${wins}</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Draws</div>
                <div class="stat-value">${draws}</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Losses</div>
                <div class="stat-value">${losses}</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Goals For</div>
                <div class="stat-value">${goalsFor}</div>
              </div>

              <div class="stat-box">
                <div class="stat-label">Goals Against</div>
                <div class="stat-value">${goalsAgainst}</div>
                </div>
            </div>
          </div>
   ${
                topPredictor
                  ? `
                    <div class="form-card">
                      <h3>Top ${nationName} Predictor</h3>
                      <p>
                        <a href="/profile/${topPredictor.id}">
                          ${topPredictor.username}
                        </a>
                        — ${topPredictor.team_points} points
                      </p>
                    </div>
                  `
                  : ''
              }
          <div class="section-title" style="font-size:42px;">Matches</div>

          ${gamesHtml}
        </div>
      <div id="chatToast" class="chat-toast">
  <div class="chat-toast-title" id="chatToastTitle"></div>
  <div class="chat-toast-text" id="chatToastText"></div>
</div>

<script src="/js/chatNotifications.js"></script></body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.send('Error loading nation page');
  }
});


// =========================
// DEBUG / CHECK
// =========================

app.get('/check-games', (req, res) => {
  db.all(`SELECT * FROM games ORDER BY game_date, game_time`, [], (err, rows) => {
    if (err) return res.send(err.message);
    res.json(rows);
  });
});

// =========================
// START
// =========================

let syncTimer = null;
let syncRunning = false;

async function hasLiveGames() {
  const result = await pool.query(`
    SELECT 1
    FROM games
    WHERE status = 'live'
    LIMIT 1
  `);

  return result.rows.length > 0;
}

async function smartSyncLoop() {
  if (syncRunning) return;

  syncRunning = true;

  try {
    await runAutoSync();
  } catch (err) {
    console.error(err);
  } finally {
    syncRunning = false;
  }

  const live = await hasLiveGames();
  const delay = live ? 60 * 1000 : 60 * 60 * 1000;

  console.log(`Next sync in ${live ? '1 minute' : '1 hour'}`);

  clearTimeout(syncTimer);
  syncTimer = setTimeout(smartSyncLoop, delay);
}

async function startServer() {
  try {
    await setupDatabase();
    await ensureAdminUser();

    smartSyncLoop();

    app.listen(PORT, () => {
      console.log(`Server is listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('STARTUP ERROR:', err);
    process.exit(1);
  }
}


console.log('25 credits added to all users');
startServer();

