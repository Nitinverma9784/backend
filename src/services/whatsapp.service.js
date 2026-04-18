const { createSocket } = require('../baileys/socket');
const { bindEvents } = require('../baileys/eventHandler');

class WhatsAppService {
  constructor() {
    this.sessions = new Map(); // Store active socks by sessionId
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  /**
   * Initialize a session for a specific user/admin
   */
  async initSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      if (existing.connectionStatus === 'CONNECTED') {
        console.log(`[WA] Session ${sessionId} already active.`);
        return existing;
      }
      // If broken/half-connected, clean up first
      try { existing.end(); } catch {}
      this.sessions.delete(sessionId);
    }

    console.log(`[WA] Initializing session ${sessionId}...`);
    const sock = await createSocket(sessionId);
    
    // Bind all DB event handlers + Socket.io
    bindEvents(sessionId, sock, this.io);

    // Store in memory
    this.sessions.set(sessionId, sock);

    return sock;
  }

  getSocket(sessionId) {
    return this.sessions.get(sessionId);
  }

  async logout(sessionId) {
    const sock = this.sessions.get(sessionId);
    if (sock) {
      await sock.logout();
      this.sessions.delete(sessionId);
      // Auth data deletion should be handled via the AuthSession model cleaning up sessionId- prefix
    }
  }
}

module.exports = new WhatsAppService();
