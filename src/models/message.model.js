const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, index: true },
  chatId: { type: String, required: true, index: true },
  sessionOwner: { type: String, required: true, index: true }, // For multi-user
  sender: { type: String },
  senderName: { type: String },
  text: { type: String },
  mediaUrl: { type: String },
  mediaType: { type: String }, // image, video, audio, document
  timestamp: { type: Date, required: true, index: true },
  fromMe: { type: Boolean, default: false },
  status: { type: Number, default: 0 }, // 0: sent, 1: delivered, 2: read
  isMedia: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  quotedMessageId: { type: String }, // Reference to quoted message
}, { timestamps: true });

// Composite index for fast listing of messages in a chat
messageSchema.index({ chatId: 1, sessionOwner: 1, timestamp: -1 });

module.exports = mongoose.model('Message', messageSchema);
