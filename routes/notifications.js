const router = require('express').Router();
const Notification = require('../models/Notification');
const { requireLogin } = require('../middleware/auth');
const { injectTenant } = require('../middleware/tenant');

// GET /api/notifications - Get all notifications for current user
router.get('/', requireLogin, injectTenant, async (req, res, next) => {
  try {
    const list = await Notification.find({
      userId: req.user._id,
      tenantId: req.tenantId
    }).sort({ createdAt: -1 }).limit(50);
    
    res.json({ notifications: list });
  } catch (err) { next(err); }
});

// POST /api/notifications/:id/read - Mark notification as read
router.post('/:id/read', requireLogin, injectTenant, async (req, res, next) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, tenantId: req.tenantId },
      { read: true },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    res.json({ notification: notif });
  } catch (err) { next(err); }
});

// POST /api/notifications/read-all - Mark all notifications as read
router.post('/read-all', requireLogin, injectTenant, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, tenantId: req.tenantId, read: false },
      { read: true }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) { next(err); }
});

module.exports = router;
