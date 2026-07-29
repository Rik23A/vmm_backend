const mongoose = require('mongoose');

const OcrUsageSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  date: {
    type: String, // Format: YYYY-MM-DD
    required: true,
    index: true,
  },
  // Map of model name (e.g. 'gemini-3.5-flash-lite', 'gemma-4-31b-it') to request count
  modelCounts: {
    type: Map,
    of: Number,
    default: {},
  },
}, {
  timestamps: true,
});

// Ensure unique entry per tenant per day
OcrUsageSchema.index({ tenantId: 1, date: 1 }, { unique: true });

/**
 * Increment count for a given model on a specific date for a tenant
 */
OcrUsageSchema.statics.incrementCount = async function(tenantId, dateStr, modelName) {
  try {
    const filter = { tenantId, date: dateStr };
    const update = { $inc: { [`modelCounts.${modelName}`]: 1 } };
    const options = { upsert: true, new: true, setDefaultsOnInsert: true };

    return await this.findOneAndUpdate(filter, update, options);
  } catch (err) {
    console.error(`[OcrUsage] Error incrementing count for model ${modelName}:`, err);
    return null;
  }
};

/**
 * Get current counts for a specific date for a tenant
 */
OcrUsageSchema.statics.getCounts = async function(tenantId, dateStr) {
  try {
    const doc = await this.findOne({ tenantId, date: dateStr });
    if (!doc || !doc.modelCounts) return {};
    return Object.fromEntries(doc.modelCounts);
  } catch (err) {
    console.error(`[OcrUsage] Error fetching counts for date ${dateStr}:`, err);
    return {};
  }
};

module.exports = mongoose.model('OcrUsage', OcrUsageSchema);
