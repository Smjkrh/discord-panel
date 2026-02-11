require('dotenv').config();
const db = require('./firebase');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const session = require('express-session');

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

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

client.on('guildMemberAdd', async (member) => {
  console.log(member.user.username + ' joined');

  try {
    const doc = await db.collection('servers').doc(member.guild.id).get();
    const data = doc.data();
    if (!data) return;

    // 자동 역할 지급
    if (data.autoRole) {
      const role = member.guild.roles.cache.get(data.autoRole);
      if (role) {
        await member.roles.add(role).catch((err) => {
          console.error('자동 역할 지급 실패:', err);
        });
      }
    }

    // 환영 메시지 전송
    if (data.welcomeChannel) {
      const channel = member.guild.channels.cache.get(data.welcomeChannel);
      if (channel && channel.type === ChannelType.GuildText) {
        const rawMessage = data.welcomeMessage || '환영합니다!';
        const content = rawMessage.replace('{user}', `<@${member.id}>`);

        await channel.send({ content }).catch((err) => {
          console.error('환영 메시지 전송 실패:', err);
        });
      }
    }
  } catch (err) {
    console.error('guildMemberAdd 처리 중 오류:', err);
  }
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

  try {
    // 먼저 DB에서 설정값 조회
    const doc = await db.collection('servers').doc(guildId).get();
    const data = doc.data() || {};

    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (fetchErr) {
      throw new Error(`서버 정보를 가져올 수 없습니다: ${fetchErr.message}`);
    }

    let roles;
    try {
      roles = await guild.roles.fetch();
    } catch (rolesErr) {
      throw new Error(`역할 목록을 가져올 수 없습니다: ${rolesErr.message}`);
    }

    let channels;
    try {
      channels = await guild.channels.fetch();
    } catch (channelsErr) {
      throw new Error(`채널 목록을 가져올 수 없습니다: ${channelsErr.message}`);
    }

    let roleOptions = '';
    roles
      .filter((role) => role.name !== '@everyone')
      .forEach((role) => {
        const selected = data.autoRole === role.id ? 'selected' : '';
        roleOptions += `<option value="${role.id}" ${selected}>${role.name}</option>`;
      });

    const textChannels = [];
    channels.forEach((ch) => {
      if (ch && ch.type === ChannelType.GuildText) {
        textChannels.push(ch);
      }
    });

    let channelOptions = '<option value="">선택 안 함</option>';
    textChannels.forEach((ch) => {
      const selected = data.welcomeChannel === ch.id ? 'selected' : '';
      channelOptions += `<option value="${ch.id}" ${selected}>#${ch.name}</option>`;
    });

    const welcomeMessageValue = (data.welcomeMessage || '환영합니다, {user}님!').replace(
      /"/g,
      '&quot;',
    );

    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>${guild.name} - 서버 관리</title>
        <style>
          body {
            margin: 0;
            padding: 32px 16px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: radial-gradient(circle at top left, #4f46e5 0, #020617 45%, #000000 100%);
            color: #e5e7eb;
            display: flex;
            justify-content: center;
          }
          .panel {
            width: 100%;
            max-width: 800px;
            background: rgba(15, 23, 42, 0.9);
            border-radius: 24px;
            padding: 28px 24px 24px;
            box-shadow:
              0 20px 60px rgba(0, 0, 0, 0.8),
              0 0 0 1px rgba(148, 163, 184, 0.35);
          }
          h1 {
            font-size: 22px;
            margin: 0 0 4px 0;
          }
          .subtitle {
            font-size: 13px;
            color: #9ca3af;
            margin-bottom: 20px;
          }
          .section {
            margin-top: 18px;
            padding-top: 16px;
            border-top: 1px solid rgba(31, 41, 55, 1);
          }
          .section-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
          }
          label {
            display: block;
            font-size: 12px;
            color: #9ca3af;
            margin-bottom: 4px;
          }
          select, textarea {
            width: 100%;
            border-radius: 10px;
            border: 1px solid rgba(55, 65, 81, 1);
            background: rgba(15, 23, 42, 0.95);
            color: #e5e7eb;
            padding: 8px 10px;
            font-size: 13px;
            outline: none;
          }
          textarea {
            min-height: 80px;
            resize: vertical;
          }
          select:focus, textarea:focus {
            border-color: rgba(129, 140, 248, 1);
            box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.7);
          }
          .hint {
            margin-top: 4px;
            font-size: 11px;
            color: #6b7280;
          }
          .actions {
            margin-top: 22px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .save-btn {
            padding: 8px 18px;
            border-radius: 999px;
            border: none;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            color: #f9fafb;
            background: linear-gradient(135deg, #4f46e5, #6366f1);
            box-shadow:
              0 12px 30px rgba(88, 101, 242, 0.7),
              0 0 0 1px rgba(165, 180, 252, 0.9);
          }
          .save-btn:hover {
            background: linear-gradient(135deg, #4338ca, #4f46e5);
          }
          .back-link {
            font-size: 12px;
            color: #9ca3af;
            text-decoration: none;
          }
          .back-link:hover {
            color: #e5e7eb;
          }
        </style>
      </head>
      <body>
        <div class="panel">
          <h1>${guild.name} 서버 관리</h1>
          <div class="subtitle">자동 역할, 환영 채널, 환영 메시지를 설정합니다.</div>

          <form method="POST" action="/server/${guildId}/autorole">
            <div class="section">
              <div class="section-title">자동 역할 설정</div>
              <label for="roleId">서버에 새로 들어온 유저에게 부여할 역할</label>
              <select id="roleId" name="roleId">
                <option value="">선택 안 함</option>
                ${roleOptions}
              </select>
              <div class="hint">역할을 선택하면 새 유저가 들어올 때 자동으로 이 역할이 부여됩니다.</div>
            </div>

            <div class="section">
              <div class="section-title">환영 채널</div>
              <label for="welcomeChannel">환영 메시지를 보낼 텍스트 채널</label>
              <select id="welcomeChannel" name="welcomeChannel">
                ${channelOptions}
              </select>
              <div class="hint">선택 안 함을 고르면 환영 메시지를 보내지 않습니다.</div>
            </div>

            <div class="section">
              <div class="section-title">환영 메시지</div>
              <label for="welcomeMessage">새 유저에게 보낼 메시지</label>
              <textarea id="welcomeMessage" name="welcomeMessage">${welcomeMessageValue}</textarea>
              <div class="hint">{user} 를 사용하면 유저 멘션으로 치환됩니다. 예: "환영합니다, {user}님!"</div>
            </div>

            <div class="actions">
              <a class="back-link" href="/panel">← 서버 리스트로 돌아가기</a>
              <div style="display:flex;gap:8px;align-items:center;">
                <button type="submit" class="save-btn">설정 저장</button>
                <form method="POST" action="/server/${guildId}/kick-bot" onsubmit="return confirm('정말 이 서버에서 봇을 추방하시겠습니까?');">
                  <button type="submit" class="save-btn" style="background:linear-gradient(135deg,#ef4444,#b91c1c);box-shadow:0 12px 30px rgba(239,68,68,.7),0 0 0 1px rgba(254,202,202,0.9);">
                    봇 추방하기
                  </button>
                </form>
              </div>
            </div>
          </form>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    const apiError = err.response?.data;
    const errorMessage = err.message || String(err);
    const errorCode = apiError?.code || err.code || 'UNKNOWN';
    
    console.error('서버 관리 페이지 로딩 오류:', {
      error: apiError || err,
      message: errorMessage,
      code: errorCode,
      stack: err.stack,
    });

    // 디스코드에서 Unknown Guild / Missing Access 인 경우
    if (apiError && (apiError.code === 10004 || apiError.code === 50001)) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8" />
          <title>서버 관리 불가</title>
        </head>
        <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
          <div style="max-width:480px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
            <h2 style="margin:0 0 8px 0;font-size:20px;">역할 정보를 불러올 수 없습니다</h2>
            <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
              디스코드에서 이 서버에 대한 권한이 없다고 응답했습니다.<br/>
              - 봇이 해당 서버에 초대되어 있는지<br/>
              - 봇에 필요한 권한(역할 보기/관리)이 있는지<br/>
              를 확인한 뒤 다시 시도해주세요.
            </p>
            <details style="margin-top:12px;padding:10px;background:#0f172a;border-radius:8px;font-size:11px;color:#6b7280;">
              <summary style="cursor:pointer;color:#9ca3af;">에러 상세 정보</summary>
              <pre style="margin-top:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">${JSON.stringify(apiError || { message: errorMessage, code: errorCode }, null, 2)}</pre>
            </details>
            <a href="/panel" style="display:inline-block;margin-top:14px;font-size:13px;color:#a5b4fc;text-decoration:none;">← 서버 목록으로 돌아가기</a>
          </div>
        </body>
        </html>
      `);
    }

    // 기타 알 수 없는 오류 - 실제 에러 내용 표시
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>서버 관리 오류</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:600px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">역할 정보를 불러오는 중 오류가 발생했습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            아래 에러 정보를 확인해주세요. 문제가 계속되면 이 정보를 개발자에게 알려주세요.
          </p>
          <details style="margin-top:12px;padding:12px;background:#0f172a;border-radius:8px;font-size:11px;color:#6b7280;border:1px solid rgba(31,41,55,1);" open>
            <summary style="cursor:pointer;color:#9ca3af;font-weight:600;margin-bottom:8px;">에러 상세 정보</summary>
            <div style="margin-top:8px;">
              <div style="margin-bottom:6px;"><strong style="color:#e5e7eb;">에러 코드:</strong> <code style="background:#1e293b;padding:2px 6px;border-radius:4px;">${errorCode}</code></div>
              <div style="margin-bottom:6px;"><strong style="color:#e5e7eb;">에러 메시지:</strong> <code style="background:#1e293b;padding:2px 6px;border-radius:4px;">${errorMessage}</code></div>
              ${apiError ? `<div style="margin-top:8px;"><strong style="color:#e5e7eb;">Discord API 응답:</strong><pre style="margin-top:4px;padding:8px;background:#1e293b;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:10px;">${JSON.stringify(apiError, null, 2)}</pre></div>` : ''}
            </div>
          </details>
          <a href="/panel" style="display:inline-block;margin-top:14px;font-size:13px;color:#a5b4fc;text-decoration:none;">← 서버 목록으로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  }
});

// 자동 역할 POST 저장
app.post('/server/:id/autorole', async (req, res) => {
  const guildId = req.params.id;
  const { roleId, welcomeChannel, welcomeMessage } = req.body;

  await db.collection('servers').doc(guildId).set(
    {
      autoRole: roleId || null,
      welcomeChannel: welcomeChannel || null,
      welcomeMessage: welcomeMessage || '환영합니다, {user}님!',
    },
    { merge: true },
  );

  res.send('저장 완료! 이제 새 유저가 들어오면 역할 및 환영 메시지가 적용됩니다.');
});

// 서버에서 봇 추방하기
app.post('/server/:id/kick-bot', async (req, res) => {
  const guildId = req.params.id;

  try {
    const guild = await client.guilds.fetch(guildId);

    await guild.leave();

    return res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>봇 추방 완료</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:480px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">봇을 서버에서 추방했습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            서버 리스트에서 더 이상 이 서버는 "봇 연결됨" 상태로 표시되지 않습니다.
          </p>
          <a href="/panel" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 서버 목록으로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('봇 추방 실패:', err);
    return res.status(500).send('봇을 추방하는 중 오류가 발생했습니다.');
  }
});

// 길드 선택 후 해당 서버로 봇 초대
app.get('/invite/:guildId', (req, res) => {
  const guildId = req.params.guildId;

  // REDIRECT_URI 가 ".../callback" 형식이면 같은 도메인의 /invite/callback 으로 리다이렉트
  let inviteRedirect = '';
  if (process.env.REDIRECT_URI) {
    inviteRedirect = process.env.REDIRECT_URI.replace(/\/callback$/, '/invite/callback');
  }

  const inviteUrl =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&permissions=8` +
    `&scope=bot%20applications.commands` +
    `&guild_id=${guildId}` +
    `&disable_guild_select=true` +
    (inviteRedirect
      ? `&redirect_uri=${encodeURIComponent(inviteRedirect)}&response_type=code`
      : '');

  res.redirect(inviteUrl);
});

// 봇 초대 이후 돌아오는 곳: 바로 패널로 이동
app.get('/invite/callback', (req, res) => {
  return res.redirect('/panel');
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