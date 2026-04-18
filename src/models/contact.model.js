const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  jid: { type: String, required: true, index: true },
  sessionOwner: { type: String, required: true, index: true }, // For multi-user
  name: { type: String },
  nickname: { type: String },
  phone: { type: String },
  profilePicture: { type: String }, // profile picture URL
}, { timestamps: true });

// Ensure unique contact per session owner
contactSchema.index({ jid: 1, sessionOwner: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);
