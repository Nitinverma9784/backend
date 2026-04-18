const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WaSession',
      required: true,
      index: true,
    },
    groupId: { type: String, required: true },
    name: { type: String, default: '' },
    participants: [{ type: String }],
    isBackupEnabled: { type: Boolean, default: false },
    isGroup: { type: Boolean, default: false },
    lastMessage: { type: String, default: '' },
    lastMessageTimestamp: { type: Date, default: Date.now },
    phoneJid: { type: String, index: true, sparse: true },
  },
  { timestamps: true }
);

groupSchema.index({ tenantId: 1, sessionId: 1, groupId: 1 }, { unique: true });
groupSchema.index({ sessionId: 1, phoneJid: 1 }, { sparse: true });

module.exports = mongoose.model('Group', groupSchema);
