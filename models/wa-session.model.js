const mongoose = require('mongoose');

const waSessionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    label: { type: String, required: true, trim: true },
    /** WhatsApp ID when connected (e.g. 123@s.whatsapp.net), optional until linked */
    wid: { type: String, index: true, sparse: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** True while /new share flow is waiting for WA + user creation */
    shareOnboarding: { type: Boolean, default: false },
  },
  { timestamps: true }
);

waSessionSchema.index({ sortOrder: 1, createdAt: 1 });
waSessionSchema.index({ tenantId: 1, createdAt: 1 });

module.exports = mongoose.model('WaSession', waSessionSchema);
