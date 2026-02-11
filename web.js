const express = require('express');
const axios = require('axios');
require('dotenv').config();
const path = require('path');
const app = express();
const session = require('express-session');

app.use(express.urlencoded({ extended: true }));

// 세션 설정 (중복 제거)
app.use(session({
  secret: 'discordpanel_secret',
  resave: false,
  saveUninitialized: false
}));

// 1. 로그인 버튼 누르면 디스코드 OAuth2로 이동
app.get('/login', (req, res) => {
  const redirect =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=identify%20guilds`;

  res.redirect(redirect);
});

// 2. 로그인 후 돌아오는 곳
app.get('/callback', async (req, res) => {

    const code = req.query.code;
    if(!code) return res.send("로그인 실패");

    try {

        // 토큰 요청
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.REDIRECT_URI
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const access_token = tokenRes.data.access_token;

        // 유저 정보 가져오기
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        // 세션에 유저 정보 + 액세스 토큰 저장
        req.session.user = userRes.data;
        req.session.access_token = access_token;

        res.redirect('/panel');

    } catch(err){
        console.log(err.response?.data || err);
        res.send("OAuth 오류");
    }
});


app.get('/panel', async (req, res) => {
  if (!req.session.user || !req.session.access_token) {
    return res.redirect('/');
  }

  try {
    // 로그인한 유저가 속한 길드 목록 가져오기
    const guildRes = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.session.access_token}` }
    });

    const guilds = guildRes.data || [];

    // 간단히 모든 길드를 보여주고, 각 길드별로 봇 초대 버튼 제공
    const guildCards = guilds.map(guild => {
      return `
        <div class="guild-card">
          <div class="guild-name">${guild.name}</div>
          <div class="guild-id">ID: ${guild.id}</div>
          <a class="invite-btn" href="/invite/${guild.id}">이 서버에 봇 초대</a>
        </div>
      `;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>디스코드 관리 패널</title>
        <style>
          * {
            box-sizing: border-box;
          }
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
          .title-block {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
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
          .user-name {
            font-weight: 600;
          }
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
          .guild-card:hover::before {
            opacity: 1;
          }
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
            .user-badge {
              align-self: flex-start;
            }
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
          ${guilds.length === 0 ? `<div class="empty-state">표시할 서버가 없습니다. 디스코드에서 서버를 먼저 만들어 주세요.</div>` : ''}

          <div class="footer">
            <span class="brand-mark">Discord Panel</span>
            <a class="logout-link" href="/">로그아웃</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).send('패널 정보를 불러오는 중 오류가 발생했습니다.');
  }
});

  
// HTML 폴더 지정
app.use(express.static(path.join(__dirname, 'views')));

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});


  
app.listen(3000, () => console.log("웹 로그인 서버 실행됨"));
const db = require('./firebase');

// 선택한 서버의 자동 역할 설정 페이지 (기존 기능 유지)
app.get('/server/:id', async (req, res) => {
  const guildId = req.params.id;

  const doc = await db.collection('servers').doc(guildId).get();
  const data = doc.data() || {};

  // 봇 API에서 역할 목록 가져오기
  const roleRes = await axios.get(`http://localhost:4000/api/roles/${guildId}`);
  const roles = roleRes.data;

  let options = '';
  roles.forEach(role => {
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
