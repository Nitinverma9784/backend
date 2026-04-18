const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, index: true },
  sessionOwner: { type: String, required: true, index: true }, // For multi-user
  name: { type: String, required: true },
  participants: [{ type: String }],
  admins: [{ type: String }],
  lastMessage: { type: String, default: "" },
  lastMessageTimestamp: { type: Date, default: Date.now },
  description: { type: String },
  isBackupEnabled: { type: Boolean, default: false }, // Specific override for the group
}, { timestamps: true });

// Ensure unique group per session owner
groupSchema.index({ groupId: 1, sessionOwner: 1 }, { unique: true });

module.exports = mongoose.model('Group', groupSchema);
