const mongoose = require('mongoose');
const {
  getStatus,
  sendMessage,
  sendMedia,
  logoutWhatsApp,
  syncMessages,
  manualReconnect,
  fetchChatHistory,
  connect,
} = require('../services/baileys.service');
const settingsService = require('../services/settings.service');
const Group = require('../models/group.model');
const Message = require('../models/message.model');
const User = require('../models/user.model');
const Setting = require('../models/setting.model');
const WaSession = require('../models/wa-session.model');
const AuthSession = require('../models/auth-session.model');

const parseSid = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const isSuperAdmin = (reqUser) => reqUser?.role === 'master' && reqUser?.username === 'masteradmin';

const tenantFilter = (reqUser) => (isSuperAdmin(reqUser) ? {} : { tenantId: reqUser.tenantId });

const enforceSessionAccess = async (reqUser, sessionId) => {
  const sid = typeof sessionId === 'string' ? sessionId : sessionId.toString();
  const exists = await WaSession.exists({ _id: sessionId, ...tenantFilter(reqUser) });
  if (!exists) return false;
  const user = await User.findById(reqUser.id).lean();
  if (!user) return false;
  if (reqUser.role === 'master') return true;
  const assigned = (user.assignedSessions || []).map(String);
  return assigned.includes(sid);
};

const enforceGroupAccess = async (reqUser, sessionId, groupId) => {
  const ok = await enforceSessionAccess(reqUser, sessionId);
  if (!ok) return false;
  const user = await User.findById(reqUser.id).lean();
  if (!user) return false;
  if (reqUser.role === 'master') return true;
  if ((user.assignedGroups || []).length === 0) return true;
  return (user.assignedGroups || []).includes(groupId);
};

// ─── Sessions ────────────────────────────────────────────────────────────────

const listSessions = async (req, res) => {
  try {
    let sessions;
    if (req.user.role === 'master') {
      sessions = await WaSession.find(tenantFilter(req.user))
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
    } else {
      const user = await User.findById(req.user.id).lean();
      if (!user?.assignedSessions?.length) return res.json([]);
      sessions = await WaSession.find({ ...tenantFilter(req.user), _id: { $in: user.assignedSessions } })
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
    }
    const out = sessions.map((s) => ({
      ...s,
      wid: req.user.role === 'sub' ? undefined : s.wid,
      connection: getStatus(s._id),
    }));
    res.json(out);
  } catch (err) {
    console.error('[listSessions]', err.message);
    res.status(500).json({ message: err.message });
  }
};

const createSession = async (req, res) => {
  try {
    const { label } = req.body;
    const name = (label || 'WhatsApp number').trim().slice(0, 80);
    const s = await WaSession.create({
      tenantId: req.user.tenantId,
      label: name,
      createdBy: req.user.id,
      sortOrder: Date.now(),
    });
    await settingsService.refreshCache(s._id);
    connect(s._id.toString()).catch((e) => console.error('[createSession] connect', e.message));
    res.status(201).json(s);
  } catch (err) {
    console.error('[createSession]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ─── Status ───────────────────────────────────────────────────────────────────

const getWAStatus = async (req, res) => {
  const sid = parseSid(req.params.sessionId);
  if (!sid) return res.status(400).json({ message: 'Invalid session' });
  if (!(await enforceSessionAccess(req.user, sid))) {
    return res.status(403).json({ message: 'No access to this session' });
  }
  res.json(getStatus(sid));
};

const connectWA = async (req, res) => {
  if (req.user.role !== 'master') {
    return res.status(403).json({ message: 'Only master admin can trigger reconnect' });
  }
  const sid = parseSid(req.params.sessionId);
  if (!sid) return res.status(400).json({ message: 'Invalid session' });
  try {
    await manualReconnect(sid);
    res.json({ success: true, message: 'Reconnecting...' });
  } catch (err) {
    console.error('[connectWA]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ─── Groups ───────────────────────────────────────────────────────────────────

const getAllGroups = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    if (!(await enforceSessionAccess(req.user, sid))) {
      return res.status(403).json({ message: 'No access' });
    }

    let groups;
    if (req.user.role === 'master') {
      groups = await Group.find({ ...tenantFilter(req.user), sessionId: sid }).sort({ lastMessageTimestamp: -1 });
    } else {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const filter = { ...tenantFilter(req.user), sessionId: sid };
      if ((user.assignedGroups || []).length > 0) {
        filter.groupId = { $in: user.assignedGroups };
      }
      groups = await Group.find(filter).sort({ lastMessageTimestamp: -1 });
    }
    res.json(groups);
  } catch (err) {
    console.error('[getAllGroups]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ─── Messages ─────────────────────────────────────────────────────────────────

const getMessages = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId } = req.params;
    const { before } = req.query;

    if (!(await enforceGroupAccess(req.user, sid, groupId))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const jidsToQuery = [groupId];
    const group = await Group.findOne({ ...tenantFilter(req.user), sessionId: sid, groupId }).lean();
    if (group?.phoneJid) jidsToQuery.push(group.phoneJid);

    const query = { ...tenantFilter(req.user), sessionId: sid, groupId: { $in: jidsToQuery } };
    if (before) query.timestamp = { $lt: new Date(before) };

    const messages = await Message.find(query).sort({ timestamp: -1 }).limit(150);
    res.json(messages.reverse());
  } catch (err) {
    console.error('[getMessages]', err.message);
    res.status(500).json({ message: err.message });
  }
};

const sendWAMessage = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId, text } = req.body;
    if (!groupId || !text?.trim()) {
      return res.status(400).json({ message: 'groupId and text are required' });
    }

    if (!(await enforceGroupAccess(req.user, sid, groupId))) {
      return res.status(403).json({ message: 'No access' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const result = await sendMessage(sid, groupId, text, user);
    res.json({ success: true, messageId: result?.key?.id });
  } catch (err) {
    console.error('[sendWAMessage]', err.message);
    res.status(500).json({ message: err.message });
  }
};

const sendWAMedia = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId, text } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ message: 'No file uploaded' });
    if (!groupId) return res.status(400).json({ message: 'groupId is required' });

    if (!file.mimetype.startsWith('image/')) {
      return res.status(400).json({ message: 'Only image files are allowed' });
    }

    if (!(await enforceGroupAccess(req.user, sid, groupId))) {
      return res.status(403).json({ message: 'No access' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const result = await sendMedia(sid, groupId, file.buffer, 'image', text || '', user, {
      mimetype: file.mimetype,
      fileName: file.originalname || 'image',
    });
    res.json({
      success: true,
      messageId: result.messageId,
      mediaUrl: result.mediaUrl,
      mediaType: result.mediaType,
    });
  } catch (err) {
    console.error('[sendWAMedia]', err.message);
    res.status(500).json({ message: err.message });
  }
};

const assignAccess = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const { userId, groupIds, sessionIds } = req.body;
    const target = await User.findOne({ _id: userId, ...tenantFilter(req.user) }).lean();
    if (!target) return res.status(404).json({ message: 'User not found' });
    const update = {};
    if (groupIds !== undefined) update.assignedGroups = groupIds;
    if (sessionIds !== undefined) update.assignedSessions = sessionIds;
    await User.findByIdAndUpdate(userId, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getUsers = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const users = await User.find(tenantFilter(req.user)).select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getSettings = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const sessionRow = await WaSession.findOne({ _id: sid, ...tenantFilter(req.user) }).select('tenantId').lean();
    if (!sessionRow) return res.status(404).json({ message: 'Session not found' });

    let settings = await Setting.findOne({ tenantId: sessionRow.tenantId, waSessionId: sid });
    if (!settings) {
      settings = await Setting.create({
        tenantId: sessionRow.tenantId,
        waSessionId: sid,
        backupEnabled: false,
        perGroupBackup: {},
      });
    }
    res.json({
      ...settings.toObject(),
      cache: settingsService.getCache(sid),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getGroupBackupStatus = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId } = req.params;
    const group = await Group.findOne({ ...tenantFilter(req.user), sessionId: sid, groupId });
    res.json({
      groupId,
      isBackupEnabled: group?.isBackupEnabled === true,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const syncChatHistory = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId } = req.params;
    const count = parseInt(req.query.count, 10) || 100;

    if (!(await enforceGroupAccess(req.user, sid, groupId))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const history = await fetchChatHistory(sid, groupId, count);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateGlobalBackup = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { isEnabled } = req.body;
    await settingsService.setGlobalBackup(sid, isEnabled);
    res.json({ success: true, isBackupEnabled: isEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const toggleGroupBackup = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId } = req.body;
    const enabled = req.body.enabled ?? req.body.isEnabled;
    if (typeof enabled !== 'boolean' || !groupId) {
      return res.status(400).json({ message: 'groupId and enabled/isEnabled required' });
    }
    await settingsService.setGroupBackup(sid, groupId, enabled);
    res.json({ success: true, isBackupEnabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const disableAllBackups = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    await settingsService.disableAllBackups(sid);
    res.json({ success: true, message: 'All backups disabled for this session' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const logoutWA = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    await logoutWhatsApp(sid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const syncGroupMessages = async (req, res) => {
  try {
    const sid = parseSid(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const { groupId } = req.body;
    if (groupId) await syncMessages(sid, groupId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, warning: err.message });
  }
};

/** Master: all groups across sessions — for user assignment UI */
const getAllGroupsFlat = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const groups = await Group.find(tenantFilter(req.user))
      .populate('sessionId', 'label wid')
      .sort({ lastMessageTimestamp: -1 })
      .lean();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getTenants = async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const rows = await WaSession.aggregate([
      { $group: { _id: '$tenantId', sessions: { $sum: 1 }, latest: { $max: '$createdAt' } } },
      { $sort: { latest: -1 } },
    ]);
    const tenantIds = rows.map((r) => r._id);
    const masters = await User.find({ tenantId: { $in: tenantIds }, role: 'master' })
      .select('tenantId username nickname createdAt')
      .lean();
    const masterByTenant = new Map(masters.map((m) => [String(m.tenantId), m]));
    const out = rows.map((r) => ({
      tenantId: String(r._id),
      sessions: r.sessions,
      master: masterByTenant.get(String(r._id)) || null,
      latest: r.latest,
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteTenant = async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const tenantId = req.params.tenantId;
    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({ message: 'Invalid tenantId' });
    }
    const tid = new mongoose.Types.ObjectId(tenantId);
    const sessions = await WaSession.find({ tenantId: tid }).select('_id').lean();
    const sessionIds = sessions.map((s) => s._id);
    for (const sid of sessionIds) {
      try { await logoutWhatsApp(sid); } catch {}
    }
    await Message.deleteMany({ tenantId: tid });
    await Group.deleteMany({ tenantId: tid });
    await Setting.deleteMany({ tenantId: tid });
    await User.deleteMany({ tenantId: tid });
    await WaSession.deleteMany({ tenantId: tid });
    if (sessionIds.length > 0) {
      await AuthSession.deleteMany({ sessionId: { $in: sessionIds } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteUser = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Forbidden' });
  try {
    const userId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    if (String(req.user.id) === String(userId)) {
      return res.status(400).json({ message: 'You cannot delete yourself' });
    }
    const userRow = await User.findOne({ _id: userId, ...tenantFilter(req.user) }).lean();
    if (!userRow) return res.status(404).json({ message: 'User not found' });
    if (userRow.username === 'masteradmin') {
      return res.status(400).json({ message: 'Cannot delete masteradmin' });
    }
    await User.deleteOne({ _id: userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listSessions,
  createSession,
  getWAStatus,
  getAllGroups,
  getMessages,
  sendWAMessage,
  sendWAMedia,
  assignAccess,
  getUsers,
  logoutWA,
  connectWA,
  toggleGroupBackup,
  disableAllBackups,
  syncChatHistory,
  syncGroupMessages,
  getSettings,
  updateGlobalBackup,
  getGroupBackupStatus,
  getAllGroupsFlat,
  getTenants,
  deleteTenant,
  deleteUser,
};
