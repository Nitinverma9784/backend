const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
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
    messageId: { type: String, required: true },
    groupId: { type: String, required: true },
    sender: { type: String, required: true },
    senderType: { type: String, enum: ['whatsapp', 'crm_user'], default: 'whatsapp' },
    senderName: { type: String },
    text: { type: String },
    mediaUrl: { type: String },
    mediaType: { type: String },
    timestamp: { type: Date, default: Date.now },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ tenantId: 1, sessionId: 1, messageId: 1 }, { unique: true });
messageSchema.index({ sessionId: 1, groupId: 1, timestamp: -1 });

module.exports = mongoose.model('Message', messageSchema);
