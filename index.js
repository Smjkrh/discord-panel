require('dotenv').config();
const db = require('./firebase');
const express = require('express');
const cors = require('cors');

const { Client, GatewayIntentBits } = require('discord.js');

// 디스코드 봇 클라이언트
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('guildCreate', async (guild) => {
  console.log(`새 서버 참가: ${guild.name}`);

  try {
    await db.collection('servers').doc(guild.id).set({
      guildName: guild.name,
      ownerId: guild.ownerId,
      autoRole: null,
      welcomeChannel: null,
      welcomeMessage: "환영합니다!",
      createdAt: new Date()
    });

    console.log("DB에 서버 등록 완료");
  } catch (err) {
    console.error("DB 저장 실패:", err);
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
        welcomeMessage: "환영합니다!",
        createdAt: new Date()
      });

      console.log(`기존 서버 등록: ${guild.name}`);
    }
  });
});

client.on('guildMemberAdd', member => {
  console.log(member.user.username + " joined");
});

client.login(process.env.TOKEN);

// ===== 봇 내부 API 서버 =====
const app = express();
app.use(cors());
app.use(express.json());

// 헬스체크 / 상태 확인용 엔드포인트
app.get("/", (req, res) => {
  res.send("Bot is alive");
});

// 역할 목록 요청 (기존 기능 유지)
app.get('/api/roles/:guildId', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    const roles = await guild.roles.fetch();

    const roleList = roles
      .filter(role => role.name !== '@everyone')
      .map(role => ({
        id: role.id,
        name: role.name
      }));

    res.json(roleList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '역할 가져오기 실패' });
  }
});

// 포트 및 바인딩 (0.0.0.0, 환경변수 우선)
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`봇 API 서버: http://0.0.0.0:${PORT}`);
});
