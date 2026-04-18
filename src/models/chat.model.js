const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  sessionOwner: { type: String, required: true, index: true }, // For multi-user
  name: { type: String },
  isGroup: { type: Boolean, default: false },
  lastMessage: { type: String },
  lastMessageTimestamp: { type: Date, default: Date.now },
  unreadCount: { type: Number, default: 0 },
  isMuted: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
  backupEnabled: { type: Boolean, default: false },
}, { timestamps: true });

// Ensure unique chat per session owner
chatSchema.index({ chatId: 1, sessionOwner: 1 }, { unique: true });

module.exports = mongoose.model('Chat', chatSchema);
