/**
 * Multi-session WhatsApp (Baileys) manager — SaaS-style: each WaSession has its own socket + auth slice.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  proto,
  fetchLatestBaileysVersion,
  Browsers,
  normalizeMessageContent,
  extractMessageContent,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const mongoose = require('mongoose');
const AuthSession = require('../models/auth-session.model');
const BufferJSON = require('@whiskeysockets/baileys').BufferJSON;
const {
  uploadFromBuffer,
  uploadImageBuffer,
  uploadDocumentBuffer,
  assertCloudinaryConfigured,
} = require('./cloudinary.service');
const Message = require('../models/message.model');
const Group = require('../models/group.model');
const WaSession = require('../models/wa-session.model');
const settingsService = require('./settings.service');
const QRCode = require('qrcode');

const RECONNECT_DELAYS_SEC = [5, 10, 20, 45, 90];

const logger = pino({ level: 'silent' });

/** WhatsApp shows one identity per linked device — tag the body so customers/groups see which CRM agent sent it. */
const formatWhatsAppBodyFromCrm = (nickname, innerText) => {
  const name = (nickname || 'Agent').trim() || 'Agent';
  const t = (innerText || '').trim();
  if (!t) return `*${name}*`;
  return `*${name}*\n${t}`;
};

const formatWhatsAppCaptionFromCrm = (nickname, caption, fallbackLabel) => {
  const name = (nickname || 'Agent').trim() || 'Agent';
  const t = (caption || '').trim();
  if (t) return formatWhatsAppBodyFromCrm(name, t);
  return `*${name}*\n${fallbackLabel}`;
};

const safeWAFileName = (name, fallback = 'file') => {
  const base = String(name || fallback).split(/[/\\]/).pop() || fallback;
  const cleaned = base.replace(/[^\w.\-() \u0600-\u06FF]+/g, '_').trim().slice(0, 120);
  return cleaned || fallback;
};

/** sid string → runtime */
const runtimes = new Map();

function sidOf(sessionId) {
  return typeof sessionId === 'string' ? sessionId : sessionId.toString();
}

function parseSid(sessionId) {
  return typeof sessionId === 'string' ? new mongoose.Types.ObjectId(sessionId) : sessionId;
}

async function getTenantIdForSession(sessionId) {
  const sid = parseSid(sessionId);
  const row = await WaSession.findById(sid).select('tenantId').lean();
  return row?.tenantId || null;
}

function emptyRuntime() {
  return {
    sock: null,
    qrCode: null,
    connectionStatus: 'DISCONNECTED',
    reconnectAttempts: 0,
    reconnectTimer: null,
    isShuttingDown: false,
    groupMetadataCache: new Map(),
    pendingSyncRequests: new Map(),
  };
}

function getRt(sessionId) {
  const k = sidOf(sessionId);
  if (!runtimes.has(k)) runtimes.set(k, emptyRuntime());
  return runtimes.get(k);
}

let ioSingleton = null;

const unwrapMessage = (m) => {
  if (!m) return null;
  if (m.documentWithCaptionMessage) return m.documentWithCaptionMessage.message;
  if (m.deviceSentMessage) return m.deviceSentMessage.message;
  if (m.ephemeralMessage) return m.ephemeralMessage.message;
  if (m.viewOnceMessage) return m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) return m.viewOnceMessageV2.message;
  return m;
};

/** WA / devices use CR, PS/LS, etc. — normalize so the CRM UI keeps real line breaks. */
const normalizeNewlines = (s) => {
  if (s == null || typeof s !== 'string') return '';
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n');
};

const extractText = (msg) => {
  if (!msg?.message) return '';
  let m = unwrapMessage(msg.message);
  if (!m) return '';
  m = normalizeMessageContent(m);
  if (!m) return '';
  m = extractMessageContent(m) || m;

  const raw =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    (m.imageMessage
      ? '[Image]'
      : m.videoMessage
      ? '[Video]'
      : m.audioMessage
      ? '[Audio]'
      : m.documentMessage
      ? '[Document]'
      : '') ||
    '';

  return normalizeNewlines(raw);
};

const getTimestamp = (msg) => {
  const raw = msg.messageTimestamp;
  if (!raw) return new Date();
  const ts = typeof raw === 'object' && raw.low !== undefined ? raw.low : Number(raw);
  return new Date(ts * 1000);
};

const emitSession = (sessionId, event, payload) => {
  if (!ioSingleton) return;
  const sid = sidOf(sessionId);
  ioSingleton.to(`session:${sid}`).emit(event, { ...payload, sessionId: sid });
};

const useMongoDBAuthState = async (sessionId) => {
  const sid = parseSid(sessionId);

  const readData = async (key) => {
    try {
      const session = await AuthSession.findOne({ sessionId: sid, storageKey: key }).lean();
      return session ? JSON.parse(session.data, BufferJSON.reviver) : null;
    } catch (err) {
      console.error(`[Auth] Read error session=${sid} key=${key}:`, err.message);
      return null;
    }
  };

  const writeData = async (key, data) => {
    try {
      if (data == null) {
        await AuthSession.deleteOne({ sessionId: sid, storageKey: key });
      } else {
        await AuthSession.findOneAndUpdate(
          { sessionId: sid, storageKey: key },
          {
            sessionId: sid,
            storageKey: key,
            data: JSON.stringify(data, BufferJSON.replacer),
          },
          { upsert: true, returnDocument: 'after' }
        );
      }
    } catch (err) {
      console.error(`[Auth] Write error session=${sid} key=${key}:`, err.message);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              try {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              } catch {
                value = null;
              }
            }
            result[id] = value;
          })
        );
        return result;
      },

      set: async (data) => {
        const writes = [];
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            writes.push(writeData(`${category}-${id}`, data[category][id]));
          }
        }
        await Promise.all(writes);
      },
    },
  };

  const saveCreds = () => writeData('creds', state.creds);

  return { state, saveCreds };
};

const destroySocket = (sessionId) => {
  const rt = getRt(sessionId);
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  if (rt.sock) {
    console.log(`[WA ${sidOf(sessionId)}] Destroying socket...`);
    try {
      rt.sock.ev.removeAllListeners();
      rt.sock.end();
    } catch {
      /* ignore */
    }
    rt.sock = null;
  }
};

const scheduleReconnect = (sessionId) => {
  const rt = getRt(sessionId);
  if (rt.isShuttingDown) return;

  const delayIdx = Math.min(rt.reconnectAttempts, RECONNECT_DELAYS_SEC.length - 1);
  const delaySec = RECONNECT_DELAYS_SEC[delayIdx];
  rt.reconnectAttempts++;

  console.log(`[WA ${sidOf(sessionId)}] Reconnect in ${delaySec}s (#${rt.reconnectAttempts})`);

  emitSession(sessionId, 'connectionStatus', {
    status: 'DISCONNECTED',
    reconnectIn: delaySec,
    attempt: rt.reconnectAttempts,
  });

  rt.reconnectTimer = setTimeout(() => {
    connect(sessionId);
  }, delaySec * 1000);
};

const syncChats = async (sessionId) => {
  const rt = getRt(sessionId);
  if (!rt.sock) return;
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) return;
  try {
    const groups = await rt.sock.groupFetchAllParticipating();
    const keys = Object.keys(groups);
    for (const id of keys) {
      const group = groups[id];
      rt.groupMetadataCache.set(id, group);
      await Group.findOneAndUpdate(
        { tenantId, sessionId: sid, groupId: id },
        {
          tenantId,
          name: group.subject,
          participants: group.participants.map((p) => p.id),
          isGroup: true,
        },
        { upsert: true, returnDocument: 'after' }
      );
    }
    await settingsService.refreshCache(sid);
    console.log(`[WA ${sidOf(sessionId)}] Synced ${keys.length} groups`);
  } catch (err) {
    console.error(`[WA ${sidOf(sessionId)}] syncChats:`, err.message);
  }
};

const syncMessages = async (sessionId, jid) => {
  const rt = getRt(sessionId);
  if (!rt.sock || !jid) return;
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) return;
  try {
    if (jid.endsWith('@g.us')) {
      const meta = await rt.sock.groupMetadata(jid);
      await Group.findOneAndUpdate(
        { tenantId, sessionId: sid, groupId: jid },
        {
          tenantId,
          name: meta.subject,
          participants: meta.participants.map((p) => p.id),
          isGroup: true,
        },
        { upsert: true, returnDocument: 'after' }
      );
    }
  } catch (err) {
    console.error(`[WA ${sidOf(sessionId)}] syncMessages:`, err.message);
  }
};

const resolveCanonicalJid = async (sessionId, incomingJid) => {
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) return incomingJid;
  if (!incomingJid || incomingJid.endsWith('@g.us') || incomingJid.endsWith('@lid')) {
    return incomingJid;
  }

  try {
    const lidGroup = await Group.findOne({ tenantId, sessionId: sid, phoneJid: incomingJid }).lean();
    if (lidGroup) return lidGroup.groupId;
  } catch {
    /* ignore */
  }

  const rt = getRt(sessionId);
  if (rt.pendingSyncRequests.size > 0) {
    const entries = Array.from(rt.pendingSyncRequests.entries());
    const mostRecent = entries.sort((a, b) => b[1] - a[1])[0];
    if (Date.now() - mostRecent[1] < 300000) {
      const targetLid = mostRecent[0];
      console.log(`[WA ${sidOf(sessionId)}] Map ${incomingJid} → ${targetLid} (pending sync)`);
      await Group.findOneAndUpdate(
        { tenantId, sessionId: sid, groupId: targetLid },
        { $set: { phoneJid: incomingJid } }
      );
      rt.pendingSyncRequests.delete(targetLid);
      return targetLid;
    }
  }

  try {
    const digits = incomingJid.split('@')[0];
    const guess = await Group.findOne({
      tenantId,
      sessionId: sid,
      name: { $regex: digits, $options: 'i' },
      groupId: /@lid$/,
    }).lean();
    if (guess) {
      await Group.findOneAndUpdate(
        { tenantId, sessionId: sid, groupId: guess.groupId },
        { $set: { phoneJid: incomingJid } }
      );
      return guess.groupId;
    }
  } catch {
    /* ignore */
  }

  return incomingJid;
};

const INVISIBLE_MSG_TYPES = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollCreationMessage',
  'pollUpdateMessage',
]);

const transformWAMessage = (msg) => {
  if (!msg?.message) return null;

  const groupId = msg.key.remoteJid;
  if (!groupId || groupId === 'status@broadcast') return null;

  const m = unwrapMessage(msg.message);
  if (!m) return null;

  const msgTypes = Object.keys(m);
  if (msgTypes.every((k) => INVISIBLE_MSG_TYPES.has(k))) return null;

  const fromMe = msg.key.fromMe;
  const senderId = fromMe ? 'me' : msg.key.participant || msg.key.remoteJid;
  const senderName = msg.pushName || (fromMe ? 'Me' : senderId?.split('@')[0] || 'Unknown');
  const messageId = msg.key.id;
  const text = extractText(msg);
  const timestamp = getTimestamp(msg);
  const visibleType = msgTypes.find((k) => !INVISIBLE_MSG_TYPES.has(k)) || msgTypes[0];
  const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(visibleType);
  const displayText = text || (isMedia ? '[Media]' : '');

  return {
    messageId,
    groupId,
    sender: senderId,
    senderType: 'whatsapp',
    senderName,
    text: displayText,
    timestamp,
    deleted: false,
    _isMedia: isMedia,
    _visibleType: visibleType,
  };
};

const processIncomingMessage = async (sessionId, msg, isHistorical = false) => {
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) return;
  const rt = getRt(sessionId);
  const mId = msg.key.id;
  const rawJid = msg.key.remoteJid;

  const transformed = transformWAMessage(msg);
  if (!transformed) return;

  const canonicalJid = await resolveCanonicalJid(sessionId, rawJid);
  if (canonicalJid !== rawJid) {
    transformed.groupId = canonicalJid;
  }

  const { groupId, messageId, _isMedia, _visibleType, timestamp } = transformed;

  let mediaUrl = null;
  let mediaType = null;

  const persistMedia =
    _isMedia &&
    settingsService.shouldPersistIncomingMedia(sid, groupId, _visibleType);

  if (persistMedia && rt.sock) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: rt.sock?.updateMediaMessage,
        }
      );
      mediaUrl = await uploadFromBuffer(buffer);
      mediaType = _visibleType.replace('Message', '');
    } catch (err) {
      console.error(`[WA ${sidOf(sessionId)}] Media upload:`, err.message);
    }
  }

  const finalData = {
    tenantId,
    sessionId: sid,
    ...transformed,
    mediaUrl,
    mediaType,
  };
  delete finalData._isMedia;
  delete finalData._visibleType;

  let existing = null;
  try {
    existing = await Message.findOne({ tenantId, sessionId: sid, messageId: mId }).lean();
  } catch {
    /* ignore */
  }

  /** WhatsApp echoes CRM sends as *Name*\\n…; keep the CRM row we already saved so refresh/sync does not replace plain text with wire format. */
  if (existing?.senderType === 'crm_user' && typeof existing.text === 'string') {
    finalData.text = existing.text;
    finalData.sender = existing.sender;
    finalData.senderType = 'crm_user';
    if (existing.senderName) finalData.senderName = existing.senderName;
  }

  const lastPreview =
    finalData.senderType === 'crm_user' && finalData.senderName
      ? `${finalData.senderName}: ${(finalData.text || '').trim()}`.trim()
      : finalData.text || '';

  try {
    await Message.updateOne(
      { tenantId, sessionId: sid, messageId },
      { $set: finalData },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) {
      console.error(`[WA ${sidOf(sessionId)}] DB write:`, err.message);
    }
  }

  emitSession(sessionId, 'new_message', {
    ...finalData,
    timestamp: timestamp.toISOString(),
  });

  emitSession(sessionId, 'chat_updated', {
    groupId,
    lastMessage: lastPreview,
    lastMessageTimestamp: timestamp.toISOString(),
  });

  try {
    const chatName = msg.pushName || groupId.split('@')[0];
    await Group.findOneAndUpdate(
      { tenantId, sessionId: sid, groupId },
      {
        $set: { tenantId, lastMessage: lastPreview, lastMessageTimestamp: timestamp },
        $setOnInsert: {
          name: chatName,
          isGroup: groupId.endsWith('@g.us'),
          isBackupEnabled: false,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[WA ${sidOf(sessionId)}] Group update:`, err.message);
  }
};

const handleConnectionUpdate = async (sessionId, update) => {
  const { connection, lastDisconnect, qr } = update;
  const sid = parseSid(sessionId);
  const rt = getRt(sessionId);

  if (qr) {
    rt.connectionStatus = 'QR_PENDING';
    console.log(`[WA ${sidOf(sessionId)}] QR…`);
    try {
      rt.qrCode = await QRCode.toDataURL(qr, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch {
      rt.qrCode = qr;
    }
    emitSession(sessionId, 'connectionStatus', { status: 'QR_PENDING', qr: rt.qrCode });
  }

  if (connection === 'open') {
    rt.qrCode = null;
    rt.connectionStatus = 'CONNECTED';
    rt.reconnectAttempts = 0;

    console.log(`[WA ${sidOf(sessionId)}] Connected`);
    emitSession(sessionId, 'connectionStatus', { status: 'CONNECTED' });

    try {
      const wid = rt.sock?.user?.id;
      if (wid) await WaSession.findByIdAndUpdate(sid, { wid });
    } catch {
      /* ignore */
    }

    syncChats(sessionId);
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message || 'unknown';

    rt.qrCode = null;
    rt.connectionStatus = 'DISCONNECTED';

    console.log(`[WA ${sidOf(sessionId)}] Closed: ${statusCode} ${reason}`);

    emitSession(sessionId, 'connectionStatus', { status: 'DISCONNECTED' });

    const isBadSession =
      statusCode === DisconnectReason.loggedOut ||
      statusCode === DisconnectReason.badSession ||
      statusCode === 401 ||
      statusCode === 405;

    if (isBadSession) {
      console.log(`[WA ${sidOf(sessionId)}] Clearing auth…`);
      await AuthSession.deleteMany({ sessionId: sid });
      await new Promise((r) => setTimeout(r, 2000));
      rt.reconnectAttempts = 0;
      connect(sessionId);
    } else if (!rt.isShuttingDown) {
      scheduleReconnect(sessionId);
    }
  }
};

const connect = async (sessionId) => {
  const sid = parseSid(sessionId);
  const sidStr = sidOf(sessionId);
  const rt = getRt(sessionId);
  if (rt.isShuttingDown) return;

  destroySocket(sessionId);

  rt.connectionStatus = 'CONNECTING';
  emitSession(sessionId, 'connectionStatus', { status: 'CONNECTING' });

  try {
    const { state, saveCreds } = await useMongoDBAuthState(sid);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA ${sidStr}] Baileys v${version.join('.')} (latest: ${isLatest})`);

    rt.sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.macOS('Chrome'),
      /** Full phone history on link is heavy; set true via env if you need deep backfill */
      syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === 'true',
      printQRInTerminal: false,
      /** Helps receive message notifications reliably as a linked device */
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      /** Must be true — if false, WhatsApp drops MD sync payloads and many chats stop updating */
      shouldSyncHistoryMessage: () => true,

      getMessage: async (key) => {
        try {
          const tenantId = await getTenantIdForSession(sid);
          const row = await Message.findOne({ tenantId, sessionId: sid, messageId: key.id }).lean();
          if (!row || row.text == null) return undefined;
          const t = normalizeNewlines(String(row.text));
          if (!t) return undefined;
          /** WA expects extended payload when the body has line breaks; conversation-only flattens multi-line. */
          if (t.includes('\n') || t.length > 4096 || /https?:\/\//i.test(t)) {
            return { extendedTextMessage: { text: t } };
          }
          return { conversation: t };
        } catch {
          return undefined;
        }
      },

      cachedGroupMetadata: async (jid) => {
        let meta = rt.groupMetadataCache.get(jid);
        if (!meta) {
          const tenantId = await getTenantIdForSession(sid);
          const group = await Group.findOne({ tenantId, sessionId: sid, groupId: jid });
          if (group?.name) {
            meta = {
              id: group.groupId,
              subject: group.name,
              participants: group.participants?.map((id) => ({ id, admin: null })),
            };
            rt.groupMetadataCache.set(jid, meta);
          }
        }
        return meta;
      },

      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
    });

    rt.sock.ev.process(async (events) => {
      if (events['creds.update']) saveCreds();

      if (events['connection.update']) {
        await handleConnectionUpdate(sessionId, events['connection.update']);
      }

      /* Phone history sync disabled per product direction — skip heavy processing */
      if (events['messaging-history.set']) {
        const { chats, messages } = events['messaging-history.set'];
        if (chats?.length) {
          for (const chat of chats) {
            const jid = chat.id;
            if (!jid || jid === 'status@broadcast') continue;
            try {
              const ts = chat.conversationTimestamp
                ? new Date(Number(chat.conversationTimestamp) * 1000)
                : new Date();
              const chatName = chat.name || jid.split('@')[0] || jid;
              const canonicalJid = chat.lid && chat.lid.endsWith('@lid') ? chat.lid : jid;
              const phoneJidForLid =
                chat.lid && chat.lid.endsWith('@lid') ? jid : undefined;

              const updateData = {
                $set: {
                  name: chatName,
                  isGroup: canonicalJid.endsWith('@g.us'),
                  lastMessageTimestamp: ts,
                },
                $setOnInsert: { isBackupEnabled: false, participants: [] },
              };
              if (phoneJidForLid) updateData.$set.phoneJid = phoneJidForLid;

              await Group.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: canonicalJid },
                updateData,
                { upsert: true }
              );
            } catch {
              /* ignore */
            }
          }
        }
        if (messages?.length) {
          for (const msg of messages) {
            try {
              await processIncomingMessage(sessionId, msg, true);
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (events['messages.upsert']) {
        const { messages } = events['messages.upsert'];
        for (const msg of messages) {
          try {
            await processIncomingMessage(sessionId, msg, false);
          } catch (err) {
            console.error(`[WA ${sidStr}] upsert:`, err.message);
          }
        }
      }

      if (events['messages.update']) {
        for (const update of events['messages.update']) {
          try {
            const isRevocation =
              update.update?.message?.protocolMessage?.type === 0 ||
              update.update?.revocation;
            if (isRevocation) {
              const msgId = update.key.id;
              const groupId = update.key.remoteJid;
              await Message.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, messageId: msgId },
                { deleted: true }
              );
              emitSession(sessionId, 'message_deleted', { messageId: msgId, groupId });
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (events['contacts.upsert']) {
        for (const contact of events['contacts.upsert']) {
          const phoneJid = contact.id;
          const lidJid = contact.lid;
          if (!phoneJid || phoneJid === 'status@broadcast') continue;
          const contactName =
            contact.name ||
            contact.verifiedName ||
            contact.notify ||
            phoneJid.split('@')[0];
          try {
            if (lidJid && lidJid.endsWith('@lid')) {
              await Group.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: lidJid },
                {
                  $set: { tenantId: await getTenantIdForSession(sid), name: contactName, isGroup: false, phoneJid },
                  $setOnInsert: {
                    lastMessageTimestamp: new Date(),
                    isBackupEnabled: false,
                    participants: [],
                  },
                },
                { upsert: true }
              );
            } else {
              await Group.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: phoneJid },
                {
                  $set: { tenantId: await getTenantIdForSession(sid), name: contactName, isGroup: false },
                  $setOnInsert: {
                    lastMessageTimestamp: new Date(),
                    isBackupEnabled: false,
                    participants: [],
                  },
                },
                { upsert: true }
              );
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (events['contacts.update']) {
        for (const update of events['contacts.update']) {
          if (update.id && (update.name || update.verifiedName)) {
            try {
              await Group.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: update.id },
                { name: update.name || update.verifiedName },
                { upsert: true }
              );
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (events['groups.upsert']) {
        for (const group of events['groups.upsert']) {
          rt.groupMetadataCache.set(group.id, group);
          try {
            await Group.findOneAndUpdate(
              { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: group.id },
              {
                $set: {
                  tenantId: await getTenantIdForSession(sid),
                  name: group.subject,
                  participants: group.participants?.map((p) => p.id),
                  isGroup: true,
                },
                $setOnInsert: { lastMessageTimestamp: new Date(), isBackupEnabled: false },
              },
              { upsert: true }
            );
          } catch {
            /* ignore */
          }
        }
      }

      if (events['groups.update']) {
        for (const update of events['groups.update']) {
          if (update.id && update.subject) {
            const cached = rt.groupMetadataCache.get(update.id);
            if (cached) {
              rt.groupMetadataCache.set(update.id, { ...cached, subject: update.subject });
            }
            try {
              await Group.findOneAndUpdate(
                { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: update.id },
                { name: update.subject },
                { upsert: true }
              );
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (events['group-participants.update']) {
        const upd = events['group-participants.update'];
        const gid = upd.id;
        try {
          const group = await Group.findOne({ tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: gid });
          if (group) {
            let pts = group.participants || [];
            if (upd.action === 'add') pts.push(...upd.participants);
            if (upd.action === 'remove')
              pts = pts.filter((p) => !upd.participants.includes(p));

            await Group.findOneAndUpdate(
              { tenantId: await getTenantIdForSession(sid), sessionId: sid, groupId: gid },
              { participants: [...new Set(pts)] }
            );

            const cached = rt.groupMetadataCache.get(gid);
            if (cached) {
              cached.participants = pts.map((id) => ({ id, admin: null }));
              rt.groupMetadataCache.set(gid, cached);
            }
          }
        } catch {
          /* ignore */
        }
      }
    });

    console.log(`[WA ${sidStr}] Socket ready`);
  } catch (err) {
    console.error(`[WA ${sidStr}] connect failed:`, err.message);
    rt.connectionStatus = 'DISCONNECTED';
    emitSession(sessionId, 'connectionStatus', { status: 'DISCONNECTED' });
    scheduleReconnect(sessionId);
  }
};

const initBaileys = async (io) => {
  ioSingleton = io;
  await settingsService.initAllSessions(WaSession);

  const sessions = await WaSession.find({}).sort({ sortOrder: 1, createdAt: 1 }).lean();
  for (const s of sessions) {
    connect(s._id.toString()).catch((e) =>
      console.error('[Baileys] connect', s._id, e.message)
    );
  }
};

const manualReconnect = async (sessionId) => {
  const rt = getRt(sessionId);
  rt.reconnectAttempts = 0;
  await connect(sessionId);
};

const sendMessage = async (sessionId, jid, text, crmUser) => {
  const rt = getRt(sessionId);
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) throw new Error('Session tenant not found');
  if (!rt.sock) throw new Error('WhatsApp is not connected. Use reconnect.');
  if (rt.connectionStatus !== 'CONNECTED') {
    throw new Error(`WhatsApp is ${rt.connectionStatus}.`);
  }

  const userNickname = crmUser?.nickname || crmUser?.username || 'CRM';
  const waPayloadText = formatWhatsAppBodyFromCrm(userNickname, text);
  let sentMsg;
  try {
    sentMsg = await rt.sock.sendMessage(jid, { text: waPayloadText });
  } catch (err) {
    console.error('[WA] sendMessage:', err);
    throw new Error(`WhatsApp send failed: ${err.message}`);
  }

  if (!sentMsg?.key?.id) throw new Error('No message ID from WhatsApp');

  const messageId = sentMsg.key.id;
  const timestamp = new Date();

  const messageData = {
    tenantId,
    sessionId: sid,
    messageId,
    groupId: jid,
    sender: crmUser?._id?.toString() || 'me',
    senderType: 'crm_user',
    senderName: userNickname,
    text,
    mediaUrl: null,
    mediaType: null,
    timestamp,
    deleted: false,
  };

  try {
    await Message.updateOne(
      { tenantId, sessionId: sid, messageId },
      { $set: messageData },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) console.error('[WA] sendMessage DB:', err.message);
  }

  const preview = `${userNickname}: ${text}`;

  try {
    await Group.findOneAndUpdate(
      { tenantId, sessionId: sid, groupId: jid },
      { tenantId, lastMessage: preview, lastMessageTimestamp: timestamp },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    console.error('[WA] Group update:', err.message);
  }

  emitSession(sessionId, 'new_message', {
    ...messageData,
    timestamp: timestamp.toISOString(),
  });
  emitSession(sessionId, 'chat_updated', {
    groupId: jid,
    lastMessage: preview,
    lastMessageTimestamp: timestamp.toISOString(),
  });

  return sentMsg;
};

const sendMedia = async (sessionId, jid, buffer, type, caption, crmUser, fileMeta = {}) => {
  const rt = getRt(sessionId);
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) throw new Error('Session tenant not found');
  if (!rt.sock) throw new Error('WhatsApp is not connected');
  if (rt.connectionStatus !== 'CONNECTED') {
    throw new Error(`WhatsApp is ${rt.connectionStatus}.`);
  }

  assertCloudinaryConfigured();

  const userNickname = crmUser?.nickname || crmUser?.username || 'CRM';
  const finalCaption = (caption || '').trim();
  const waFileName = safeWAFileName(fileMeta.fileName, type === 'document' ? 'document.pdf' : 'file');
  const waMime = fileMeta.mimetype || (type === 'document' ? 'application/pdf' : 'application/octet-stream');

  /** Persist to Cloudinary first so CRM always has a CDN URL even if WA send fails mid-flight. */
  let mediaUrl = null;
  try {
    if (type === 'image') {
      mediaUrl = await uploadImageBuffer(buffer);
    } else if (type === 'document') {
      mediaUrl = await uploadDocumentBuffer(buffer);
    } else {
      mediaUrl = await uploadFromBuffer(buffer, {
        resource_type: 'auto',
        folder: `whatsapp-crm/${type}`,
      });
    }
  } catch (err) {
    console.error('[WA] Cloudinary upload:', err.message);
    throw new Error(
      err.code === 'CLOUDINARY_CONFIG'
        ? err.message
        : `Cloudinary upload failed: ${err.message}. Check credentials and file size.`
    );
  }

  const mediaLabel =
    type === 'image' ? '📷' : type === 'video' ? '🎬' : type === 'audio' ? '🎤' : '📎';
  const waCaption =
    type === 'audio'
      ? undefined
      : formatWhatsAppCaptionFromCrm(userNickname, finalCaption, mediaLabel);

  const content =
    type === 'image'
      ? { image: buffer, caption: waCaption }
      : type === 'video'
      ? { video: buffer, caption: waCaption }
      : type === 'audio'
      ? { audio: buffer }
      : {
          document: buffer,
          mimetype: waMime,
          fileName: waFileName,
          caption: waCaption,
        };

  let sentMsg;
  try {
    sentMsg = await rt.sock.sendMessage(jid, content);
  } catch (err) {
    console.error('[WA] sendMedia:', err);
    throw new Error(`WhatsApp media send failed: ${err.message}`);
  }

  if (!sentMsg?.key?.id) throw new Error('No message ID from WhatsApp');

  const messageId = sentMsg.key.id;
  const timestamp = new Date();

  const displayText =
    finalCaption ||
    (type === 'document' ? waFileName : '');

  const messageData = {
    tenantId,
    sessionId: sid,
    messageId,
    groupId: jid,
    sender: crmUser?._id?.toString() || 'me',
    senderType: 'crm_user',
    senderName: userNickname,
    text: displayText,
    mediaUrl,
    mediaType: type,
    timestamp,
    deleted: false,
  };

  try {
    await Message.updateOne(
      { tenantId, sessionId: sid, messageId },
      { $set: messageData },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) console.error('[WA] sendMedia DB:', err.message);
  }

  const previewEmoji =
    type === 'image' ? '📷' : type === 'document' ? '📄' : type === 'video' ? '🎬' : type === 'audio' ? '🎤' : '📎';
  const mediaPreview = `${userNickname}: ${finalCaption || previewEmoji}`;

  try {
    await Group.findOneAndUpdate(
      { tenantId, sessionId: sid, groupId: jid },
      { tenantId, lastMessage: mediaPreview, lastMessageTimestamp: timestamp },
      { returnDocument: 'after' }
    );
  } catch (err) {
    console.error('[WA] Group update:', err.message);
  }

  emitSession(sessionId, 'new_message', {
    ...messageData,
    timestamp: timestamp.toISOString(),
  });
  emitSession(sessionId, 'chat_updated', {
    groupId: jid,
    lastMessage: mediaPreview,
    lastMessageTimestamp: timestamp.toISOString(),
  });

  return { key: sentMsg.key, messageId: sentMsg.key.id, mediaUrl, mediaType: type };
};

const logoutWhatsApp = async (sessionId) => {
  const rt = getRt(sessionId);
  const sid = parseSid(sessionId);
  rt.isShuttingDown = true;
  if (rt.sock) {
    try {
      await rt.sock.logout();
    } catch {
      /* ignore */
    }
  }
  destroySocket(sessionId);
  await AuthSession.deleteMany({ sessionId: sid });
  rt.qrCode = null;
  rt.connectionStatus = 'DISCONNECTED';
  rt.reconnectAttempts = 0;
  rt.isShuttingDown = false;
  emitSession(sessionId, 'connectionStatus', { status: 'DISCONNECTED' });
  console.log(`[WA ${sidOf(sessionId)}] Logged out`);
};

const fetchChatHistory = async (sessionId, jid, count = 100) => {
  const sid = parseSid(sessionId);
  const tenantId = await getTenantIdForSession(sid);
  if (!tenantId) return [];
  /* Intentionally DB-only — no phone pull (see product: skip sync) */
  return Message.find({ tenantId, sessionId: sid, groupId: jid })
    .sort({ timestamp: -1 })
    .limit(count)
    .then((rows) => rows.reverse());
};

const getStatus = (sessionId) => {
  const rt = getRt(sessionId);
  return {
    status: rt.connectionStatus,
    qr: rt.qrCode,
    reconnectAttempts: rt.reconnectAttempts,
  };
};

const getSock = (sessionId) => getRt(sessionId).sock;

module.exports = {
  initBaileys,
  connect,
  manualReconnect,
  sendMessage,
  sendMedia,
  syncChats,
  syncMessages,
  logoutWhatsApp,
  getStatus,
  getSock,
  fetchChatHistory,
};
