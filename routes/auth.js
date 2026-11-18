const express = require('express');
const auth = require('../controllers/authController');

const router = express.Router();

router.get('/login', auth.loginForm);
router.post('/login', auth.login);
router.post('/logout', auth.logout);
router.get('/register', auth.registerForm);
router.post('/register', auth.register);
router.get('/setup', auth.setupForm);
router.post('/setup', auth.setup);
router.get('/account/password', auth.passwordForm);
router.post('/account/password', auth.changePassword);

module.exports = router;
