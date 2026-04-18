const Setting = require('../models/setting.model');
const Group = require('../models/group.model');
const WaSession = require('../models/wa-session.model');

class SettingsService {
  constructor() {
    /** sessionId string → { globalBackup, perGroupBackup Map } */
    this.cacheBySession = new Map();
    this.initialized = false;
  }

  async getTenantIdBySession(waSessionId) {
    const row = await WaSession.findById(waSessionId).select('tenantId').lean();
    return row?.tenantId || null;
  }

  async init(waSessionId) {
    await this.refreshCache(waSessionId);
    this.initialized = true;
    console.log('[Settings] Initialized session', waSessionId, 'global backup:', this.getCache(waSessionId).globalBackup);
  }

  async initAllSessions(WaSession) {
    const sessions = await WaSession.find({}, '_id').lean();
    for (const s of sessions) {
      await this.refreshCache(s._id);
    }
    this.initialized = true;
    console.log('[Settings] Initialized', sessions.length, 'session caches');
  }

  async refreshCache(waSessionId) {
    const sid = waSessionId.toString();
    const tenantId = await this.getTenantIdBySession(waSessionId);
    if (!tenantId) {
      throw new Error(`Tenant not found for session ${sid}`);
    }
    let settings = await Setting.findOne({ tenantId, waSessionId });
    if (!settings) {
      settings = await Setting.create({
        tenantId,
        waSessionId,
        backupEnabled: false,
        perGroupBackup: {},
      });
      console.log('[Settings] Created defaults for session', sid);
    }

    const entry = {
      globalBackup: settings.backupEnabled,
      perGroupBackup: new Map(Object.entries(settings.perGroupBackup || {})),
    };
    this.cacheBySession.set(sid, entry);

    const groups = await Group.find({ tenantId, sessionId: waSessionId }, 'groupId isBackupEnabled');
    groups.forEach((g) => {
      entry.perGroupBackup.set(g.groupId, g.isBackupEnabled === true);
    });
  }

  isBackupEnabled(waSessionId, groupId) {
    const sid = waSessionId.toString();
    const cache = this.cacheBySession.get(sid);
    if (!cache) return false;
    if (cache.globalBackup === true) return true;
    return cache.perGroupBackup.get(groupId) === true;
  }

  /** Always persist images to CDN/DB layer (CRM preview); heavy backup still follows toggles */
  shouldPersistIncomingMedia(waSessionId, groupId, visibleType) {
    if (visibleType === 'imageMessage') return true;
    return this.isBackupEnabled(waSessionId, groupId);
  }

  isGroupBackupEnabled(waSessionId, groupId) {
    const sid = waSessionId.toString();
    const cache = this.cacheBySession.get(sid);
    if (!cache) return false;
    return cache.perGroupBackup.get(groupId) === true;
  }

  async setGlobalBackup(waSessionId, enabled) {
    const tenantId = await this.getTenantIdBySession(waSessionId);
    if (!tenantId) throw new Error(`Tenant not found for session ${waSessionId}`);
    await Setting.findOneAndUpdate(
      { tenantId, waSessionId },
      { tenantId, backupEnabled: enabled },
      { upsert: true, returnDocument: 'after' }
    );
    const sid = waSessionId.toString();
    if (!this.cacheBySession.has(sid)) {
      this.cacheBySession.set(sid, { globalBackup: enabled, perGroupBackup: new Map() });
    } else {
      this.cacheBySession.get(sid).globalBackup = enabled;
    }
    console.log('[Settings] Session', sid, 'global backup:', enabled);
  }

  async setGroupBackup(waSessionId, groupId, enabled) {
    const tenantId = await this.getTenantIdBySession(waSessionId);
    if (!tenantId) throw new Error(`Tenant not found for session ${waSessionId}`);
    await Group.findOneAndUpdate(
      { tenantId, sessionId: waSessionId, groupId },
      { tenantId, isBackupEnabled: enabled },
      { upsert: true, returnDocument: 'after' }
    );
    await Setting.findOneAndUpdate(
      { tenantId, waSessionId },
      { tenantId, [`perGroupBackup.${groupId}`]: enabled },
      { upsert: true, returnDocument: 'after' }
    );
    const sid = waSessionId.toString();
    if (!this.cacheBySession.has(sid)) {
      await this.refreshCache(waSessionId);
    } else {
      this.cacheBySession.get(sid).perGroupBackup.set(groupId, enabled);
    }
    console.log('[Settings] Session', sid, 'group', groupId, 'backup:', enabled);
  }

  async disableAllBackups(waSessionId) {
    console.log('[Settings] Disabling backups for session', waSessionId);
    const tenantId = await this.getTenantIdBySession(waSessionId);
    if (!tenantId) throw new Error(`Tenant not found for session ${waSessionId}`);
    await Setting.findOneAndUpdate(
      { tenantId, waSessionId },
      { tenantId, backupEnabled: false, perGroupBackup: {} },
      { upsert: true }
    );
    await Group.updateMany({ tenantId, sessionId: waSessionId }, { isBackupEnabled: false });
    const sid = waSessionId.toString();
    const c = this.cacheBySession.get(sid);
    if (c) {
      c.globalBackup = false;
      c.perGroupBackup.clear();
    }
  }

  getCache(waSessionId) {
    const sid = waSessionId.toString();
    const c = this.cacheBySession.get(sid);
    return {
      globalBackup: c?.globalBackup ?? false,
      perGroupBackup: c ? Object.fromEntries(c.perGroupBackup) : {},
    };
  }
}

module.exports = new SettingsService();
