const mongoose = require('mongoose');

const CustomRoleSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  name: { type: String, required: true, uppercase: true, trim: true }, // e.g. "TAX_TEAM"
  label: { type: String, required: true, trim: true }, // e.g. "Tax Team"
}, { timestamps: true });

// Ensure role name is unique within a tenant
CustomRoleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CustomRole', CustomRoleSchema);
