require('dotenv').config();
const db = require('./firebase');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const session = require('express-session');

const { Client, GatewayIntentBits } = require('discord.js');

// ===== 디스코드 봇 클라이언트 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('guildCreate', async (guild) => {
  console.log(`새 서버 참가: ${guild.name}`);

  try {
    await db.collection('servers').doc(guild.id).set({
      guildName: guild.name,
      ownerId: guild.ownerId,
      autoRole: null,
      welcomeChannel: null,
      welcomeMessage: '환영합니다!',
      createdAt: new Date(),
    });

    console.log('DB에 서버 등록 완료');
  } catch (err) {
    console.error('DB 저장 실패:', err);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guilds = client.guilds.cache;

  guilds.forEach(async (guild) => {
    const doc = await db.collection('servers').doc(guild.id).get();

    if (!doc.exists) {
      await db.collection('servers').doc(guild.id).set({
        guildName: guild.name,
        ownerId: guild.ownerId,
        autoRole: null,
        welcomeChannel: null,
        welcomeMessage: '환영합니다!',
        createdAt: new Date(),
      });

      console.log(`기존 서버 등록: ${guild.name}`);
    }
  });
});

client.on('guildMemberAdd', (member) => {
  console.log(member.user.username + ' joined');
});

// 토큰은 항상 환경 변수에서만 읽기
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('환경 변수 TOKEN 이 설정되지 않았습니다.');
} else {
  client
    .login(TOKEN)
    .catch((err) => console.error('Discord 로그인 실패:', err));
}

// ===== 봇 내부 API + 웹 패널 서버 =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 세션 및 정적 파일
app.use(session({
  secret: 'discordpanel_secret',
  resave: false,
  saveUninitialized: false,
}));
app.use(express.static(path.join(__dirname, 'views')));

// 메인 페이지: 고급 로그인 UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// 디스코드 OAuth 로그인
app.get('/login', (req, res) => {
  const redirect =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=identify%20guilds`;

  res.redirect(redirect);
});

// OAuth 콜백
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('로그인 실패: code 누락');

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    const access_token = tokenRes.data.access_token;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    req.session.user = userRes.data;
    req.session.access_token = access_token;

    res.redirect('/panel');
  } catch (err) {
    const discordError = err.response?.data;
    console.error('Discord OAuth 오류:', discordError || err);

    if (discordError) {
      return res.status(500).send(
        `OAuth 오류<br><pre>${JSON.stringify(discordError, null, 2)}</pre>`,
      );
    }

    res.status(500).send('OAuth 오류: 알 수 없는 에러가 발생했습니다.');
  }
});

// 길드 선택 패널
app.get('/panel', async (req, res) => {
  if (!req.session.user || !req.session.access_token) {
    return res.redirect('/');
  }

  try {
    const guildRes = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.session.access_token}` },
    });

    const allGuilds = guildRes.data || [];

    // 관리자/서버 관리 권한이 있는 길드만 필터링
    const managedGuilds = allGuilds.filter((guild) => {
      try {
        const perms = BigInt(guild.permissions ?? '0');
        const ADMIN = 0x00000008n;
        const MANAGE_GUILD = 0x00000020n;
        return guild.owner || (perms & (ADMIN | MANAGE_GUILD)) !== 0n;
      } catch {
        return guild.owner === true;
      }
    });

    // DB 기준으로 "봇이 참가해 있는 서버" 판별 (guildCreate / ready 에서만 기록됨)
    const joinedServerDocs = await Promise.all(
      managedGuilds.map((g) => db.collection('servers').doc(g.id).get()),
    );
    const joinedServerIdSet = new Set(
      joinedServerDocs.filter((doc) => doc.exists).map((doc) => doc.id),
    );

    const guildCards = managedGuilds
      .map((guild) => {
        const botInGuild = joinedServerIdSet.has(guild.id);

        const actionButton = botInGuild
          ? `<a class="invite-btn manage-btn" href="/server/${guild.id}">이 서버 관리하기</a>`
          : `<a class="invite-btn" href="/invite/${guild.id}">이 서버에 봇 초대</a>`;

        const statusBadge = botInGuild
          ? '<span class="guild-status guild-status--active">봇 연결됨</span>'
          : '<span class="guild-status guild-status--inactive">봇 미초대</span>';

        return `
        <div class="guild-card">
          <div>
            <div class="guild-name">${guild.name}</div>
            <div class="guild-id">ID: ${guild.id}</div>
          </div>
          <div class="guild-footer">
            ${statusBadge}
            ${actionButton}
          </div>
        </div>
      `;
      })
      .join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>디스코드 관리 패널</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(circle at top left, #5865f2 0, #111827 40%, #020617 100%);
            color: #e5e7eb;
          }
          .container {
            width: 100%;
            max-width: 1100px;
            padding: 40px 32px 32px;
            border-radius: 24px;
            background: rgba(15, 23, 42, 0.85);
            box-shadow:
              0 20px 60px rgba(0, 0, 0, 0.6),
              0 0 0 1px rgba(148, 163, 184, 0.15);
            backdrop-filter: blur(20px);
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;
            margin-bottom: 28px;
          }
          .title-block { display: flex; flex-direction: column; gap: 6px; }
          .title {
            font-size: 26px;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
          .subtitle {
            font-size: 14px;
            color: #9ca3af;
          }
          .user-badge {
            padding: 10px 16px;
            border-radius: 999px;
            background: linear-gradient(135deg, rgba(88, 101, 242, 0.15), rgba(37, 99, 235, 0.3));
            border: 1px solid rgba(129, 140, 248, 0.5);
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
          }
          .user-dot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            background: #22c55e;
            box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.15);
          }
          .user-name { font-weight: 600; }
          .guild-section-title {
            font-size: 15px;
            font-weight: 600;
            color: #9ca3af;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            margin-bottom: 14px;
          }
          .guild-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 18px;
          }
          .guild-card {
            position: relative;
            padding: 16px 16px 18px;
            border-radius: 18px;
            background: radial-gradient(circle at top left, rgba(148, 163, 184, 0.18), rgba(15, 23, 42, 0.9));
            border: 1px solid rgba(148, 163, 184, 0.25);
            box-shadow:
              0 10px 30px rgba(15, 23, 42, 0.9),
              0 0 0 1px rgba(15, 23, 42, 0.6) inset;
            display: flex;
            flex-direction: column;
            gap: 10px;
            transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
          }
          .guild-card::before {
            content: "";
            position: absolute;
            inset: 0;
            border-radius: inherit;
            background: radial-gradient(circle at top, rgba(248, 250, 252, 0.18), transparent 60%);
            opacity: 0;
            transition: opacity 0.18s ease;
            pointer-events: none;
          }
          .guild-card:hover {
            transform: translateY(-4px) translateZ(0);
            border-color: rgba(129, 140, 248, 0.7);
            box-shadow:
              0 16px 40px rgba(15, 23, 42, 0.95),
              0 0 40px rgba(59, 130, 246, 0.3);
          }
          .guild-card:hover::before { opacity: 1; }
          .guild-name {
            font-size: 16px;
            font-weight: 600;
            color: #e5e7eb;
            text-overflow: ellipsis;
            white-space: nowrap;
            overflow: hidden;
          }
          .guild-id {
            font-size: 11px;
            color: #9ca3af;
          }
          .guild-footer {
            margin-top: 8px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
          }
          .guild-status {
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 500;
          }
          .guild-status--active {
            background: rgba(34, 197, 94, 0.12);
            color: #4ade80;
            border: 1px solid rgba(34, 197, 94, 0.5);
          }
          .guild-status--inactive {
            background: rgba(148, 163, 184, 0.12);
            color: #e5e7eb;
            border: 1px dashed rgba(148, 163, 184, 0.7);
          }
          .invite-btn {
            margin-top: 10px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 8px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            text-decoration: none;
            color: #f9fafb;
            background: linear-gradient(135deg, #4f46e5, #6366f1);
            box-shadow:
              0 10px 30px rgba(79, 70, 229, 0.55),
              0 0 0 1px rgba(129, 140, 248, 0.8);
            transition: background 0.18s ease, transform 0.1s ease, box-shadow 0.18s ease;
          }
          .manage-btn {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            box-shadow:
              0 10px 30px rgba(34, 197, 94, 0.55),
              0 0 0 1px rgba(74, 222, 128, 0.8);
          }
          .manage-btn:hover {
            background: linear-gradient(135deg, #16a34a, #15803d);
            box-shadow:
              0 16px 35px rgba(34, 197, 94, 0.8),
              0 0 0 1px rgba(134, 239, 172, 0.9);
          }
          .invite-btn:hover {
            background: linear-gradient(135deg, #4338ca, #4f46e5);
            transform: translateY(-1px);
            box-shadow:
              0 16px 35px rgba(79, 70, 229, 0.8),
              0 0 0 1px rgba(165, 180, 252, 0.9);
          }
          .invite-btn:active {
            transform: translateY(0);
            box-shadow:
              0 8px 20px rgba(79, 70, 229, 0.6),
              0 0 0 1px rgba(129, 140, 248, 0.8);
          }
          .empty-state {
            margin-top: 12px;
            font-size: 13px;
            color: #9ca3af;
          }
          .footer {
            margin-top: 26px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #6b7280;
          }
          .brand-mark {
            letter-spacing: 0.18em;
            text-transform: uppercase;
          }
          .logout-link {
            color: #9ca3af;
            text-decoration: none;
          }
          .logout-link:hover {
            color: #e5e7eb;
          }
          @media (max-width: 640px) {
            .container {
              margin: 16px;
              padding: 24px 18px 20px;
              border-radius: 20px;
            }
            .header {
              flex-direction: column;
              align-items: flex-start;
            }
            .user-badge { align-self: flex-start; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title-block">
              <div class="title">디스코드 관리 패널</div>
              <div class="subtitle">봇을 초대할 서버를 선택하세요.</div>
            </div>
            <div class="user-badge">
              <div class="user-dot"></div>
              <span class="user-name">${req.session.user.username}#${req.session.user.discriminator}</span>
              <span style="opacity:.7;">로 로그인</span>
            </div>
          </div>

          <div class="guild-section-title">Your Discord Servers</div>
          <div class="guild-grid">
            ${guildCards || ''}
          </div>
          ${
            managedGuilds.length === 0
              ? `<div class="empty-state">표시할 서버가 없습니다. 디스코드에서 관리자 권한이 있는 서버만 표시됩니다.</div>`
              : ''
          }

          <div class="footer">
            <span class="brand-mark">Discord Panel</span>
            <a class="logout-link" href="/">로그아웃</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    const apiError = err.response?.data;
    console.error('패널 길드 목록 로딩 오류:', apiError || err);

    if (apiError) {
      return res
        .status(500)
        .send(
          `패널 정보를 불러오는 중 오류가 발생했습니다.<br><pre>${JSON.stringify(
            apiError,
            null,
            2,
          )}</pre>`,
        );
    }

    res.status(500).send('패널 정보를 불러오는 중 알 수 없는 오류가 발생했습니다.');
  }
});

// 자동 역할 설정 페이지
app.get('/server/:id', async (req, res) => {
  const guildId = req.params.id;

  const doc = await db.collection('servers').doc(guildId).get();
  const data = doc.data() || {};

  try {
    const guild = await client.guilds.fetch(guildId);
    const roles = await guild.roles.fetch();

    let options = '';
    roles
      .filter((role) => role.name !== '@everyone')
      .forEach((role) => {
        const selected = data.autoRole === role.id ? 'selected' : '';
        options += `<option value="${role.id}" ${selected}>${role.name}</option>`;
      });

    res.send(`
      <h2>자동 역할 설정</h2>
      <form method="POST" action="/server/${guildId}/autorole">
        <select name="roleId">
          ${options}
        </select>
        <button type="submit">저장</button>
      </form>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('역할 정보를 불러오는 중 오류가 발생했습니다.');
  }
});

// 자동 역할 POST 저장
app.post('/server/:id/autorole', async (req, res) => {
  const guildId = req.params.id;
  const roleId = req.body.roleId;

  await db.collection('servers').doc(guildId).set(
    {
      autoRole: roleId,
    },
    { merge: true },
  );

  res.send('저장 완료! 이제 새 유저가 들어오면 역할이 지급됩니다.');
});

// 길드 선택 후 해당 서버로 봇 초대
app.get('/invite/:guildId', (req, res) => {
  const guildId = req.params.guildId;

  const inviteUrl =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&permissions=8` +
    `&scope=bot%20applications.commands` +
    `&guild_id=${guildId}` +
    `&disable_guild_select=true`;

  res.redirect(inviteUrl);
});

// 역할 목록 요청 (기존 API 엔드포인트 유지)
app.get('/api/roles/:guildId', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    const roles = await guild.roles.fetch();

    const roleList = roles
      .filter((role) => role.name !== '@everyone')
      .map((role) => ({
        id: role.id,
        name: role.name,
      }));

    res.json(roleList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '역할 가져오기 실패' });
  }
});

// PaaS 환경을 위한 HTTP 서버 (PORT 사용)
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`웹 서버 실행됨: ${PORT}`);
});