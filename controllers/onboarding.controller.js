const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const WaSession = require('../models/wa-session.model');
const User = require('../models/user.model');
const settingsService = require('../services/settings.service');
const { connect, getStatus, manualReconnect } = require('../services/baileys.service');

const sharePassword = () => process.env.SHARE_ONBOARD_PASSWORD || 'JUMANJI';
const ONBOARDING_JWT_EXPIRY = '2h';
const newTenantId = () => new mongoose.Types.ObjectId();

const parseSidParam = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

function signOnboardingToken(sessionId) {
  return jwt.sign(
    { purpose: 'share_onboard', sessionId: String(sessionId) },
    process.env.JWT_SECRET,
    { expiresIn: ONBOARDING_JWT_EXPIRY }
  );
}

/** POST /api/onboarding/share/start — body: { password } */
const shareStart = async (req, res) => {
  if (process.env.DISABLE_SHARE_ONBOARD === '1' || process.env.DISABLE_SHARE_ONBOARD === 'true') {
    return res.status(403).json({ message: 'This setup link is disabled' });
  }
  try {
    const pw = req.body?.password;
    if (typeof pw !== 'string' || pw !== sharePassword()) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    const tenantId = newTenantId();
    const s = await WaSession.create({
      tenantId,
      label: 'Shared CRM setup',
      shareOnboarding: true,
      sortOrder: Date.now(),
    });
    await settingsService.refreshCache(s._id);
    connect(s._id.toString()).catch((e) => console.error('[shareStart] connect', e.message));

    const onboardingToken = signOnboardingToken(s._id);
    res.status(201).json({
      sessionId: s._id.toString(),
      onboardingToken,
      expiresIn: ONBOARDING_JWT_EXPIRY,
    });
  } catch (err) {
    console.error('[shareStart]', err.message);
    res.status(500).json({ message: err.message });
  }
};

/** GET /api/onboarding/share/:sessionId/status */
const getShareStatus = async (req, res) => {
  try {
    const sid = parseSidParam(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const doc = await WaSession.findById(sid).lean();
    if (!doc?.shareOnboarding) {
      return res.status(403).json({ message: 'Session is not in setup mode' });
    }
    res.json(getStatus(sid));
  } catch (err) {
    console.error('[getShareStatus]', err.message);
    res.status(500).json({ message: err.message });
  }
};

/** POST /api/onboarding/share/:sessionId/connect */
const shareConnect = async (req, res) => {
  try {
    const sid = parseSidParam(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });
    const doc = await WaSession.findById(sid).lean();
    if (!doc?.shareOnboarding) {
      return res.status(403).json({ message: 'Session is not in setup mode' });
    }
    await manualReconnect(sid);
    res.json({ success: true });
  } catch (err) {
    console.error('[shareConnect]', err.message);
    res.status(500).json({ message: err.message });
  }
};

/** POST /api/onboarding/share/:sessionId/complete */
const shareComplete = async (req, res) => {
  try {
    const sid = parseSidParam(req.params.sessionId);
    if (!sid) return res.status(400).json({ message: 'Invalid session' });

    const doc = await WaSession.findById(sid);
    if (!doc) return res.status(404).json({ message: 'Session not found' });
    if (!doc.shareOnboarding) {
      return res.status(400).json({ message: 'Setup already completed or session is invalid' });
    }

    const st = getStatus(sid);
    if (st.status !== 'CONNECTED') {
      return res.status(400).json({ message: 'WhatsApp is not connected yet. Finish scanning the QR code first.' });
    }

    const tenantId = doc.tenantId;
    if (!tenantId) {
      return res.status(500).json({ message: 'Session is missing tenantId. Please restart setup.' });
    }

    let username;
    let found = false;
    for (let i = 0; i < 24; i++) {
      username = `user_${crypto.randomBytes(4).toString('hex')}`;
      // eslint-disable-next-line no-await-in-loop
      const exists = await User.exists({ tenantId, username });
      if (!exists) {
        found = true;
        break;
      }
    }
    if (!found) {
      return res.status(500).json({ message: 'Could not allocate a username. Try again.' });
    }

    const plainPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const masterUser = await User.create({
      tenantId,
      username,
      password: hashedPassword,
      role: 'master',
      nickname: 'Master Admin',
      assignedGroups: [],
      assignedSessions: [sid],
    });

    doc.shareOnboarding = false;
    doc.createdBy = masterUser._id;
    doc.label = `CRM — ${username}`.slice(0, 80);
    await doc.save();
    await settingsService.refreshCache(sid);

    res.json({
      username,
      password: plainPassword,
      loginUrl: '/login',
    });
  } catch (err) {
    console.error('[shareComplete]', err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  shareStart,
  getShareStatus,
  shareConnect,
  shareComplete,
};
