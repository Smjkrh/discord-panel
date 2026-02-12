require('dotenv').config();
const db = require('./firebase');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const session = require('express-session');

const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

// ===== 디스코드 봇 클라이언트 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// 봇 준비 상태 추적
let botReady = false;

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

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  botReady = true;

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

// 욕설 / 링크 필터링
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const doc = await db.collection('servers').doc(message.guild.id).get();
    const data = doc.data();
    if (!data) return;

    const content = message.content || '';
    const lower = content.toLowerCase();

    // 욕설 필터
    if (Array.isArray(data.badWords) && data.badWords.length > 0) {
      const hasBad = data.badWords.some((w) => w && lower.includes(String(w).toLowerCase()));
      if (hasBad) {
        await message.delete().catch(() => {});
        return;
      }
    }

    // 링크 필터
    if (data.blockLinks) {
      const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
      const urls = content.match(urlRegex);
      if (urls && urls.length > 0) {
        const whitelist = Array.isArray(data.linkWhitelist)
          ? data.linkWhitelist.map((d) => String(d).toLowerCase())
          : [];

        let blocked = false;

        for (const raw of urls) {
          let href = raw;
          if (!/^https?:\/\//i.test(href)) {
            href = 'http://' + href;
          }
          try {
            const u = new URL(href);
            const host = u.hostname.toLowerCase();
            const allowed =
              whitelist.length === 0
                ? false
                : whitelist.some((d) => host === d || host.endsWith('.' + d));
            if (!allowed) {
              blocked = true;
              break;
            }
          } catch {
            blocked = true;
            break;
          }
        }

        if (blocked) {
          await message.delete().catch(() => {});
          return;
        }
      }
    }
  } catch (err) {
    console.error('messageCreate 필터 처리 중 오류:', err);
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

// 규칙 동의 / 인증 페이지
app.get('/verify/:guildId', async (req, res) => {
  const guildId = req.params.guildId;

  if (!req.session.user || !req.session.access_token) {
    return res.redirect(
      `/login?from=${encodeURIComponent(`/verify/${guildId}`)}`,
    );
  }

  try {
    const doc = await db.collection('servers').doc(guildId).get();
    const data = doc.data() || {};

    if (!data.verifyRole) {
      return res.send('관리자가 아직 인증 역할을 설정하지 않았습니다.');
    }

    const rulesHtml = (data.rulesText || '서버 규칙을 읽고 동의해 주세요.')
      .replace(/\n/g, '<br/>');

    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>서버 인증 - ${guildId}</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(circle at top left, #4f46e5 0, #020617 45%, #000000 100%);
            color: #e5e7eb;
          }
          .panel {
            max-width: 560px;
            width: 100%;
            padding: 26px 22px 22px;
            border-radius: 24px;
            background: rgba(15, 23, 42, 0.95);
            box-shadow:
              0 20px 60px rgba(0, 0, 0, 0.9),
              0 0 0 1px rgba(148, 163, 184, 0.35);
          }
          h1 {
            margin: 0 0 10px;
            font-size: 22px;
          }
          .subtitle {
            font-size: 13px;
            color: #9ca3af;
            margin-bottom: 18px;
          }
          .rules {
            font-size: 13px;
            line-height: 1.6;
            padding: 12px 12px;
            border-radius: 14px;
            background: rgba(15, 23, 42, 1);
            border: 1px solid rgba(31, 41, 55, 1);
            max-height: 260px;
            overflow-y: auto;
          }
          .actions {
            margin-top: 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: #9ca3af;
          }
          .btn {
            padding: 8px 18px;
            border-radius: 999px;
            border: none;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            color: #f9fafb;
            background: linear-gradient(135deg, #22c55e, #16a34a);
            box-shadow:
              0 12px 30px rgba(34, 197, 94, 0.7),
              0 0 0 1px rgba(74, 222, 128, 0.9);
          }
          .btn:hover {
            background: linear-gradient(135deg, #16a34a, #15803d);
          }
          a {
            color: #9ca3af;
            text-decoration: none;
          }
          a:hover {
            color: #e5e7eb;
          }
        </style>
      </head>
      <body>
        <div class="panel">
          <h1>서버 규칙 동의</h1>
          <div class="subtitle">아래 규칙을 읽고 동의하면 인증 역할이 부여됩니다.</div>
          <div class="rules">
            ${rulesHtml}
          </div>
          <form method="POST" action="/verify/${guildId}">
            <div class="actions">
              <span>${req.session.user.username}#${req.session.user.discriminator} 로 로그인됨</span>
              <button type="submit" class="btn">규칙에 동의하고 인증 받기</button>
            </div>
          </form>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('verify 페이지 로딩 오류:', err);
    return res.status(500).send('인증 페이지를 불러오는 중 오류가 발생했습니다.');
  }
});

app.post('/verify/:guildId', async (req, res) => {
  const guildId = req.params.guildId;

  if (!req.session.user || !req.session.access_token) {
    return res.redirect(
      `/login?from=${encodeURIComponent(`/verify/${guildId}`)}`,
    );
  }

  if (!botReady) {
    return res.status(503).send('봇이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
  }

  try {
    const doc = await db.collection('servers').doc(guildId).get();
    const data = doc.data() || {};

    if (!data.verifyRole) {
      return res.send('관리자가 아직 인증 역할을 설정하지 않았습니다.');
    }

    const guild = await client.guilds.fetch(guildId);
    let member;
    try {
      member = await guild.members.fetch(req.session.user.id);
    } catch (e) {
      return res
        .status(404)
        .send('이 서버에서 해당 디스코드 유저를 찾을 수 없습니다. 서버에 먼저 들어와 주세요.');
    }

    const role = guild.roles.cache.get(data.verifyRole);
    if (!role) {
      return res.status(500).send('설정된 인증 역할을 찾을 수 없습니다.');
    }

    await member.roles.add(role);

    return res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>인증 완료</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:520px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">인증이 완료되었습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            해당 서버에서 인증 역할이 부여되었습니다. 이제 채팅 및 기능을 사용할 수 있습니다.
          </p>
          <a href="/panel" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 패널로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('verify 처리 오류:', err);
    return res.status(500).send('인증 처리 중 오류가 발생했습니다.');
  }
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

  // 봇이 아직 준비되지 않았으면 안내
  if (!botReady) {
    return res.status(503).send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>봇 준비 중</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:480px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">봇이 아직 준비되지 않았습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            디스코드 봇이 로그인 중이거나 재시작 중입니다.<br/>
            잠시 후(약 5-10초) 다시 시도해주세요.
          </p>
          <a href="/panel" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 서버 목록으로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    // 먼저 DB에서 설정값 조회
    const doc = await db.collection('servers').doc(guildId).get();
    const data = doc.data() || {};

    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (fetchErr) {
      // 토큰 관련 에러인 경우 특별 처리
      if (fetchErr.message.includes('token') || fetchErr.message.includes('Expected token')) {
        throw new Error(`봇이 아직 로그인되지 않았습니다. 잠시 후 다시 시도해주세요. (원본: ${fetchErr.message})`);
      }
      // Unknown Guild 에러인 경우 - 봇이 서버에 없음
      if (fetchErr.message.includes('Unknown Guild') || fetchErr.code === 10004) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html lang="ko">
          <head>
            <meta charset="UTF-8" />
            <title>서버를 찾을 수 없음</title>
          </head>
          <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
            <div style="max-width:520px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
              <h2 style="margin:0 0 8px 0;font-size:20px;">봇이 이 서버에 없습니다</h2>
              <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
                이 서버에 패널 봇이 초대되어 있지 않거나, 봇이 추방되었습니다.<br/>
                서버 관리 기능을 사용하려면 먼저 봇을 초대해주세요.
              </p>
              <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
                <a href="/invite/${guildId}" style="display:inline-block;padding:8px 16px;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none;color:#f9fafb;background:linear-gradient(135deg,#4f46e5,#6366f1);box-shadow:0 10px 30px rgba(79,70,229,0.55),0 0 0 1px rgba(129,140,248,0.8);">
                  봇 초대하기
                </a>
                <a href="/panel" style="display:inline-block;padding:8px 16px;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none;color:#9ca3af;border:1px solid rgba(148,163,184,0.5);">
                  서버 목록으로
                </a>
              </div>
            </div>
          </body>
          </html>
        `);
      }
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

    let autoRoleOptions = '';
    let verifyRoleOptions = '<option value="">선택 안 함</option>';
    roles
      .filter((role) => role.name !== '@everyone')
      .forEach((role) => {
        const selectedAuto = data.autoRole === role.id ? 'selected' : '';
        autoRoleOptions += `<option value="${role.id}" ${selectedAuto}>${role.name}</option>`;

        const selectedVerify = data.verifyRole === role.id ? 'selected' : '';
        verifyRoleOptions += `<option value="${role.id}" ${selectedVerify}>${role.name}</option>`;
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
    const rulesTextValue = (data.rulesText || '서버 규칙을 읽고 동의해 주세요.').replace(/"/g, '&quot;');
    const filterWordsValue = (Array.isArray(data.badWords) ? data.badWords.join(', ') : '').replace(
      /"/g,
      '&quot;',
    );
    const linkWhitelistValue = (Array.isArray(data.linkWhitelist)
      ? data.linkWhitelist.join(', ')
      : ''
    ).replace(/"/g, '&quot;');
    const blockLinksChecked = data.blockLinks ? 'checked' : '';

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
          select, textarea, input[type="text"] {
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
          select:focus, textarea:focus, input[type="text"]:focus {
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
          <div class="subtitle">자동 역할, 환영 / 보안 / 필터링 설정을 관리합니다.</div>

          <form method="POST" action="/server/${guildId}/autorole">
            <div class="section">
              <div class="section-title">자동 역할 설정</div>
              <label for="roleId">서버에 새로 들어온 유저에게 부여할 역할</label>
              <select id="roleId" name="roleId">
                <option value="">선택 안 함</option>
                ${autoRoleOptions}
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

            <div class="section">
              <div class="section-title">규칙 동의 / 인증 역할</div>
              <label for="verifyRole">규칙에 동의한 유저에게 부여할 역할</label>
              <select id="verifyRole" name="verifyRole">
                ${verifyRoleOptions}
              </select>
              <div class="hint">예: "인증됨", "일반 회원" 등. 설정 후, /verify 링크를 통해 유저가 웹에서 동의하면 이 역할이 부여됩니다.</div>

              <label for="rulesText" style="margin-top:10px;">서버 규칙 / 안내 문구</label>
              <textarea id="rulesText" name="rulesText">${rulesTextValue}</textarea>
              <div class="hint">이 문구는 /verify 페이지에서 유저에게 보여집니다.</div>
            </div>

            <div class="section">
              <div class="section-title">욕설 / 링크 필터링</div>
              <label for="filterWords">금지 단어 목록 (쉼표로 구분)</label>
              <input id="filterWords" name="filterWords" type="text" placeholder="예: 욕1, 욕2, 금지어" value="${filterWordsValue}" />
              <div class="hint">메시지에 포함되면 자동 삭제됩니다. 대소문자 구분 없이 검색합니다.</div>

              <label style="margin-top:10px;">
                <input type="checkbox" name="blockLinks" value="1" ${blockLinksChecked} />
                링크 차단 (화이트리스트에 없는 도메인 자동 삭제)
              </label>

              <label for="linkWhitelist" style="margin-top:8px;">허용 도메인 목록 (쉼표로 구분)</label>
              <input id="linkWhitelist" name="linkWhitelist" type="text" placeholder="예: youtube.com, discord.com" value="${linkWhitelistValue}" />
              <div class="hint">예: youtube.com, discord.com 등. 비워두면 모든 링크를 차단합니다.</div>
            </div>

            <div class="actions">
              <a class="back-link" href="/panel">← 서버 리스트로 돌아가기</a>
              <div style="display:flex;gap:8px;align-items:center;">
                <button type="submit" class="save-btn">설정 저장</button>
                <a
                  href="/server/${guildId}/moderation"
                  class="save-btn"
                  style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;"
                >
                  모더레이션 패널
                </a>
              </div>
            </div>
          </form>

          <form method="POST" action="/server/${guildId}/kick-bot" onsubmit="return confirm('정말 이 서버에서 봇을 추방하시겠습니까?');" style="margin-top:16px;text-align:right;">
            <button type="submit" class="save-btn" style="background:linear-gradient(135deg,#ef4444,#b91c1c);box-shadow:0 12px 30px rgba(239,68,68,.7),0 0 0 1px rgba(254,202,202,0.9);">
              봇 추방하기
            </button>
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
  const {
    roleId,
    welcomeChannel,
    welcomeMessage,
    verifyRole,
    rulesText,
    filterWords,
    blockLinks,
    linkWhitelist,
  } = req.body;

  await db.collection('servers').doc(guildId).set(
    {
      autoRole: roleId || null,
      welcomeChannel: welcomeChannel || null,
      welcomeMessage: welcomeMessage || '환영합니다, {user}님!',
      verifyRole: verifyRole || null,
      rulesText: rulesText || null,
      badWords: filterWords
        ? filterWords
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [],
      blockLinks: !!blockLinks,
      linkWhitelist: linkWhitelist
        ? linkWhitelist
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0)
        : [],
    },
    { merge: true },
  );

  res.send('저장 완료! 이제 새 유저가 들어오면 역할 및 환영 메시지가 적용됩니다.');
});

// 서버에서 봇 추방하기
app.post('/server/:id/kick-bot', async (req, res) => {
  const guildId = req.params.id;

  if (!botReady) {
    return res.status(503).send('봇이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
  }

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

// ===== 서버 모더레이션 패널 =====
app.get('/server/:id/moderation', async (req, res) => {
  const guildId = req.params.id;

  if (!req.session.user || !req.session.access_token) {
    return res.redirect('/');
  }

  if (!botReady) {
    return res.status(503).send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>봇 준비 중</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:520px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">봇이 아직 준비되지 않았습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            디스코드 봇이 로그인 중이거나 재시작 중입니다.<br/>
            잠시 후(약 5-10초) 다시 시도해주세요.
          </p>
          <a href="/panel" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 서버 목록으로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    const roles = await guild.roles.fetch();

    // 멤버 전체를 한 번에 가져오면 게이트웨이 레이트리밋(opcode 8)에 걸릴 수 있으므로
    // 최대 50명까지만 청크로 가져오고, 실패 시 캐시만 사용
    let members;
    try {
      members = await guild.members.fetch({ limit: 50 });
    } catch (chunkErr) {
      console.error('멤버 목록 청크 로딩 실패, 캐시로 대체:', chunkErr);
      members = guild.members.cache;
    }

    let roleOptions = '<option value="">역할 선택</option>';
    roles
      .filter((role) => role.name !== '@everyone')
      .forEach((role) => {
        roleOptions += `<option value="${role.id}">${role.name}</option>`;
      });

    // 최근 경고 20개 조회
    const warningsSnap = await db
      .collection('servers')
      .doc(guildId)
      .collection('warnings')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    let warningRows = '';
    warningsSnap.forEach((doc) => {
      const w = doc.data();
      let createdAtText = '';
      if (w.createdAt) {
        const d = w.createdAt.toDate ? w.createdAt.toDate() : w.createdAt;
        if (d && d.toISOString) {
          createdAtText = d.toISOString().replace('T', ' ').slice(0, 16);
        }
      }
      warningRows += `
        <tr>
          <td>${w.userId || ''}</td>
          <td>${w.actorTag || w.actorId || ''}</td>
          <td>${w.reason || ''}</td>
          <td>${createdAtText}</td>
        </tr>
      `;
    });

    // 멤버 리스트 (최대 50명)
    const memberArray = Array.from(members.values())
      .sort((a, b) => {
        const aj = a.joinedTimestamp || 0;
        const bj = b.joinedTimestamp || 0;
        return bj - aj;
      })
      .slice(0, 50);

    let memberRows = '';
    memberArray.forEach((m) => {
      const user = m.user;
      const tag =
        user.discriminator === '0'
          ? user.username
          : `${user.username}#${user.discriminator}`;
      const display = m.nickname || user.globalName || user.username;
      memberRows += `
        <tr>
          <td>${display}</td>
          <td>${tag}</td>
          <td>${user.id}</td>
          <td>
            <button type="button" class="btn" style="padding:4px 10px;font-size:11px;" onclick="selectUser('${user.id}', '${display.replace(/'/g, "\\'")}')">
              선택
            </button>
          </td>
        </tr>
      `;
    });

    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>${guild.name} - 모더레이션 패널</title>
        <style>
          body {
            margin: 0;
            padding: 24px 12px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: radial-gradient(circle at top left, #4f46e5 0, #020617 45%, #000000 100%);
            color: #e5e7eb;
            display: flex;
            justify-content: center;
          }
          .shell {
            width: 100%;
            max-width: 1100px;
            border-radius: 24px;
            padding: 26px 22px 22px;
            background: rgba(15, 23, 42, 0.94);
            box-shadow:
              0 24px 70px rgba(0, 0, 0, 0.9),
              0 0 0 1px rgba(30, 64, 175, 0.6);
          }
          .top-nav {
            position: sticky;
            top: 0;
            z-index: 20;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 10px;
            margin: -4px -4px 10px;
            border-radius: 18px;
            background: linear-gradient(135deg, rgba(15,23,42,0.98), rgba(30,64,175,0.92));
            box-shadow: 0 12px 30px rgba(15, 23, 42, 0.9);
          }
          .top-link {
            font-size: 12px;
            color: #e5e7eb;
            text-decoration: none;
          }
          .top-link:hover {
            color: #a5b4fc;
          }
          .header {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: center;
            margin-bottom: 20px;
          }
          .title-block {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }
          .title {
            font-size: 22px;
            font-weight: 700;
          }
          .subtitle {
            font-size: 13px;
            color: #9ca3af;
          }
          .badge {
            font-size: 11px;
            padding: 6px 10px;
            border-radius: 999px;
            border: 1px solid rgba(148, 163, 184, 0.6);
            color: #9ca3af;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 16px;
            margin-top: 8px;
          }
          .card {
            border-radius: 18px;
            padding: 14px 14px 12px;
            background: radial-gradient(circle at top left, rgba(148, 163, 184, 0.12), rgba(15, 23, 42, 0.98));
            border: 1px solid rgba(55, 65, 81, 0.9);
            box-sizing: border-box;
          }
          .card-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
          }
          .card-subtitle {
            font-size: 12px;
            font-weight: 600;
            margin: 6px 0 4px;
            color: #e5e7eb;
          }
          .card-subtitle--divider {
            border-top: 1px solid rgba(31, 41, 55, 1);
            padding-top: 6px;
            margin-top: 10px;
          }
          .field {
            margin-bottom: 8px;
          }
          label {
            display: block;
            font-size: 11px;
            color: #9ca3af;
            margin-bottom: 3px;
          }
          input[type="text"], select, textarea {
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
            border-radius: 10px;
            border: 1px solid rgba(55, 65, 81, 1);
            background: rgba(15, 23, 42, 0.95);
            color: #e5e7eb;
            padding: 7px 9px;
            font-size: 12px;
            outline: none;
            display: block;
          }
          textarea {
            min-height: 60px;
            resize: vertical;
          }
          input:focus, select:focus, textarea:focus {
            border-color: rgba(129, 140, 248, 1);
            box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.7);
          }
          .hint {
            font-size: 11px;
            color: #6b7280;
            margin-top: 2px;
          }
          .btn {
            display: inline-block;
            margin-top: 6px;
            padding: 7px 13px;
            border-radius: 999px;
            border: none;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            color: #f9fafb;
            background: linear-gradient(135deg, #4f46e5, #6366f1);
            box-shadow:
              0 10px 28px rgba(79, 70, 229, 0.7),
              0 0 0 1px rgba(165, 180, 252, 0.9);
          }
          .btn-danger {
            background: linear-gradient(135deg, #ef4444, #b91c1c);
            box-shadow:
              0 10px 28px rgba(239, 68, 68, 0.75),
              0 0 0 1px rgba(254, 202, 202, 0.9);
          }
          .table-wrap {
            margin-top: 18px;
            border-radius: 14px;
            border: 1px solid rgba(31,41,55,1);
            background: rgba(15, 23, 42, 0.95);
            overflow: hidden;
          }
          .tables-layout {
            margin-top: 22px;
            display: grid;
            grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
            gap: 16px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
          }
          th, td {
            padding: 6px 8px;
            border-bottom: 1px solid rgba(31, 41, 55, 1);
            text-align: left;
          }
          th {
            background: rgba(15, 23, 42, 1);
            color: #9ca3af;
            font-weight: 600;
            font-size: 11px;
          }
          tr:last-child td {
            border-bottom: none;
          }
          .footer-actions {
            margin-top: 16px;
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #6b7280;
          }
          .footer-actions a {
            color: #9ca3af;
            text-decoration: none;
          }
          .footer-actions a:hover {
            color: #e5e7eb;
          }
          @media (max-width: 720px) {
            .shell {
              padding: 20px 16px 18px;
              border-radius: 20px;
            }
            .header {
              flex-direction: column;
              align-items: flex-start;
            }
          }
        </style>
      </head>
      <body>
        <div class="shell">
          <div class="top-nav">
            <a href="/panel" class="top-link">← 서버 리스트로 돌아가기</a>
            <a href="/server/${guildId}" class="top-link">기본 서버 설정</a>
          </div>

          <div class="header">
            <div class="title-block">
              <div class="title">${guild.name} 모더레이션 패널</div>
              <div class="subtitle">멤버 제재, 경고, 역할 관리를 웹에서 수행합니다.</div>
            </div>
            <div class="badge">Guild ID: ${guildId}</div>
          </div>

          <div class="grid">
            <div class="card">
              <div class="card-title">킥 / 밴</div>
              <div class="card-subtitle">킥</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="kick" />
                <div class="field">
                  <label for="kickUserId">유저 ID</label>
                  <input id="kickUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="kickReason">사유</label>
                  <input id="kickReason" name="reason" type="text" placeholder="선택 사항" />
                </div>
                <button class="btn" type="submit">유저 킥</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">밴</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="ban" />
                <div class="field">
                  <label for="banUserId">유저 ID</label>
                  <input id="banUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="banReason">사유</label>
                  <input id="banReason" name="reason" type="text" placeholder="선택 사항" />
                </div>
                <button class="btn btn-danger" type="submit">유저 밴</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">타임아웃 / 뮤트</div>
              <div class="card-subtitle">타임아웃</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="timeout" />
                <div class="field">
                  <label for="timeoutUserId">유저 ID</label>
                  <input id="timeoutUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="timeoutDuration">시간 선택</label>
                  <select id="timeoutDuration" name="durationMinutes" required>
                    <option value="5">5분</option>
                    <option value="10">10분</option>
                    <option value="30">30분</option>
                    <option value="60">1시간</option>
                    <option value="1440">1일</option>
                  </select>
                </div>
                <div class="field">
                  <label for="timeoutReason">사유</label>
                  <input id="timeoutReason" name="reason" type="text" placeholder="선택 사항" />
                </div>
                <button class="btn" type="submit">타임아웃 적용</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">밴 해제</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="unban" />
                <div class="field">
                  <label for="unbanUserId">밴 해제 유저 ID</label>
                  <input id="unbanUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <button class="btn" type="submit">밴 해제</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">경고 / 자동 처벌</div>
              <div class="card-subtitle">경고 추가</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="warn" />
                <div class="field">
                  <label for="warnUserId">유저 ID</label>
                  <input id="warnUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="warnReason">경고 사유</label>
                  <input id="warnReason" name="reason" type="text" placeholder="예: 도배, 욕설 등" />
                  <div class="hint">경고 3회: 1시간 타임아웃 / 5회: 자동 밴</div>
                </div>
                <button class="btn" type="submit">경고 추가</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">역할 추가 / 제거</div>
              <div class="card-subtitle">역할 추가</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="addRole" />
                <div class="field">
                  <label for="addRoleUserId">유저 ID</label>
                  <input id="addRoleUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="addRoleRoleId">추가할 역할</label>
                  <select id="addRoleRoleId" name="roleId" required>
                    ${roleOptions}
                  </select>
                </div>
                <button class="btn" type="submit">역할 추가</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">역할 제거</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="removeRole" />
                <div class="field">
                  <label for="removeRoleUserId">유저 ID</label>
                  <input id="removeRoleUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="removeRoleRoleId">제거할 역할</label>
                  <select id="removeRoleRoleId" name="roleId" required>
                    ${roleOptions}
                  </select>
                </div>
                <button class="btn btn-danger" type="submit">역할 제거</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">역할 / 채널 생성 · 권한</div>

              <div class="card-subtitle">역할 생성</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="createRole" />
                <div class="field">
                  <label for="roleName">역할 이름</label>
                  <input id="roleName" name="roleName" type="text" placeholder="예: 관리자" required />
                </div>
                <div class="field">
                  <label for="roleColor">색상 (선택, HEX)</label>
                  <input id="roleColor" name="roleColor" type="text" placeholder="#5865F2" />
                </div>
                <label style="font-size:11px;color:#9ca3af;margin-top:4px;">
                  <input type="checkbox" name="roleAdmin" value="1" />
                  관리자 역할로 만들기 (Administrator 권한 부여)
                </label>
                <div class="hint">강력한 권한이므로 신중하게 사용하세요.</div>
                <button class="btn" type="submit">역할 생성</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">채널 생성</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="createChannel" />
                <div class="field">
                  <label for="channelName">채널 이름</label>
                  <input id="channelName" name="channelName" type="text" placeholder="예: 새-채팅" required />
                </div>
                <div class="field">
                  <label for="channelType">채널 종류</label>
                  <select id="channelType" name="channelType">
                    <option value="text">텍스트 채널</option>
                    <option value="voice">음성 채널</option>
                  </select>
                </div>
                <div class="field">
                  <label for="channelCategoryId">카테고리 ID (선택)</label>
                  <input id="channelCategoryId" name="channelCategoryId" type="text" placeholder="예: 123456789012345678" />
                  <div class="hint">해당 카테고리 아래에 채널이 생성됩니다. 비워두면 루트에 생성됩니다.</div>
                </div>
                <button class="btn" type="submit">채널 생성</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">채널 권한 설정</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="setChannelPerms" />
                <div class="field">
                  <label for="permChannelId">채널 ID</label>
                  <input id="permChannelId" name="permChannelId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="permRoleId">대상 역할 ID</label>
                  <input id="permRoleId" name="permRoleId" type="text" placeholder="예: 123456789012345678" required />
                  <div class="hint">예: @everyone 역할 ID를 넣으면 전체 공개/비공개를 제어할 수 있습니다.</div>
                </div>
                <div class="field">
                  <label>채널 권한 (간단 설정)</label>
                  <label style="font-size:11px;color:#9ca3af;display:block;margin-bottom:2px;">
                    <input type="checkbox" name="permView" value="1" /> 채널 보기 허용 (체크 해제시 숨김)
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permSend" value="1" /> 메시지 보내기 허용 (체크 해제시 읽기 전용)
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;margin-top:4px;">
                    <input type="checkbox" name="permManageMessages" value="1" /> 메시지 관리 허용 (삭제/고정 등)
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permAttach" value="1" /> 파일 첨부 허용
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permEmbed" value="1" /> 링크 임베드 허용
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permReact" value="1" /> 리액션 추가 허용
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permUseCmds" value="1" /> 슬래시 커맨드 사용 허용
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;margin-top:4px;">
                    <input type="checkbox" name="permConnect" value="1" /> (음성 채널) 접속 허용
                  </label>
                  <label style="font-size:11px;color:#9ca3af;display:block;">
                    <input type="checkbox" name="permSpeak" value="1" /> (음성 채널) 발언 허용
                  </label>
                </div>
                <button class="btn" type="submit">권한 적용</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">서버 / 유저 이름 변경</div>

              <div class="card-subtitle">서버 이름 변경</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="renameGuild" />
                <div class="field">
                  <label for="guildName">새 서버 이름</label>
                  <input id="guildName" name="guildName" type="text" placeholder="${guild.name}" />
                  <div class="hint">Manage Guild 권한이 필요합니다.</div>
                </div>
                <button class="btn" type="submit">서버 이름 변경</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">서버 아이콘 변경</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="setIcon" />
                <div class="field">
                  <label for="iconUrl">아이콘 이미지 URL</label>
                  <input id="iconUrl" name="iconUrl" type="text" placeholder="https://example.com/icon.png" />
                  <div class="hint">정사각형 PNG/JPG 이미지 링크를 넣어주세요. Manage Guild 권한이 필요합니다.</div>
                </div>
                <button class="btn" type="submit">서버 아이콘 변경</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">유저 닉네임 변경</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="setNickname" />
                <div class="field">
                  <label for="nickUserId">유저 ID</label>
                  <input id="nickUserId" name="userId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <div class="field">
                  <label for="newNick">새 닉네임 (비워두면 초기화)</label>
                  <input id="newNick" name="nickname" type="text" placeholder="새 닉네임" />
                </div>
                <button class="btn" type="submit">닉네임 변경</button>
              </form>
            </div>

            <div class="card">
              <div class="card-title">이모지 / 스티커 관리</div>

              <div class="card-subtitle">이모지 추가</div>
              <form method="POST" action="/server/${guildId}/moderation/action">
                <input type="hidden" name="action" value="addEmoji" />
                <div class="field">
                  <label for="emojiName">이모지 이름</label>
                  <input id="emojiName" name="emojiName" type="text" placeholder="예: happy_face" required />
                </div>
                <div class="field">
                  <label for="emojiUrl">이모지 이미지 URL</label>
                  <input id="emojiUrl" name="emojiUrl" type="text" placeholder="https://example.com/emoji.png" required />
                  <div class="hint">정사각형 PNG/GIF 이미지 링크를 넣어주세요. Manage Emojis and Stickers 권한이 필요합니다.</div>
                </div>
                <button class="btn" type="submit">이모지 추가</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">이모지 제거</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="removeEmoji" />
                <div class="field">
                  <label for="emojiId">이모지 ID</label>
                  <input id="emojiId" name="emojiId" type="text" placeholder="예: 123456789012345678" required />
                  <div class="hint">이모지를 우클릭 → 링크 복사에서 ID를 확인할 수 있습니다.</div>
                </div>
                <button class="btn btn-danger" type="submit">이모지 제거</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">스티커 추가</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="addSticker" />
                <div class="field">
                  <label for="stickerName">스티커 이름</label>
                  <input id="stickerName" name="stickerName" type="text" placeholder="예: cool_sticker" required />
                </div>
                <div class="field">
                  <label for="stickerTags">태그 (쉼표로 구분, 최소 1개)</label>
                  <input id="stickerTags" name="stickerTags" type="text" placeholder="예: 😀, fun" required />
                  <div class="hint">Discord 요구사항상 최소 한 개의 관련 이모지/단어 태그가 필요합니다.</div>
                </div>
                <div class="field">
                  <label for="stickerUrl">스티커 이미지 URL</label>
                  <input id="stickerUrl" name="stickerUrl" type="text" placeholder="PNG/APNG 이미지 URL" required />
                  <div class="hint">Static PNG/APNG 이미지만 지원합니다. 용량/해상도 제한을 지켜주세요.</div>
                </div>
                <button class="btn" type="submit">스티커 추가</button>
              </form>

              <div class="card-subtitle card-subtitle--divider">스티커 제거</div>
              <form method="POST" action="/server/${guildId}/moderation/action" style="margin-top:4px;">
                <input type="hidden" name="action" value="removeSticker" />
                <div class="field">
                  <label for="stickerId">스티커 ID</label>
                  <input id="stickerId" name="stickerId" type="text" placeholder="예: 123456789012345678" required />
                </div>
                <button class="btn btn-danger" type="submit">스티커 제거</button>
              </form>

              <div class="hint" style="margin-top:8px;">
                ⚠️ 사운드보드 관리 기능은 현재 Discord 공식 API 지원이 제한적이라, 패널에서 직접 추가/삭제할 수 없습니다.
              </div>
            </div>
          </div>

          <div class="tables-layout">
            <div class="table-wrap">
              <div style="padding:10px 10px 0;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="font-size:12px;font-weight:600;color:#e5e7eb;">서버 멤버 목록</div>
                <div style="font-size:11px;color:#6b7280;">최대 50명 · 닉네임 / 태그 / ID 검색</div>
              </div>
              <div style="padding:0 10px 6px;">
                <input
                  id="memberSearch"
                  type="text"
                  placeholder="유저 검색..."
                  style="width:100%;margin-top:6px;border-radius:999px;border:1px solid rgba(55,65,81,1);background:#020617;color:#e5e7eb;padding:6px 10px;font-size:11px;outline:none;"
                  oninput="filterMembers()"
                />
              </div>
              <table>
                <thead>
                  <tr>
                    <th>닉네임 / 이름</th>
                    <th>태그</th>
                    <th style="width:26%;">유저 ID</th>
                    <th style="width:14%;">선택</th>
                  </tr>
                </thead>
                <tbody id="memberTableBody">
                  ${memberRows || '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:10px 0;">표시할 멤버가 없습니다.</td></tr>'}
                </tbody>
              </table>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:22%;">유저 ID</th>
                    <th style="width:24%;">처리자</th>
                    <th>사유</th>
                    <th style="width:20%;">시간</th>
                  </tr>
                </thead>
                <tbody>
                  ${warningRows || '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:10px 0;">최근 경고 기록이 없습니다.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div class="footer-actions">
            <span>경고 3회: 1시간 타임아웃 · 5회: 영구 밴 (자동 적용)</span>
            <a href="/server/${guildId}">← 기본 서버 설정으로 돌아가기</a>
          </div>
        </div>
        <script>
          function selectUser(id, label) {
            try {
              const fields = [
                'kickUserId',
                'banUserId',
                'timeoutUserId',
                'unbanUserId',
                'warnUserId',
                'addRoleUserId',
                'removeRoleUserId',
                'nickUserId',
              ];
              fields.forEach(function (fid) {
                var el = document.getElementById(fid);
                if (el) el.value = id;
              });
              alert('선택된 유저: ' + label + ' (' + id + ')');
            } catch (e) {
              console.error(e);
            }
          }

          function filterMembers() {
            try {
              var input = document.getElementById('memberSearch');
              if (!input) return;
              var filter = input.value.toLowerCase();
              var body = document.getElementById('memberTableBody');
              if (!body) return;
              var rows = body.getElementsByTagName('tr');
              for (var i = 0; i < rows.length; i++) {
                var cells = rows[i].getElementsByTagName('td');
                if (!cells.length) continue;
                var text =
                  (cells[0].innerText || '') +
                  ' ' +
                  (cells[1].innerText || '') +
                  ' ' +
                  (cells[2].innerText || '');
                text = text.toLowerCase();
                rows[i].style.display = filter === '' || text.indexOf(filter) !== -1 ? '' : 'none';
              }
            } catch (e) {
              console.error(e);
            }
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('모더레이션 패널 로딩 오류:', err);
    return res.status(500).send('모더레이션 패널을 불러오는 중 오류가 발생했습니다.');
  }
});

// 모더레이션 액션 처리
app.post('/server/:id/moderation/action', async (req, res) => {
  const guildId = req.params.id;
  const {
    action,
    userId,
    durationMinutes,
    reason,
    roleId,
    guildName,
    iconUrl,
    nickname,
    emojiName,
    emojiUrl,
    emojiId,
    stickerName,
    stickerTags,
    stickerUrl,
    stickerId,
    roleName,
    roleColor,
    roleAdmin,
    channelName,
    channelType,
    channelCategoryId,
    permChannelId,
    permRoleId,
    permView,
    permSend,
    permManageMessages,
    permAttach,
    permEmbed,
    permReact,
    permUseCmds,
    permConnect,
    permSpeak,
  } = req.body;

  if (!botReady) {
    return res.status(503).send('봇이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
  }

  if (!action) {
    return res.status(400).send('필수 값이 누락되었습니다.');
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    let member = null;

    // 밴/언밴/서버 설정 변경은 멤버가 없어도 처리 가능
    const needsMember = !['ban', 'unban', 'renameGuild', 'setIcon'].includes(action);
    if (needsMember) {
      if (!userId) {
        throw new Error('유저 ID가 필요합니다.');
      }
      try {
        member = await guild.members.fetch(userId);
      } catch (fetchErr) {
        throw new Error(`유저를 찾을 수 없습니다: ${fetchErr.message}`);
      }
    }

    let resultMessage = '';

    if (action === 'kick') {
      await member.kick(reason || undefined);
      resultMessage = `유저 ${userId} 를 킥했습니다.`;
    } else if (action === 'ban') {
      await guild.members.ban(userId, { reason: reason || undefined });
      resultMessage = `유저 ${userId} 를 밴했습니다.`;
    } else if (action === 'unban') {
      await guild.members.unban(userId).catch((e) => {
        throw new Error(`밴 해제 실패: ${e.message}`);
      });
      resultMessage = `유저 ${userId} 의 밴을 해제했습니다.`;
    } else if (action === 'timeout') {
      const minutes = parseInt(durationMinutes || '0', 10);
      if (!minutes || minutes <= 0) {
        throw new Error('유효한 타임아웃 시간을 선택해주세요.');
      }
      const ms = minutes * 60 * 1000;
      // @ts-ignore
      await member.timeout(ms, reason || undefined);
      resultMessage = `유저 ${userId} 에게 ${minutes}분 타임아웃을 적용했습니다.`;
    } else if (action === 'renameGuild') {
      const newName = (guildName || '').trim();
      if (!newName) {
        throw new Error('서버 이름을 입력해주세요.');
      }
      const oldName = guild.name;
      await guild.setName(newName);
      resultMessage = `서버 이름을 "${oldName}" → "${newName}" 으로 변경했습니다.`;
    } else if (action === 'setIcon') {
      const url = (iconUrl || '').trim();
      if (!url) {
        throw new Error('아이콘 이미지 URL을 입력해주세요.');
      }
      await guild.setIcon(url);
      resultMessage = '서버 아이콘을 변경했습니다.';
    } else if (action === 'setNickname') {
      if (!member) {
        throw new Error('유저를 찾을 수 없습니다.');
      }
      const newNick = (nickname || '').trim();
      await member.setNickname(newNick || null, reason || undefined);
      resultMessage = newNick
        ? `유저 ${userId} 의 닉네임을 "${newNick}" 으로 변경했습니다.`
        : `유저 ${userId} 의 닉네임을 초기화했습니다.`;
    } else if (action === 'addEmoji') {
      const name = (emojiName || '').trim();
      const url = (emojiUrl || '').trim();
      if (!name || !url) {
        throw new Error('이모지 이름과 이미지를 모두 입력해주세요.');
      }
      const emoji = await guild.emojis.create({ name, attachment: url });
      resultMessage = `이모지 "${emoji.name}" (${emoji.id}) 를 추가했습니다.`;
    } else if (action === 'removeEmoji') {
      const id = (emojiId || '').trim();
      if (!id) {
        throw new Error('이모지 ID를 입력해주세요.');
      }
      await guild.emojis.delete(id);
      resultMessage = `이모지 ${id} 를 제거했습니다.`;
    } else if (action === 'addSticker') {
      const name = (stickerName || '').trim();
      const tagsRaw = (stickerTags || '').trim();
      const url = (stickerUrl || '').trim();
      if (!name || !tagsRaw || !url) {
        throw new Error('스티커 이름 / 태그 / 이미지를 모두 입력해주세요.');
      }
      const tags = tagsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join(', ');
      if (!tags) {
        throw new Error('최소 한 개 이상의 태그가 필요합니다.');
      }
      // 이미지를 가져와서 버퍼로 변환
      const imgRes = await axios.get(url, { responseType: 'arraybuffer' });
      const file = Buffer.from(imgRes.data);
      const sticker = await guild.stickers.create({
        file,
        name,
        tags,
      });
      resultMessage = `스티커 "${sticker.name}" (${sticker.id}) 를 추가했습니다.`;
    } else if (action === 'removeSticker') {
      const id = (stickerId || '').trim();
      if (!id) {
        throw new Error('스티커 ID를 입력해주세요.');
      }
      await guild.stickers.delete(id);
      resultMessage = `스티커 ${id} 를 제거했습니다.`;
    } else if (action === 'createRole') {
      const name = (roleName || '').trim();
      if (!name) {
        throw new Error('역할 이름을 입력해주세요.');
      }
      const color = (roleColor || '').trim();
      const isAdmin = !!roleAdmin;

      const data = {
        name,
      };
      if (color) {
        data.color = color;
      }
      if (isAdmin) {
        data.permissions = [PermissionFlagsBits.Administrator];
      }

      const role = await guild.roles.create(data);
      resultMessage = `역할 "${role.name}" (${role.id}) 를 생성했습니다.${
        isAdmin ? '\n⚠️ 관리자 권한이 부여되었습니다.' : ''
      }`;
    } else if (action === 'createChannel') {
      const name = (channelName || '').trim();
      const typeStr = (channelType || 'text').toLowerCase();
      if (!name) {
        throw new Error('채널 이름을 입력해주세요.');
      }
      let type = ChannelType.GuildText;
      if (typeStr === 'voice') type = ChannelType.GuildVoice;

      const options = { name, type };
      const categoryId = (channelCategoryId || '').trim();
      if (categoryId) {
        options.parent = categoryId;
      }

      const channel = await guild.channels.create(options);
      resultMessage = `채널 "${channel.name}" (${channel.id}) 를 생성했습니다.`;
    } else if (action === 'setChannelPerms') {
      const chId = (permChannelId || '').trim();
      const rId = (permRoleId || '').trim();
      if (!chId || !rId) {
        throw new Error('채널 ID와 역할 ID를 모두 입력해주세요.');
      }
      const channel = await guild.channels.fetch(chId);
      if (!channel) {
        throw new Error('해당 채널을 찾을 수 없습니다.');
      }

      const allowView = permView === '1';
      const allowSend = permSend === '1';
      const allowManage = permManageMessages === '1';
      const allowAttachFiles = permAttach === '1';
      const allowEmbedLinks = permEmbed === '1';
      const allowReact = permReact === '1';
      const allowUseCmds = permUseCmds === '1';
      const allowConnect = permConnect === '1';
      const allowSpeak = permSpeak === '1';

      const perms = {};
      if (permView !== undefined) perms.ViewChannel = allowView;
      if (permSend !== undefined) perms.SendMessages = allowSend;
      if (permManageMessages !== undefined) perms.ManageMessages = allowManage;
      if (permAttach !== undefined) perms.AttachFiles = allowAttachFiles;
      if (permEmbed !== undefined) perms.EmbedLinks = allowEmbedLinks;
      if (permReact !== undefined) perms.AddReactions = allowReact;
      if (permUseCmds !== undefined) perms.UseApplicationCommands = allowUseCmds;
      if (permConnect !== undefined) perms.Connect = allowConnect;
      if (permSpeak !== undefined) perms.Speak = allowSpeak;

      await channel.permissionOverwrites.edit(rId, perms);
      resultMessage = `채널 ${chId} 에서 역할 ${rId} 의 권한을 업데이트했습니다.`;
    } else if (action === 'warn') {
      const actor = req.session?.user;
      const now = new Date();
      await db
        .collection('servers')
        .doc(guildId)
        .collection('warnings')
        .add({
          userId,
          reason: reason || null,
          actorId: actor?.id || null,
          actorTag: actor ? `${actor.username}#${actor.discriminator}` : null,
          createdAt: now,
        });

      // 현재 경고 횟수 조회
      const warnsSnap = await db
        .collection('servers')
        .doc(guildId)
        .collection('warnings')
        .where('userId', '==', userId)
        .get();
      const warnCount = warnsSnap.size;

      resultMessage = `유저 ${userId} 에게 경고를 1회 추가했습니다. (총 ${warnCount}회)`;

      // 자동 처벌: 3회 => 1시간 타임아웃, 5회 => 밴
      if (warnCount === 3) {
        try {
          if (!member) {
            member = await guild.members.fetch(userId);
          }
          // @ts-ignore
          await member.timeout(60 * 60 * 1000, '자동 제재: 경고 3회 누적');
          resultMessage += '\n자동 제재: 1시간 타임아웃 적용됨.';
        } catch (autoErr) {
          console.error('자동 타임아웃 실패:', autoErr);
          resultMessage += '\n자동 타임아웃 적용 실패 (권한 혹은 상태 문제).';
        }
      } else if (warnCount === 5) {
        try {
          await guild.members.ban(userId, {
            reason: '자동 제재: 경고 5회 누적',
          });
          resultMessage += '\n자동 제재: 유저 밴 적용됨.';
        } catch (autoBanErr) {
          console.error('자동 밴 실패:', autoBanErr);
          resultMessage += '\n자동 밴 적용 실패 (권한 혹은 상태 문제).';
        }
      }
    } else if (action === 'addRole') {
      if (!roleId) {
        throw new Error('추가할 역할을 선택해주세요.');
      }
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        throw new Error('해당 역할을 찾을 수 없습니다.');
      }
      await member.roles.add(role);
      resultMessage = `유저 ${userId} 에게 역할 "${role.name}" 을(를) 추가했습니다.`;
    } else if (action === 'removeRole') {
      if (!roleId) {
        throw new Error('제거할 역할을 선택해주세요.');
      }
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        throw new Error('해당 역할을 찾을 수 없습니다.');
      }
      await member.roles.remove(role);
      resultMessage = `유저 ${userId} 에서 역할 "${role.name}" 을(를) 제거했습니다.`;
    } else {
      throw new Error('지원하지 않는 액션입니다.');
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>모더레이션 결과</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:520px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);white-space:pre-line;">
          <h2 style="margin:0 0 8px 0;font-size:20px;">모더레이션 작업 완료</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">${resultMessage}</p>
          <a href="/server/${guildId}/moderation" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 모더레이션 패널로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('모더레이션 액션 오류:', err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>모더레이션 오류</title>
      </head>
      <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:520px;padding:24px 20px;border-radius:18px;background:#111827;box-shadow:0 18px 45px rgba(0,0,0,.8),0 0 0 1px rgba(31,41,55,1);">
          <h2 style="margin:0 0 8px 0;font-size:20px;">모더레이션 작업 중 오류가 발생했습니다</h2>
          <p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;">
            ${err.message || String(err)}
          </p>
          <a href="/server/${guildId}/moderation" style="font-size:13px;color:#a5b4fc;text-decoration:none;">← 모더레이션 패널로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  }
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

  // 중간 페이지: 초대 링크를 새 창에서 열고, 완료 후 패널로 돌아가기 안내
  res.send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8" />
      <title>봇 초대</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          min-height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: radial-gradient(circle at top left, #4f46e5 0, #020617 45%, #000000 100%);
          color: #e5e7eb;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          max-width: 500px;
          padding: 32px 24px;
          border-radius: 24px;
          background: rgba(15, 23, 42, 0.9);
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(148, 163, 184, 0.35);
          text-align: center;
        }
        h1 {
          margin: 0 0 12px 0;
          font-size: 24px;
        }
        p {
          margin: 0 0 24px 0;
          font-size: 14px;
          color: #9ca3af;
          line-height: 1.6;
        }
        .invite-btn {
          display: inline-block;
          padding: 12px 24px;
          border-radius: 999px;
          font-size: 15px;
          font-weight: 600;
          text-decoration: none;
          color: #f9fafb;
          background: linear-gradient(135deg, #5865f2, #4f46e5);
          box-shadow: 0 18px 40px rgba(88, 101, 242, 0.65), 0 0 0 1px rgba(165, 180, 252, 0.9);
          margin-bottom: 20px;
          transition: transform 0.12s ease, box-shadow 0.18s ease;
        }
        .invite-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 22px 50px rgba(88, 101, 242, 0.9), 0 0 0 1px rgba(191, 219, 254, 1);
        }
        .done-btn {
          display: inline-block;
          padding: 10px 20px;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
          text-decoration: none;
          color: #f9fafb;
          background: linear-gradient(135deg, #22c55e, #16a34a);
          box-shadow: 0 12px 30px rgba(34, 197, 94, 0.55), 0 0 0 1px rgba(74, 222, 128, 0.8);
          transition: transform 0.12s ease, box-shadow 0.18s ease;
        }
        .done-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 16px 35px rgba(34, 197, 94, 0.8), 0 0 0 1px rgba(134, 239, 172, 0.9);
        }
        .back-link {
          display: block;
          margin-top: 16px;
          font-size: 13px;
          color: #9ca3af;
          text-decoration: none;
        }
        .back-link:hover {
          color: #e5e7eb;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>봇 초대하기</h1>
        <p>
          아래 버튼을 클릭하면 디스코드에서 봇 초대 페이지가 열립니다.<br/>
          초대를 완료한 후, 이 페이지로 돌아와서 "초대 완료" 버튼을 클릭하세요.
        </p>
        <a href="${inviteUrl}" target="_blank" class="invite-btn" onclick="window.inviteOpened = true;">
          디스코드에서 봇 초대하기
        </a>
        <div style="margin-top: 24px;">
          <a href="/panel" class="done-btn">초대 완료 - 패널로 돌아가기</a>
        </div>
        <a href="/panel" class="back-link">← 서버 목록으로 돌아가기</a>
      </div>
    </body>
    </html>
  `);
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