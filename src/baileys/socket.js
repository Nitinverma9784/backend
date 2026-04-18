const { 
  default: makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  Browsers,
  initAuthCreds,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const AuthSession = require('../models/auth-session.model'); // Move to correct path
const Message = require('../models/message.model');
const { BufferJSON } = require('@whiskeysockets/baileys');

/**
 * Helper to use MongoDB as Auth State (Multi-session support)
 */
const useMongoDBAuthState = async (sessionId) => {
  const readData = async (id) => {
    try {
      const dbId = `${sessionId}-${id}`;
      const session = await AuthSession.findOne({ id: dbId }).lean();
      return session ? JSON.parse(session.data, BufferJSON.reviver) : null;
    } catch (err) {
      return null;
    }
  };

  const writeData = async (id, data) => {
    try {
      const dbId = `${sessionId}-${id}`;
      if (data == null) {
        await AuthSession.deleteOne({ id: dbId });
      } else {
        await AuthSession.findOneAndUpdate(
          { id: dbId },
          { id: dbId, data: JSON.stringify(data, BufferJSON.replacer) },
          { upsert: true }
        );
      }
    } catch (err) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();
  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const res = {};
        await Promise.all(ids.map(async (id) => {
          let value = await readData(`${type}-${id}`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          res[id] = value;
        }));
        return res;
      },
      set: async (data) => {
        const writes = [];
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            writes.push(writeData(`${category}-${id}`, data[category][id]));
          }
        }
        await Promise.all(writes);
      }
    }
  };

  return { 
    state, 
    saveCreds: () => writeData('creds', state.creds) 
  };
};

/**
 * Factory for creating a production Baileys Socket
 */
const createSocket = async (sessionId, options = {}) => {
  const logger = pino({ level: options.logLevel || 'silent' });
  const { state, saveCreds } = await useMongoDBAuthState(sessionId);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  
  // Cache for group metadata to avoid rate-limits
  const groupMetadataCache = new NodeCache({ stdTTL: 600 }); 

  const sock = makeWASocket({
    auth: state,
    logger,
    version,
    printQRInTerminal: options.printQR || false,
    
    // Core Configuration
    syncFullHistory: true,
    markOnlineOnConnect: false, // Don't steal phone's notifications
    browser: Browsers.macOS('Chrome'),
    
    // Timeouts and Intervals
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    
    // Media & UI
    generateHighQualityLinkPreview: true,
    emitOwnEvents: false,
    fireInitQueries: true,
    
    // Group Metadata Cache (Indispensable for multi-user)
    cachedGroupMetadata: async (jid) => {
      const cached = groupMetadataCache.get(jid);
      if (cached) return cached;
      // You can also add MongoDB fetch here if needed
      return undefined;
    },

    // Decryption / Retry Store
    msgRetryCounterMap: options.msgRetryCounterMap || {},

    // Critical: getMessage for resending & poll decryption
    getMessage: async (key) => {
      try {
        const dbMsg = await Message.findOne({ messageId: key.id });
        if (dbMsg) {
          // Wrap text in conversation proto for Baileys compatibility
          return { conversation: dbMsg.text || '' };
        }
        return undefined;
      } catch (err) {
        return undefined;
      }
    }
  });

  // Export internal cache so we can sync it from event handler
  sock.groupMetadataCache = groupMetadataCache;

  // Bind saving of creds
  sock.ev.on('creds.update', saveCreds);

  return sock;
};

module.exports = { createSocket };
