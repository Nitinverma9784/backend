const Message = require('../models/message.model');
const Chat = require('../models/chat.model');
const Contact = require('../models/contact.model');
const Group = require('../models/group.model');
const { downloadMediaMessage, proto } = require('@whiskeysockets/baileys');

/**
 * Message Extractor & Saver Logic (Deduplication using key.id)
 */
const processMessage = async (sessionId, msg, type = 'notify') => {
  try {
    const { key, pushName, message, messageTimestamp } = msg;
    const mId = key.id;
    const chatId = key.remoteJid;
    const fromMe = key.fromMe;
    const sender = fromMe ? 'me' : (key.participant || chatId);
    const timestamp = messageTimestamp 
      ? new Date((typeof messageTimestamp === 'object' ? messageTimestamp.low : messageTimestamp) * 1000)
      : new Date();

    if (!chatId || chatId === 'status@broadcast') return;
    if (!message) return;

    // Deduplication check
    const existing = await Message.findOne({ messageId: mId });
    if (existing) return;

    // Content extraction (Basic text support, easily extendable for media)
    const text = message.conversation || 
                 message.extendedTextMessage?.text || 
                 message.imageMessage?.caption || 
                 message.videoMessage?.caption || "";
    
    const isMedia = !!(message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage);
    const mediaType = isMedia ? Object.keys(message).find(k => k.endsWith('Message')).replace('Message', '') : null;

    // Final Data Construction
    const data = {
      messageId: mId,
      chatId,
      sessionOwner: sessionId,
      sender,
      senderName: pushName || sender.split('@')[0],
      text,
      fromMe,
      timestamp,
      isMedia,
      mediaType,
      quotedMessageId: message.extendedTextMessage?.contextInfo?.stanzaId,
    };

    // DB SAVE
    await Message.create(data);

    // Update Chat sidebar/meta
    await Chat.findOneAndUpdate(
      { chatId, sessionOwner: sessionId },
      { 
        lastMessage: text || (isMedia ? `[${mediaType}]` : ""),
        lastMessageTimestamp: timestamp,
        $inc: { unreadCount: (fromMe || type === 'append') ? 0 : 1 }
      },
      { upsert: true }
    );

    return data;

  } catch (err) {
    console.error(`[EventHandler] Error processing message ${msg.key.id}:`, err.message);
    return null;
  }
};

/**
 * FULL EVENT HANDLER IMPLEMENTATION
 * Using sock.ev.process for reliable batch processing
 */
const bindEvents = (sessionId, sock, io = null) => {
  sock.ev.process(async (events) => {
    
    // ─── Connection Updates ───────────────────────────────────────────────────
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;
      
      const statusData = {
        sessionId,
        status: connection || 'CONNECTING',
        qr: qr || null,
      };

      if (qr) console.log(`[WA] Session ${sessionId} QR generated.`);
      if (connection === 'open') console.log(`[WA] Session ${sessionId} CONNECTED.`);
      
      // Emit to frontend
      if (io) io.emit('connectionStatus', statusData);

      if (connection === 'close') {
        const error = lastDisconnect?.error;
        console.log(`[WA] Session ${sessionId} Closed: ${error?.message || 'unknown'}`);
      }
    }

    // ─── Messages Upsert (Loop through all in batch) ───────────────────────────
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      for (const msg of upsert.messages) {
        const processed = await processMessage(sessionId, msg, upsert.type);
        if (processed && io) {
          // Emit only new messages to the chat's room
          io.to(processed.chatId).emit('newMessage', processed);
        }
      }
    }

    // ─── History Sync (Initial download) ───────────────────────────────────────
    if (events['messaging-history.set']) {
      const { chats, contacts, messages, isLatest } = events['messaging-history.set'];
      console.log(`[WA] History sync for ${sessionId}: ${messages.length} messages.`);
      
      // Batch save chats
      if (chats?.length) {
        for (const chat of chats) {
          await Chat.findOneAndUpdate(
            { chatId: chat.id, sessionOwner: sessionId },
            { 
              name: chat.name || chat.id.split('@')[0],
              isGroup: chat.id.endsWith('@g.us'),
            },
            { upsert: true }
          );
        }
      }

      // Batch process historical messages
      for (const msg of messages) {
        await processMessage(sessionId, msg, 'append');
      }
    }

    // ─── Groups Handling ──────────────────────────────────────────────────────
    if (events['groups.upsert'] || events['groups.update']) {
      const gUpdates = events['groups.upsert'] || events['groups.update'];
      for (const group of gUpdates) {
        await Group.findOneAndUpdate(
          { groupId: group.id, sessionOwner: sessionId },
          { 
            name: group.subject,
            description: group.desc,
            participants: group.participants?.map(p => p.id),
            admins: group.participants?.filter(p => p.admin).map(p => p.id),
          },
          { upsert: true }
        );
        // Refresh local cache if available on sock
        if (sock.groupMetadataCache) sock.groupMetadataCache.set(group.id, group);
      }
    }

    if (events['group-participants.update']) {
      const { id, participants, action } = events['group-participants.update'];
      const group = await Group.findOne({ groupId: id, sessionOwner: sessionId });
      if (group) {
        if (action === 'add') group.participants = [...new Set([...group.participants, ...participants])];
        if (action === 'remove') group.participants = group.participants.filter(p => !participants.includes(p));
        await group.save();
      }
    }

    // ─── Contacts & Chats ──────────────────────────────────────────────────────
    if (events['contacts.upsert'] || events['contacts.update']) {
      const cUpdates = events['contacts.upsert'] || events['contacts.update'];
      for (const contact of cUpdates) {
        await Contact.findOneAndUpdate(
          { jid: contact.id, sessionOwner: sessionId },
          { name: contact.name, nickname: contact.notify || contact.verifiedName },
          { upsert: true }
        );
      }
    }

    if (events['chats.upsert']) {
      for (const chat of events['chats.upsert']) {
        await Chat.findOneAndUpdate(
          { chatId: chat.id, sessionOwner: sessionId },
          { name: chat.name || chat.id.split('@')[0] },
          { upsert: true }
        );
      }
    }

  });
};

module.exports = { bindEvents };
