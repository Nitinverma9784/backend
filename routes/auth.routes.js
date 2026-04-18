const express = require('express');
const router = express.Router();
const { login, registerSubUser, getMe, togglePinnedChat } = require('../controllers/auth.controller');
const { authMiddleware, masterMiddleware } = require('../middlewares/auth.middleware');

router.post('/login', login);
router.post('/register-sub', authMiddleware, masterMiddleware, registerSubUser);
router.get('/me', authMiddleware, getMe);
router.post('/pinned-chats/toggle', authMiddleware, togglePinnedChat);

module.exports = router;
