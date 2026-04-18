const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  backupEnabled: { type: Boolean, default: false },
  perGroupBackup: { type: Map, of: Boolean, default: {} },
  waSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WaSession',
    required: true,
    index: true,
  },
}, { timestamps: true });

settingSchema.index({ tenantId: 1, waSessionId: 1 }, { unique: true });

module.exports = mongoose.model('Setting', settingSchema);
