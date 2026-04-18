const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['master', 'sub'], default: 'sub' },
  nickname: { type: String, required: true },
  /** WhatsApp chat JIDs this sub-user may access (empty = all chats in assigned sessions) */
  assignedGroups: [{ type: String }],
  /** Linked WhatsApp numbers (WaSession ids) this sub-user may use */
  assignedSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'WaSession' }],
  /** Pinned chats for this CRM user (order = top to bottom within pins) */
  pinnedChats: [
    {
      sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WaSession', required: true },
      groupId: { type: String, required: true },
    },
  ],
}, { timestamps: true });

userSchema.index({ tenantId: 1, username: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);
