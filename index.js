const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const OWNER_ID = process.env.DISCORD_OWNER_ID;

if (!TOKEN) { console.error('Missing DISCORD_BOT_TOKEN'); process.exit(1); }
if (!OWNER_ID) { console.error('Missing DISCORD_OWNER_ID'); process.exit(1); }

// --- Simple JSON file-based storage ---
const DB_PATH = path.join(__dirname, 'data.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return { emails: {} }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getEmail(userId) { return readDB().emails[userId] || null; }
function setEmail(userId, record) { const db = readDB(); db.emails[userId] = record; writeDB(db); }
function deleteEmail(userId) { const db = readDB(); delete db.emails[userId]; writeDB(db); }
function allEmails() { return Object.values(readDB().emails); }

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ['CHANNEL', 'MESSAGE']
});

function isOwner(userId) { return userId === OWNER_ID; }

const commands = [
  new SlashCommandBuilder()
    .setName('gen')
    .setDescription('Generate a temporary email — incoming emails get forwarded to your DMs')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('myemail')
    .setDescription('Show your current temporary email address')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('stopemail')
    .setDescription('Stop email forwarding and delete your temp mailbox')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is online')
    .setDMPermission(true),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await client.application.fetch();
    const clientId = client.application.id;
    const commandsJson = commands.map(c => ({
      ...c.toJSON(),
      integration_types: [0, 1],
      contexts: [0, 1, 2],
    }));
    await rest.put(Routes.applicationCommands(clientId), { body: commandsJson });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const user = interaction.user;

  if (commandName === 'ping') {
    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🏓 Pong!')
      .setDescription('Bot is online and running.')
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'gen') {
    if (!isOwner(user.id)) return interaction.reply({ content: '❌ Only the owner can use this command.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });

    try {
      // Get available domain
      const domainRes = await fetch('https://api.mail.tm/domains');
      const domainData = await domainRes.json();
      const domain = domainData['hydra:member']?.[0]?.domain;
      if (!domain) return interaction.editReply({ content: '❌ Could not reach the email service. Try again later.' });

      // Create credentials
      const username = uuidv4().replace(/-/g, '').slice(0, 10).toLowerCase();
      const address = username + '@' + domain;
      const password = uuidv4().replace(/-/g, '').slice(0, 16);

      // Create mailbox
      const createRes = await fetch('https://api.mail.tm/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
      });
      if (!createRes.ok) {
        console.error('Create error:', await createRes.text());
        return interaction.editReply({ content: '❌ Failed to create temporary email. Try again.' });
      }

      // Get auth token
      const tokenRes = await fetch('https://api.mail.tm/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
      });
      const tokenData = await tokenRes.json();
      const mailToken = tokenData.token;
      if (!mailToken) return interaction.editReply({ content: '❌ Could not authenticate with email service. Try again.' });

      // Save to storage
      setEmail(user.id, { userId: user.id, address, password, mailToken, seenIds: [], createdAt: new Date().toISOString() });

      const isExternal = !interaction.guild;
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📧 Temporary Email Generated')
        .addFields(
          { name: 'Email Address', value: '`' + address + '`' },
          { name: 'Status', value: '✅ Active — new emails will be forwarded to your DMs' }
        )
        .setFooter({ text: 'Use /stopemail to stop forwarding' })
        .setTimestamp();

      if (isExternal) {
        return interaction.editReply({ embeds: [embed] });
      } else {
        try {
          await user.send({ embeds: [embed] });
          return interaction.editReply({ content: '✅ Sent to your DMs!' });
        } catch {
          return interaction.editReply({ embeds: [embed], content: '_(Enable DMs from server members to receive email forwarding.)_' });
        }
      }
    } catch (err) {
      console.error('gen error:', err);
      return interaction.editReply({ content: '❌ An error occurred. Please try again.' });
    }
  }

  if (commandName === 'myemail') {
    if (!isOwner(user.id)) return interaction.reply({ content: '❌ Only the owner can use this command.', ephemeral: true });
    const record = getEmail(user.id);
    if (!record) return interaction.reply({ content: '❌ No active email. Use `/gen` to create one.', ephemeral: true });
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📧 Your Active Email')
      .addFields({ name: 'Address', value: '`' + record.address + '`' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'stopemail') {
    if (!isOwner(user.id)) return interaction.reply({ content: '❌ Only the owner can use this command.', ephemeral: true });
    const record = getEmail(user.id);
    if (!record) return interaction.reply({ content: '❌ No active email to stop.', ephemeral: true });
    deleteEmail(user.id);
    return interaction.reply({ content: '✅ Email forwarding stopped and mailbox deleted.', ephemeral: true });
  }
});

// Poll every 60 seconds and forward new emails via DM
setInterval(async () => {
  const records = allEmails();
  for (const record of records) {
    try {
      const msgsRes = await fetch('https://api.mail.tm/messages', {
        headers: { Authorization: 'Bearer ' + record.mailToken }
      });
      if (!msgsRes.ok) continue;

      const msgsData = await msgsRes.json();
      const messages = msgsData['hydra:member'] || [];
      let updated = false;

      for (const msg of messages) {
        if (record.seenIds.includes(msg.id)) continue;
        record.seenIds.push(msg.id);
        updated = true;

        const fullRes = await fetch('https://api.mail.tm/messages/' + msg.id, {
          headers: { Authorization: 'Bearer ' + record.mailToken }
        });
        const fullMsg = await fullRes.json();

        const from = fullMsg.from?.address || 'Unknown';
        const subject = fullMsg.subject || '(no subject)';
        const body = (fullMsg.text || fullMsg.html?.replace(/<[^>]+>/g, '') || '(empty)').slice(0, 1800);

        const embed = new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle('📬 New Email Received')
          .addFields(
            { name: 'To', value: '`' + record.address + '`' },
            { name: 'From', value: from },
            { name: 'Subject', value: subject },
            { name: 'Message', value: body }
          )
          .setTimestamp();

        try {
          const owner = await client.users.fetch(record.userId);
          await owner.send({ embeds: [embed] });
          console.log('Forwarded email from', from, 'to user', record.userId);
        } catch (e) {
          console.error('Could not DM user', record.userId, e.message);
        }
      }

      if (updated) {
        setEmail(record.userId, record);
      }
    } catch (err) {
      console.error('Poll error for', record.address, err.message);
    }
  }
}, 60000);

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
