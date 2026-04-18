const mongoose = require('mongoose');
const User = require('../models/user.model');
const WaSession = require('../models/wa-session.model');
const Group = require('../models/group.model');
const Message = require('../models/message.model');
const Setting = require('../models/setting.model');

/**
 * One-time tenant backfill.
 * Existing installs were effectively single-tenant; we tag everything with a default tenantId.
 */
async function migrateTenants() {
  // Pick stable default tenant id.
  // Prefer first master user; else first user; else generate one.
  const firstMaster = await User.findOne({ role: 'master' }).sort({ createdAt: 1 }).lean();
  const firstUser = firstMaster || (await User.findOne({}).sort({ createdAt: 1 }).lean());
  const defaultTenantId = firstUser?._id ? new mongoose.Types.ObjectId(firstUser._id) : new mongoose.Types.ObjectId();

  const userRes = await User.updateMany(
    { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId: defaultTenantId } }
  );
  if (userRes.modifiedCount) console.log('[Migrate] Users tenantId tagged:', userRes.modifiedCount);

  const sessionRes = await WaSession.updateMany(
    { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId: defaultTenantId } }
  );
  if (sessionRes.modifiedCount) console.log('[Migrate] WaSessions tenantId tagged:', sessionRes.modifiedCount);

  const groupRes = await Group.updateMany(
    { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId: defaultTenantId } }
  );
  if (groupRes.modifiedCount) console.log('[Migrate] Groups tenantId tagged:', groupRes.modifiedCount);

  const msgRes = await Message.updateMany(
    { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId: defaultTenantId } }
  );
  if (msgRes.modifiedCount) console.log('[Migrate] Messages tenantId tagged:', msgRes.modifiedCount);

  const setRes = await Setting.updateMany(
    { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId: defaultTenantId } }
  );
  if (setRes.modifiedCount) console.log('[Migrate] Settings tenantId tagged:', setRes.modifiedCount);

  // Apply new indexes after tagging. (If duplicates exist, Mongoose will throw; that should be investigated.)
  try { await User.syncIndexes(); } catch (err) { console.warn('[Migrate] User.syncIndexes:', err.message); }
  try { await WaSession.syncIndexes(); } catch (err) { console.warn('[Migrate] WaSession.syncIndexes:', err.message); }
  try { await Group.syncIndexes(); } catch (err) { console.warn('[Migrate] Group.syncIndexes:', err.message); }
  try { await Message.syncIndexes(); } catch (err) { console.warn('[Migrate] Message.syncIndexes:', err.message); }
  try { await Setting.syncIndexes(); } catch (err) { console.warn('[Migrate] Setting.syncIndexes:', err.message); }

  return { defaultTenantId };
}

module.exports = { migrateTenants };

