const mongoose = require('mongoose');
const User = require('../models/user.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongooseId = require('mongoose').Types.ObjectId;

const resolveTenantIdForLegacy = async (user) => {
  if (user?.tenantId) return user.tenantId;
  // Fallback: pick first session’s tenantId, else user's id (stable within DB)
  const WaSession = require('../models/wa-session.model');
  const s = await WaSession.findOne({ tenantId: { $exists: true, $ne: null } }).sort({ createdAt: 1 }).lean();
  if (s?.tenantId) return s.tenantId;
  return user?._id ? new mongooseId(user._id) : null;
};

const login = async (req, res) => {
  const { username, password } = req.body;
  
  const userCount = await User.countDocuments();
  if (userCount === 0) {
    const tenantId = new mongooseId();
    const hashedPassword = await bcrypt.hash(password, 10);
    const master = await User.create({
      tenantId,
      username,
      password: hashedPassword,
      role: 'master',
      nickname: 'Master Admin'
    });
    const token = jwt.sign({ id: master._id, username: master.username, role: master.role, tenantId: String(tenantId) }, process.env.JWT_SECRET);
    return res.json({ token, user: { id: master._id, username: master.username, role: master.role, nickname: master.nickname, tenantId: String(tenantId) } });
  }

  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const tenantId = await resolveTenantIdForLegacy(user);
  const token = jwt.sign({ id: user._id, username: user.username, role: user.role, tenantId: String(tenantId) }, process.env.JWT_SECRET);
  res.json({ token, user: { id: user._id, username: user.username, role: user.role, nickname: user.nickname, assignedGroups: user.assignedGroups, tenantId: String(tenantId) } });
};

const registerSubUser = async (req, res) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Only master admin can create users' });
  
  const { username, password, nickname } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  
  try {
    const subUser = await User.create({
      tenantId: req.user.tenantId,
      username,
      password: hashedPassword,
      role: 'sub',
      nickname
    });
    res.json(subUser);
  } catch (err) {
    res.status(400).json({ message: 'User already exists' });
  }
};

const getMe = async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  // Ensure tenantId is present on response (frontend uses it implicitly for isolation)
  if (!user.tenantId && req.user.tenantId) user.tenantId = req.user.tenantId;
  res.json(user);
};

const togglePinnedChat = async (req, res) => {
  try {
    const { sessionId, groupId } = req.body;
    if (!sessionId || !groupId) {
      return res.status(400).json({ message: 'sessionId and groupId are required' });
    }
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ message: 'Invalid sessionId' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const sidStr = String(sessionId);
    if (user.role !== 'master') {
      const allowed = (user.assignedSessions || []).map(String);
      if (!allowed.includes(sidStr)) {
        return res.status(403).json({ message: 'No access to this WhatsApp session' });
      }
      if ((user.assignedGroups || []).length > 0 && !user.assignedGroups.includes(groupId)) {
        return res.status(403).json({ message: 'No access to this chat' });
      }
    }

    const pins = user.pinnedChats || [];
    const exists = pins.some((p) => String(p.sessionId) === sidStr && p.groupId === groupId);

    if (exists) {
      user.pinnedChats = pins.filter(
        (p) => !(String(p.sessionId) === sidStr && p.groupId === groupId)
      );
    } else {
      user.pinnedChats = [...pins, { sessionId, groupId }];
    }

    await user.save();
    res.json({ pinnedChats: user.pinnedChats });
  } catch (err) {
    console.error('[togglePinnedChat]', err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { login, registerSubUser, getMe, togglePinnedChat };
