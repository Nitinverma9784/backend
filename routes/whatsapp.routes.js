const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  listSessions,
  createSession,
  getWAStatus,
  getAllGroups,
  getMessages,
  sendWAMessage,
  sendWAMedia,
  assignAccess,
  getUsers,
  logoutWA,
  connectWA,
  toggleGroupBackup,
  disableAllBackups,
  syncChatHistory,
  syncGroupMessages,
  getSettings,
  updateGlobalBackup,
  getGroupBackupStatus,
  getAllGroupsFlat,
  getTenants,
  deleteTenant,
  deleteUser,
} = require('../controllers/whatsapp.controller');
const { authMiddleware, masterMiddleware } = require('../middlewares/auth.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.get('/sessions', authMiddleware, listSessions);
router.post('/sessions', authMiddleware, masterMiddleware, createSession);

router.get('/sessions/:sessionId/status', authMiddleware, getWAStatus);
router.post('/sessions/:sessionId/connect', authMiddleware, masterMiddleware, connectWA);
router.post('/sessions/:sessionId/logout', authMiddleware, masterMiddleware, logoutWA);

router.get('/sessions/:sessionId/groups', authMiddleware, getAllGroups);

router.get('/sessions/:sessionId/messages/:groupId/sync', authMiddleware, syncChatHistory);
router.get('/sessions/:sessionId/messages/:groupId', authMiddleware, getMessages);

router.post('/sessions/:sessionId/send', authMiddleware, sendWAMessage);
router.post(
  '/sessions/:sessionId/send-media',
  authMiddleware,
  upload.single('file'),
  sendWAMedia
);

router.get('/users', authMiddleware, masterMiddleware, getUsers);
router.delete('/users/:userId', authMiddleware, masterMiddleware, deleteUser);
router.post('/assign-access', authMiddleware, masterMiddleware, assignAccess);
router.get('/tenants', authMiddleware, masterMiddleware, getTenants);
router.delete('/tenants/:tenantId', authMiddleware, masterMiddleware, deleteTenant);

router.get('/groups-all', authMiddleware, masterMiddleware, getAllGroupsFlat);

router.get('/sessions/:sessionId/settings', authMiddleware, masterMiddleware, getSettings);
router.post(
  '/sessions/:sessionId/settings/global-backup',
  authMiddleware,
  masterMiddleware,
  updateGlobalBackup
);
router.post('/sessions/:sessionId/toggle-backup', authMiddleware, masterMiddleware, toggleGroupBackup);
router.get(
  '/sessions/:sessionId/group-backup/:groupId',
  authMiddleware,
  getGroupBackupStatus
);
router.post(
  '/sessions/:sessionId/settings/disable-all-backups',
  authMiddleware,
  masterMiddleware,
  disableAllBackups
);

router.post('/sessions/:sessionId/sync', authMiddleware, syncGroupMessages);

module.exports = router;
