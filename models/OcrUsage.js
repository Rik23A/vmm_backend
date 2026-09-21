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
    let doc = await this.findOne({ tenantId, date: dateStr });
    if (!doc) {
      try {
        doc = await this.create({ tenantId, date: dateStr, modelCounts: {} });
      } catch (err) {
        if (err.code === 11000) {
          doc = await this.findOne({ tenantId, date: dateStr });
        } else {
          throw err;
        }
      }
    }
    const current = (doc.modelCounts && doc.modelCounts.get(modelName)) || 0;
    doc.modelCounts.set(modelName, current + 1);
    return await doc.save();
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
