const router = require('express').Router();
const VendorRequest = require('../models/VendorRequest');
const AuditLog = require('../models/AuditLog');
const { requireLogin, requireRole } = require('../middleware/auth');

// ── GET /api/reports ────────────────────────────────────────────────
// Summary statistics for the tenant
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    const query = { tenantId: req.tenantId };
    if (from || to) query.createdAt = dateFilter;

    // Base universe scoping per role: Ensure Total Requests accurately reflects the role's entire historical and active workload
    let pendingStatuses = [];
    let pendingQuery = {};
    if (req.user.role === 'REQUESTOR') {
      query.createdBy = req.user._id;
      pendingStatuses = ['PENDING_APPROVAL', 'PENDING_L1', 'PENDING_L2', 'PENDING_MDT', 'SAP_PENDING'];
      pendingQuery = { ...query, status: { $in: pendingStatuses } };
    } else if (req.user.role === 'L1_APPROVER') {
      query.$or = [
        { status: 'PENDING_L1' },
        { 'approvalChain.level': 'L1' },
        { status: 'PENDING_APPROVAL', currentLevel: 'L1_APPROVER' },
        { 'approvalChain.level': 'L1_APPROVER' }
      ];
      pendingQuery = { 
        tenantId: req.tenantId, 
        $or: [
          { status: 'PENDING_L1' },
          { status: 'PENDING_APPROVAL', currentLevel: 'L1_APPROVER' }
        ]
      };
    } else if (req.user.role === 'L2_APPROVER') {
      query.$or = [
        { status: 'PENDING_L2' },
        { 'approvalChain.level': 'L2' },
        { status: 'PENDING_APPROVAL', currentLevel: 'L2_APPROVER' },
        { 'approvalChain.level': 'L2_APPROVER' }
      ];
      pendingQuery = { 
        tenantId: req.tenantId, 
        $or: [
          { status: 'PENDING_L2' },
          { status: 'PENDING_APPROVAL', currentLevel: 'L2_APPROVER' }
        ]
      };
    } else if (req.user.role === 'MASTER_DATA') {
      query.$or = [
        { status: { $in: ['PENDING_MDT', 'SAP_PENDING', 'SAP_FAILED'] } },
        { 'approvalChain.level': { $in: ['MDT', 'SAP'] } },
        { status: 'PENDING_APPROVAL', currentLevel: 'MASTER_DATA' },
        { 'approvalChain.level': 'MASTER_DATA' }
      ];
      pendingQuery = {
        tenantId: req.tenantId,
        $or: [
          { status: 'PENDING_MDT' },
          { status: 'PENDING_APPROVAL', currentLevel: 'MASTER_DATA' },
          { status: { $in: ['SAP_PENDING', 'SAP_FAILED'] } }
        ]
      };
    } else {
      // ADMIN
      pendingStatuses = ['PENDING_APPROVAL', 'PENDING_L1', 'PENDING_L2', 'PENDING_MDT', 'SAP_PENDING', 'SAP_FAILED'];
      pendingQuery = { ...query, status: { $in: pendingStatuses } };
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      query.plant = { $in: req.user.plants };
      pendingQuery.plant = { $in: req.user.plants };
    }

    const finalQuery = {
      $and: [
        query,
        {
          $or: [
            { status: { $ne: 'DRAFT' } },
            { createdBy: req.user._id }
          ]
        }
      ]
    };

    const rejectedQuery = { ...query, status: 'REJECTED' };

    const [statusCounts, totalRequests, sapPushed, rejected, pendingCount, avgTat] = await Promise.all([
      VendorRequest.aggregate([
        { $match: finalQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      VendorRequest.countDocuments(finalQuery),
      VendorRequest.countDocuments({ ...query, status: 'SAP_PUSHED' }),
      VendorRequest.countDocuments(rejectedQuery),
      VendorRequest.countDocuments(pendingQuery),
      VendorRequest.aggregate([
        { $match: { ...query, status: 'SAP_PUSHED', submittedAt: { $ne: null }, completedAt: { $ne: null } } },
        { $project: { tat: { $subtract: ['$completedAt', '$submittedAt'] } } },
        { $group: { _id: null, avgMs: { $avg: '$tat' } } },
      ]),
    ]);

    const avgTatHours = avgTat[0] ? Math.round(avgTat[0].avgMs / 3600000) : null;
    const statusMap = statusCounts.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {});

    res.json({
      summary: { totalRequests, sapPushed, rejected, pendingCount, avgTatHours },
      byStatus: statusMap,
    });
  } catch (err) { next(err); }
});

// ── GET /api/reports/audit ──────────────────────────────────────────
router.get('/audit', requireLogin, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { action, from, to, page = 1, limit = 50 } = req.query;
    const query = { tenantId: req.tenantId };
    if (action) query.action = action;
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = new Date(from);
      if (to) query.timestamp.$lte = new Date(to);
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [logs, total] = await Promise.all([
      AuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit)),
      AuditLog.countDocuments(query),
    ]);
    res.json({ logs, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
});

// ── GET /api/reports/export ─────────────────────────────────────────
// Export vendor requests as CSV
router.get('/export', requireLogin, requireRole('ADMIN', 'MASTER_DATA'), async (req, res, next) => {
  try {
    const query = {
      tenantId: req.tenantId,
      $or: [
        { status: { $ne: 'DRAFT' } },
        { createdBy: req.user._id }
      ]
    };
    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      query.plant = { $in: req.user.plants };
    }
    const requests = await VendorRequest.find(query)
      .select('tempVendorNumber sapVendorNumber generalData taxDetails status createdByName submittedAt completedAt')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    const headers = ['Temp No', 'SAP No', 'Vendor Name', 'PAN', 'GSTIN', 'Status', 'Submitted By', 'Submitted At', 'Completed At'];
    const rows = requests.map(r => [
      r.tempVendorNumber || '', r.sapVendorNumber || '',
      `"${r.generalData?.vendorName || ''}"`,
      r.taxDetails?.pan || '', r.taxDetails?.gstin || '',
      r.status, r.createdByName || '',
      r.submittedAt ? new Date(r.submittedAt).toISOString() : '',
      r.completedAt ? new Date(r.completedAt).toISOString() : '',
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="vmm-export-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

module.exports = router;
