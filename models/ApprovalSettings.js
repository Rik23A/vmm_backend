const mongoose = require('mongoose');

const ApprovalStepSchema = new mongoose.Schema({
  role: {
    type: String,
    required: true,
  },
  levelLabel: { type: String, required: true },
  sequence: { type: Number, required: true },
});

const ApprovalSettingsSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  plant: { type: String, required: true, default: 'DEFAULT' },
  steps: [ApprovalStepSchema],
}, { timestamps: true });

ApprovalSettingsSchema.index({ tenantId: 1, plant: 1 }, { unique: true });

// Helper to return default workflow configuration
ApprovalSettingsSchema.statics.getDefaultSteps = function () {
  return [
    { role: 'L1_APPROVER', levelLabel: 'L1 Approval', sequence: 1 },
    { role: 'L2_APPROVER', levelLabel: 'L2 Approval', sequence: 2 },
    { role: 'MASTER_DATA', levelLabel: 'Master Data Action', sequence: 3 },
  ];
};

module.exports = mongoose.model('ApprovalSettings', ApprovalSettingsSchema);
