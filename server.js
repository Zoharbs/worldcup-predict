require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

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
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      credits_left INTEGER DEFAULT 100,
      knockout_bonus_given INTEGER DEFAULT 0,
      last_login_at TIMESTAMP,
      last_seen_at TIMESTAMP

    )
  `);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP`);
  



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
    CREATE TABLE IF NOT EXISTS league_members (
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (league_id, user_id)
    )
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
  if (!req.session.userId) {
    return res.status(401).send('You must login first');
  }
  next();
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

function getIsraelNowParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = fmt.formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`
  };
}

function apiDateToIsraelParts(apiDate) {
  const dateObj = new Date(apiDate);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = fmt.formatToParts(dateObj);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`
  };
}

function canGuess(game_date, game_time) {
  const now = getIsraelNowParts();
  if (game_date > now.date) return true;
  if (game_date < now.date) return false;
  return game_time > now.time;
}

function formatStage(stage) {
  const s = String(stage || '').toUpperCase();

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

async function recalculatePointsForGameByExternalId(externalId, homeScore, awayScore) {
  const gameResult = await pool.query(`SELECT id, stage FROM games WHERE external_id = $1`, [externalId]);
  const game = gameResult.rows[0];
  if (!game) return;

  const betsResult = await pool.query(
    `SELECT id, home_guess, away_guess, credits_used FROM bets WHERE game_id = $1`,
    [game.id]
  );

  for (const b of betsResult.rows) {
    const base = calcPoints(b.home_guess, b.away_guess, homeScore, awayScore, game.stage);
    const pts = base * b.credits_used;
    await pool.query(`UPDATE bets SET points_won = $1 WHERE id = $2`, [pts, b.id]);
  }
}

async function syncGamesFromApi() {
  const matches = await fetchWorldCupMatches();
  console.log('matches returned:', matches.length);

  for (const item of matches) {
    const fixture = item.fixture;
    const teams = item.teams;
    const goals = item.goals;
    const league = item.league;

    if (!fixture || !teams) continue;

    const externalId = String(fixture.id);
    const israelDate = apiDateToIsraelParts(fixture.date);

    const homeTeam = teams.home?.name || 'TBD';
    const awayTeam = teams.away?.name || 'TBD';
    const homeLogo = teams.home?.logo || null;
    const awayLogo = teams.away?.logo || null;

    const status = fixture.status && ['FT', 'AET', 'PEN'].includes(fixture.status.short)
      ? 'finished'
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
        away_logo
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        away_logo = EXCLUDED.away_logo
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
        awayLogo
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
  const password = String(req.body.password || '');

  let error = null;

  if (!username || !password) {
    error = 'Username and password are required';
  } else if (!isStrongPassword(password)) {
    error = 'Password must be at least 8 characters and include uppercase, lowercase, and a number';
  }

  if (error) {
    return res.send(`
      <script>
        alert("${error}");
        window.location.href = "/register";
      </script>
    `);
  }

  db.get(`SELECT id FROM users WHERE username = ?`, [username], async (err, existingUser) => {
    if (existingUser) {
      return res.send(`
        <script>
          alert("Username already exists");
          window.location.href = "/register";
        </script>
      `);
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
      `INSERT INTO users (username, password, is_admin, credits_left, knockout_bonus_given)
       VALUES (?, ?, 0, 100, 0)`,
      [username, hash],
      () => res.redirect('/')
    );
  });
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
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

    req.session.userId = row.id;
    req.session.username = row.username;
    req.session.isAdmin = row.is_admin;

    res.redirect('/');
  });
});

app.get('/change-password', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <title>Change Password</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>
    <body>
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
    </body>
    </html>
  `);
});

app.post('/change-password', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.send('All fields are required');
  }

  if (newPassword !== confirmPassword) {
    return res.send('New passwords do not match');
  }

  if (!isStrongPassword(newPassword)) {
    return res.send('Password must be at least 8 characters and include uppercase, lowercase, and a number');
  }

  try {
    const result = await pool.query(`SELECT password FROM users WHERE id = $1`, [userId]);
    const user = result.rows[0];
    if (!user) return res.send('User not found');

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.send('Current password is wrong');

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [newHash, userId]);

    res.redirect(`/profile/${userId}`);
  } catch (err) {
    console.error(err);
    res.send('Error updating password');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) res.send('Logout error');
    else res.redirect('/');
  });
});

// =========================
// STATIC / CONTENT PAGES
// =========================

app.get('/help', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <title>How to Play</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>
    <body>
      <div class="page-wrap help-page">
        <div class="section-title help-title">How to Play</div>
        <div class="section-subtitle help-subtitle">Everything you need to know about the World Cup Challenge</div>

        <div class="top-nav help-nav">
          <a href="/">Home</a>
          <a href="/games">Games</a>
          <a href="/leaderboard">Leaderboard</a>
          ${req.session.userId ? `<a href="/profile/${req.session.userId}">My Profile</a>` : ''}
        </div>

        <div class="help-card"><h3 class="help-card-title">What is World Cup Challenge?</h3><p class="help-text">World Cup Challenge is a prediction game for the FIFA World Cup. Predict match scores, spend your credits wisely, and compete for the top spot in the global leaderboard or inside your friend leagues.</p></div>
        <div class="help-card"><h3 class="help-card-title">Credits System</h3><p class="help-text">Each player starts the tournament with <b>100 credits</b>.</p><p class="help-text">When the knockout stage begins, every player receives an additional <b>+50 credits</b>.</p><p class="help-text">Credits are limited, so every decision matters.</p></div>
        <div class="help-card"><h3 class="help-card-title">How to Bet</h3><p class="help-text">For each match, you choose the final score you predict and how many credits you want to place on that prediction.</p></div>
        <div class="help-card"><h3 class="help-card-title">Points System</h3><p class="help-text"><b>Exact score:</b> 3 points</p><p class="help-text"><b>Correct winner or draw:</b> 1 point</p><p class="help-text"><b>Wrong prediction:</b> 0 points</p></div>
        <div class="help-card"><h3 class="help-card-title">Tie-Breaker</h3><p class="help-text">If two players finish with the same number of points, the higher rank goes to the player who used fewer total credits.</p></div>
        <div class="help-card"><h3 class="help-card-title">Friend Leagues</h3><p class="help-text">You can create or join private friend leagues and compete against specific groups.</p></div>
      </div>
    </body>
    </html>
  `);
});

// =========================
// HOME
// =========================

app.get('/', (req, res) => {
  let greeting;
  let menu = '';

  if (req.session.username) {
    const user = `<a href="/profile/${req.session.userId}">${req.session.username}</a>`;
    greeting = `Welcome ${user}`;

    menu = `
      <div class="auth-links">
        <a href="/leagues" class="auth-btn secondary">Friend Leagues</a>
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

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <link rel="stylesheet" href="/css/style.css">
      <title>Predict Worldcup</title>
    </head>
    <body>
      <div class="center-page">
        <div class="home-box">
          <h1>Predict WorldCup</h1>
          <p class="description">Join friend leagues, predict World Cup matches, and spend your credits wisely.</p>

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
    </body>
    </html>
  `);
});

// =========================
// LEADERBOARD
// =========================

app.get('/leaderboard', (req, res) => {
  const sql = `
    SELECT u.id, u.username, u.credits_left, COALESCE(SUM(b.points_won), 0) AS total_points
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id, u.username, u.credits_left
    ORDER BY total_points DESC, u.username ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.send('Error loading leaderboard');

    const tableRows = rows.map((r, index) => {
      const isMe = req.session.userId === r.id;
      return `
        <tr class="${isMe ? 'highlight-me' : ''}">
          <td class="rank-cell">${index + 1}</td>
          <td><a href="/profile/${r.id}">${r.username}</a>${isMe ? ' (me)' : ''}</td>
          <td class="points-cell">${r.total_points}</td>
          <td>${r.credits_left ?? 0}</td>
        </tr>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">        <title>Leaderboard</title>
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body>
        <div class="page-wrap">
          <div class="section-title">Leaderboard</div>
          <div class="section-subtitle">Global ranking of all players</div>
          <div class="top-nav">
            <a href="/">Home</a>
            <a href="/games">Games</a>
            ${req.session.userId ? `<a href="/profile/${req.session.userId}">My Profile</a>` : ''}
          </div>
          <div class="table-card">
            <table>
              <tr><th>Rank</th><th>Username</th><th>Points</th><th>Credits Left</th></tr>
              ${tableRows}
            </table>
          </div>
        </div>
      </body>
      </html>
    `);
  });
});

// =========================
// PROFILE
// =========================

app.get('/profile/:id', (req, res) => {
  const profileUserId = Number(req.params.id);
  if (!Number.isInteger(profileUserId) || profileUserId <= 0) return res.send('Invalid user id');

  db.get(
    `
    SELECT
      u.id,
      u.username,
      u.credits_left,
      COALESCE(SUM(b.points_won), 0) AS total_points,
      COUNT(b.id) AS total_bets,
      SUM(CASE WHEN b.home_guess = gm.home_score AND b.away_guess = gm.away_score THEN 1 ELSE 0 END) AS exact_bets
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

          const exactBets = userStats.exact_bets || 0;
          const totalBets = userStats.total_bets || 0;
          const successRate = totalBets > 0 ? ((exactBets / totalBets) * 100).toFixed(1) : '0.0';

          res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">              <title>User Profile</title>
              <link rel="stylesheet" href="/css/style.css">
            </head>
            <body>
              <div class="profile-page">
                <div class="profile-card">
                  <div class="profile-title">${userStats.username}</div>
                  <div class="profile-subtitle">Player profile and tournament stats</div>
                  <div class="profile-stats">
                    <div class="stat-box"><div class="stat-label">Total Points</div><div class="stat-value">${userStats.total_points}</div></div>
                    <div class="stat-box"><div class="stat-label">Credits Left</div><div class="stat-value">${userStats.credits_left ?? 0}</div></div>
                    <div class="stat-box"><div class="stat-label">Total Bets</div><div class="stat-value">${totalBets}</div></div>
                    <div class="stat-box"><div class="stat-label">Success Rate</div><div class="stat-value">${successRate}%</div></div>
                  </div>
                  <div class="profile-section">
                    <h3>Best Bet</h3>
                    ${bestBet ? `
                      <div class="best-guess-row"><b>Match:</b> ${bestBet.home_team} vs ${bestBet.away_team}</div>
                      <div class="best-guess-row"><b>Your Guess:</b> ${bestBet.home_guess} : ${bestBet.away_guess}</div>
                      <div class="best-guess-row"><b>Final Score:</b> ${bestBet.home_score ?? '-'} : ${bestBet.away_score ?? '-'}</div>
                      <div class="best-guess-row"><b>Stage:</b> ${formatStage(bestBet.stage)}</div>
                      <div class="best-guess-row"><b>Credits Used:</b> ${bestBet.credits_used}</div>
                      <div class="best-guess-row"><b>Points Earned:</b> ${bestBet.points_won ?? 0}</div>
                    ` : `<div class="best-guess-row">No bets yet</div>`}
                  </div>
                  <div class="profile-links">
                    <a href="/leaderboard">Leaderboard</a>
                    <a href="/leagues">Friend Leagues</a>
                    <a href="/games">Games</a>
                    <a href="/">Home</a>
                  </div>
                </div>
              </div>
            </body>
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
          b.credits_used AS my_credits_used
        FROM games g
        LEFT JOIN competitions c ON c.id = g.competition_id
        LEFT JOIN bets b ON b.game_id = g.id AND b.user_id = ?
        WHERE g.status IN ('future','finished')
        ORDER BY g.game_date ASC, g.game_time ASC
      `
      : `
        SELECT g.*, c.name AS competition_name
        FROM games g
        LEFT JOIN competitions c ON c.id = g.competition_id
        WHERE g.status IN ('future','finished')
        ORDER BY g.game_date ASC, g.game_time ASC
      `;

    const params = isLoggedIn ? [userId] : [];

    db.all(sql, params, (err, games) => {
      if (err) {
        console.error(err);
        return res.send('Error loading games');
      }

      const filterBar = `
        <div class="filters-bar">
          <div class="filters-nav">
            <a href="/" class="filter-link">Home</a>
            <a href="/leaderboard" class="filter-link">Leaderboard</a>
            ${isLoggedIn ? `<a href="/leagues" class="filter-link">Friend Leagues</a>` : ''}
            ${isLoggedIn ? `<a href="/profile/${req.session.userId}" class="filter-link">My Profile</a>` : ''}
            ${isLoggedIn ? `<a href="/my-bets" class="filter-link">My Bets</a>` : ''}
            ${activeLeagueId ? `<a href="/leaderboard/${activeLeagueId}" class="filter-link">Active League Leaderboard</a>` : ''}
            ${activeLeagueId ? `<a href="/league/clear" class="filter-link danger-link">Back to general</a>` : ''}
          </div>
        </div>
      `;

      const now = getIsraelNowParts();
      const todayStr = now.date;
      const nowTime = now.time;
      let todayMarked = false;
      let fallbackMarked = false;
      let gamesHtml = '';

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

        gamesHtml += `
          <div class="game-card" ${gameAnchor}>
            <h3 class="teams-row">
              <span class="team">${game.home_logo ? `<img src="${game.home_logo}" alt="${game.home_team}" class="team-logo">` : ''}${game.home_team}</span>
              <span class="vs">vs</span>
              <span class="team">${game.away_logo ? `<img src="${game.away_logo}" alt="${game.away_team}" class="team-logo">` : ''}${game.away_team}</span>
            </h3>
            <p><b>Competition:</b> ${game.competition_name || 'World Cup 2026'}</p>
            <p><b>Stage:</b> ${formatStage(game.stage)}</p>
            <p>${game.game_date} | ${game.game_time}</p>
            ${block}
          </div>
        `;
      });

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">          <title>Game list</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>
        <body>
          <div class="page-wrap">
            <h1>All Games</h1>
            ${isLoggedIn ? `<h3 class="muted">Connected as <a href="/profile/${req.session.userId}">${req.session.username}</a> | Credits left: ${creditsLeft}</h3>` : `<h3 class="muted">User not logged in</h3>`}
            ${filterBar}
            ${gamesHtml || '<p>No games to display</p>'}
            <script>
              const el = document.getElementById('today-game');
              if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
            </script>
          </div>
        </body>
        </html>
      `);
    });
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
      return res.send(`Maximum credits for this stage is ${maxCreditsForStage}`);
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
      return res.send('Not enough credits');
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
    res.redirect('/games');
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
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">        <title>My Bets</title>
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body>
        <div class="page-wrap">
          <div class="section-title">My Bets</div>
          <div class="section-subtitle">Track all your World Cup predictions in one place</div>
          <div class="top-nav">
            <a href="/">Home</a>
            <a href="/games">Games</a>
            <a href="/leaderboard">Leaderboard</a>
            <a href="/profile/${req.session.userId}">My Profile</a>
          </div>
          <div class="bets-page">${cards || `<div class="empty-state">You have not placed any bets yet.</div>`}</div>
        </div>
      </body>
      </html>
    `);
  });
});

// =========================
// FRIEND LEAGUES
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

  db.get(`SELECT id FROM leagues WHERE join_code = ?`, [code], (err, league) => {
    if (err || !league) return res.send('League code not found');

    db.run(
      `INSERT INTO league_members (league_id, user_id) VALUES (?, ?) ON CONFLICT (league_id, user_id) DO NOTHING`,
      [league.id, req.session.userId],
      (err2) => {
        if (err2) return res.send('Error joining league');
        req.session.activeLeagueId = league.id;
        res.redirect('/leagues');
      }
    );
  });
});

app.post('/league/switch', requireLogin, (req, res) => {
  const leagueId = Number(req.body.league_id);
  if (!Number.isInteger(leagueId) || leagueId <= 0) return res.send('Invalid league id');

  db.get(
    `SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ?`,
    [leagueId, req.session.userId],
    (err, row) => {
      if (err || !row) return res.send('No access to this league');
      req.session.activeLeagueId = leagueId;
      res.redirect('/games');
    }
  );
});

app.get('/league/clear', (req, res) => {
  req.session.activeLeagueId = null;
  res.redirect('/games');
});

app.get('/leagues', requireLogin, (req, res) => {
  db.all(
    `SELECT l.id, l.name, l.join_code
     FROM leagues l
     JOIN league_members m ON m.league_id = l.id
     WHERE m.user_id = ?
     ORDER BY l.name`,
    [req.session.userId],
    (err, rows) => {
      if (err) return res.send('Error loading leagues');

      const active = req.session.activeLeagueId;
      const list = rows.map(r => `
        <div class="league-card">
          <div class="league-title">${r.name}</div>
          <div class="league-meta"><b>Join Code:</b> ${r.join_code}</div>
          ${active === r.id ? `<div class="league-badge">Active League</div>` : ''}
          <div class="league-actions">
            ${active === r.id ? '' : `<form method="POST" action="/league/switch" style="display:inline;"><input type="hidden" name="league_id" value="${r.id}"><button type="submit">Set as Active</button></form>`}
            <a class="secondary-btn" href="/leaderboard/${r.id}">League Leaderboard</a>
          </div>
        </div>
      `).join('');

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">          <title>Friend Leagues</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>
        <body>
          <div class="page-wrap">
            <div class="section-title">My Friend Leagues</div>
            <div class="section-subtitle">Create a league, join one, and compete with friends</div>
            <div class="top-nav"><a href="/">Home</a><a href="/games">Games</a><a href="/leaderboard">Global Leaderboard</a><a href="/profile/${req.session.userId}">My Profile</a></div>
            <div class="status-pill">Current Mode: ${active ? `Friend League Active (ID: ${active})` : 'Global'} ${active ? ` | <a href="/league/clear">Back to Global</a>` : ''}</div>
            <div class="leagues-grid">${list || `<div class="league-card"><div class="league-title">No leagues yet</div><div class="league-meta">Create one or join one below.</div></div>`}</div>
            <div class="form-card"><h3>Create League</h3><p>Start a private World Cup competition and invite friends with a join code.</p><form method="POST" action="/league/create"><input name="name" placeholder="League name" required><button type="submit">Create League</button></form></div>
            <div class="form-card"><h3>Join League</h3><p>Enter a join code to join an existing friend league.</p><form method="POST" action="/league/join"><input name="join_code" placeholder="Join code" required><button type="submit">Join League</button></form></div>
          </div>
        </body>
        </html>
      `);
    }
  );
});

app.get('/leaderboard/:leagueId', requireLogin, (req, res) => {
  const leagueId = Number(req.params.leagueId);
  if (!Number.isInteger(leagueId) || leagueId <= 0) return res.send('Invalid league id');

  db.get(
    `SELECT l.id, l.name
     FROM leagues l
     JOIN league_members lm ON lm.league_id = l.id
     WHERE l.id = ? AND lm.user_id = ?`,
    [leagueId, req.session.userId],
    (err, league) => {
      if (err || !league) return res.send('No access to this league');

      const sql = `
        SELECT u.id, u.username, u.credits_left, COALESCE(SUM(b.points_won), 0) AS total_points
        FROM league_members lm
        JOIN users u ON u.id = lm.user_id
        LEFT JOIN bets b ON b.user_id = u.id
        WHERE lm.league_id = ?
        GROUP BY u.id, u.username, u.credits_left
        ORDER BY total_points DESC, u.username ASC
      `;

      db.all(sql, [leagueId], (err2, rows) => {
        if (err2) return res.send('Error loading league leaderboard');

        const tableRows = rows.map((r, index) => {
          const isMe = r.id === req.session.userId;
          return `<tr class="${isMe ? 'highlight-me' : ''}"><td>${index + 1}</td><td><a href="/profile/${r.id}">${r.username}</a>${isMe ? ' (me)' : ''}</td><td>${r.total_points}</td><td>${r.credits_left ?? 0}</td></tr>`;
        }).join('');

        res.send(`
          <!DOCTYPE html>
          <html lang="en">
          <head><meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">          <title>League Leaderboard</title><link rel="stylesheet" href="/css/style.css"></head>
          <body><div class="page-wrap"><div class="section-title">League Leaderboard</div><div class="section-subtitle">${league.name}</div><div class="top-nav"><a href="/leagues">Friend Leagues</a><a href="/games">Games</a><a href="/leaderboard">Global Leaderboard</a></div><div class="table-card"><table><tr><th>Rank</th><th>User</th><th>Points</th><th>Credits Left</th></tr>${tableRows || '<tr><td colspan="4">No data</td></tr>'}</table></div></div></body>
          </html>
        `);
      });
    }
  );
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
      <head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <title>Admin Users</title><link rel="stylesheet" href="/css/style.css"></head>
      <body><div class="page-wrap"><div class="section-title">Admin Users</div><div class="section-subtitle">Manage users, reset points, and remove accounts</div><div class="top-nav"><a href="/admin">Admin</a><a href="/">Home</a><a href="/leaderboard">Leaderboard</a></div><div class="table-card"><table><tr><th>ID</th><th>Username</th><th>Admin</th><th>Total Points</th><th>Credits Left</th><th>Actions</th></tr>${tableRows || `<tr><td colspan="6">No users found</td></tr>`}</table></div></div></body>
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
      <head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <title>Add Game</title></head>
      <body><h1>Add New Game</h1><form action="/admin/add-game" method="POST"><label>Competition:<select name="competition_id" required>${options}</select></label><br><br><label>Home Team:<input type="text" name="home_team" required></label><br><br><label>Away Team:<input type="text" name="away_team" required></label><br><br><label>Date:<input type="date" name="game_date" required></label><br><br><label>Time:<input type="time" name="game_time" required></label><br><br><button type="submit">Add Game</button></form><br><a href="/admin">Back to Admin</a></body>
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

      res.send(`<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">
        <title>Set Results</title></head><body><h1>Set Results (Admin)</h1>${html || '<p>No games</p>'}<a href="/admin">Back to Admin</a></body></html>`);
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
    <head>
      <title>Admin Stats</title>
      <link rel="stylesheet" href="/css/style.css">
      <link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">
    </head>
    <body>
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
    </body>
    </html>
  `);
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
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Update User</title></head>
<link rel="icon" type="image/png" href="/favicon-v3.png">
<link rel="apple-touch-icon" href="/favicon-v3.png">      <body><h1>Update User</h1><form action="/update-user" method="POST"><label>Username:<input type="text" name="username" value="${row.username}"></label><br><br><label>Password:<input type="password" name="password" placeholder="Use Change Password page"></label><br><br><button type="submit">Update</button></form></body>
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

async function startServer() {
  try {
    await setupDatabase();
    await ensureAdminUser();

    runAutoSync();
    setInterval(runAutoSync, 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`Server is listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('STARTUP ERROR:', err);
    process.exit(1);
  }
}

startServer();
