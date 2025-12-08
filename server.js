const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 120000,
  pingInterval: 30000,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  maxHttpBufferSize: 1e6,
  connectTimeout: 45000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    storage: db.isUsingDatabase() ? 'postgresql' : 'not connected'
  });
});

const MAX_HISTORY = db.MAX_HISTORY;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

let users = {};
let messages = [];
const onlineUsers = new Map();
const userSockets = new Map();
const adminUsers = new Set();
const mutedUsers = new Map();
const bannedUsers = new Set();
const userStatusMap = new Map();

function addUserSocket(displayName, socketId) {
  if (!userSockets.has(displayName)) {
    userSockets.set(displayName, new Set());
  }
  userSockets.get(displayName).add(socketId);
}

function removeUserSocket(displayName, socketId) {
  if (userSockets.has(displayName)) {
    userSockets.get(displayName).delete(socketId);
    if (userSockets.get(displayName).size === 0) {
      userSockets.delete(displayName);
      return true;
    }
  }
  return false;
}

function getUniqueOnlineUsers() {
  return Array.from(userSockets.keys());
}

const fortunes = [
  { result: '大吉', message: '最高の運勢！何をやっても上手くいく！' },
  { result: '中吉', message: '良い運勢！いいことがありそう！' },
  { result: '小吉', message: 'まあまあの運勢。地道に頑張ろう！' },
  { result: '吉', message: '普通の運勢。平穏な一日を。' },
  { result: '末吉', message: '後から運が開ける！焦らずに。' },
  { result: '凶', message: '注意が必要。慎重に行動しよう。' },
  { result: '大凶', message: '今日はおとなしくしていよう...' }
];

function drawFortune() {
  return fortunes[Math.floor(Math.random() * fortunes.length)];
}

function checkMuted(username) {
  if (mutedUsers.has(username)) {
    const muteInfo = mutedUsers.get(username);
    if (Date.now() < muteInfo.until) {
      const remaining = Math.ceil((muteInfo.until - Date.now()) / 1000);
      return { muted: true, remaining };
    } else {
      mutedUsers.delete(username);
    }
  }
  return { muted: false };
}

async function processCommand(command, username, socket, isAdmin) {
  const parts = command.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '/delete':
      if (!isAdmin) {
        return { type: 'error', message: 'このコマンドは管理者専用です' };
      }
      messages = [];
      await db.deleteAllMessages();
      io.emit('allMessagesDeleted');
      return { type: 'system', message: '管理者がすべてのメッセージを削除しました' };

    case '/mute':
      if (!isAdmin) {
        return { type: 'error', message: 'このコマンドは管理者専用です' };
      }
      if (args.length < 2) {
        return { type: 'error', message: '使用方法: /mute ユーザー名 時間(秒)' };
      }
      const targetUser = args[0];
      const muteTime = parseInt(args[1], 10);
      if (isNaN(muteTime) || muteTime <= 0) {
        return { type: 'error', message: '時間は正の数値で指定してください' };
      }
      if (!getUniqueOnlineUsers().includes(targetUser)) {
        return { type: 'error', message: 'そのユーザーはオンラインではありません' };
      }
      const muteTargetSocketSet = userSockets.get(targetUser);
      let isMuteTargetAdmin = false;
      if (muteTargetSocketSet) {
        for (const sid of muteTargetSocketSet) {
          if (adminUsers.has(sid)) {
            isMuteTargetAdmin = true;
            break;
          }
        }
      }
      if (isMuteTargetAdmin && !db.ADMIN_USERS.includes(username)) {
        return { type: 'error', message: '管理者をミュートすることはできません' };
      }
      mutedUsers.set(targetUser, { until: Date.now() + muteTime * 1000 });
      return { type: 'system', message: `${targetUser} を ${muteTime}秒間ミュートしました` };

    case '/unmute':
      if (!isAdmin) {
        return { type: 'error', message: 'このコマンドは管理者専用です' };
      }
      if (args.length < 1) {
        return { type: 'error', message: '使用方法: /unmute ユーザー名' };
      }
      const unmuteUser = args[0];
      if (mutedUsers.has(unmuteUser)) {
        mutedUsers.delete(unmuteUser);
        return { type: 'system', message: `${unmuteUser} のミュートを解除しました` };
      }
      return { type: 'error', message: 'そのユーザーはミュートされていません' };

    case '/ban':
      if (!isAdmin) {
        return { type: 'error', message: 'このコマンドは管理者専用です' };
      }
      if (args.length < 1) {
        return { type: 'error', message: '使用方法: /ban ユーザー名' };
      }
      const banTarget = args[0];
      if (!userSockets.has(banTarget)) {
        return { type: 'error', message: 'そのユーザーはオンラインではありません' };
      }

      const banUserSocketSet = userSockets.get(banTarget);
      let isTargetAdmin = false;
      for (const sid of banUserSocketSet) {
        if (adminUsers.has(sid)) {
          isTargetAdmin = true;
          break;
        }
      }
      if (isTargetAdmin && !db.ADMIN_USERS.includes(username)) {
        return { type: 'error', message: '管理者をBANすることはできません' };
      }

      bannedUsers.add(banTarget);

      for (const sid of banUserSocketSet) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit('banned', { message: '管理者によりチャットから追い出されました' });
          sock.disconnect(true);
        }
        onlineUsers.delete(sid);
        adminUsers.delete(sid);
      }
      userSockets.delete(banTarget);
      userStatusMap.delete(banTarget);

      const uniqueOnlineUsers = getUniqueOnlineUsers();
      io.emit('userLeft', {
        username: banTarget,
        userCount: uniqueOnlineUsers.length,
        users: uniqueOnlineUsers
      });
      return { type: 'system', message: `${banTarget} をチャットからBANしました` };

    case '/unban':
      if (!isAdmin) {
        return { type: 'error', message: 'このコマンドは管理者専用です' };
      }
      if (args.length < 1) {
        return { type: 'error', message: '使用方法: /unban ユーザー名' };
      }
      const unbanUser = args[0];
      if (bannedUsers.has(unbanUser)) {
        bannedUsers.delete(unbanUser);
        return { type: 'system', message: `${unbanUser} のBANを解除しました` };
      }
      return { type: 'error', message: 'そのユーザーはBANされていません' };

    case '/prm':
      if (args.length < 2) {
        return { type: 'error', message: '使用方法: /prm ユーザー名 メッセージ' };
      }
      const prmTarget = args[0];
      const prmMessage = args.slice(1).join(' ');
      if (!userSockets.has(prmTarget)) {
        return { type: 'error', message: 'そのユーザーはオンラインではありません' };
      }
      if (prmTarget === username) {
        return { type: 'error', message: '自分自身にプライベートメッセージは送れません' };
      }

      const prmTimestamp = new Date().toISOString();
      const prmColor = users[username]?.color || '#000000';
      const prmId = generateId();

      await db.addPrivateMessage({
        id: prmId,
        from: username,
        to: prmTarget,
        message: prmMessage,
        color: prmColor,
        timestamp: prmTimestamp
      });

      const prmData = {
        from: username,
        to: prmTarget,
        message: prmMessage,
        timestamp: prmTimestamp,
        color: prmColor
      };

      const prmTargetSocketSet = userSockets.get(prmTarget);
      for (const sid of prmTargetSocketSet) {
        const prmTargetSocketObj = io.sockets.sockets.get(sid);
        if (prmTargetSocketObj) {
          prmTargetSocketObj.emit('privateMessage', prmData);
        }
      }

      for (const adminName of db.ADMIN_USERS) {
        if (userSockets.has(adminName)) {
          const adminSocketSet = userSockets.get(adminName);
          for (const sid of adminSocketSet) {
            const adminSocketObj = io.sockets.sockets.get(sid);
            if (adminSocketObj) {
              adminSocketObj.emit('privateMessageMonitor', prmData);
            }
          }
        }
      }

      socket.emit('privateMessageSent', {
        to: prmTarget,
        message: prmMessage,
        timestamp: prmTimestamp
      });
      return { type: 'private', message: `${prmTarget} にプライベートメッセージを送信しました` };

    case '/omi':
    case '/omikuji':
      const fortune = drawFortune();
      return {
        type: 'command_result',
        userMessage: 'おみくじを引いた🎴',
        resultSender: 'おみくじ',
        resultMessage: `【${fortune.result}】`,
        resultColor: '#e74c3c'
      };

    case '/color':
      if (args[0] && /^#[0-9A-Fa-f]{3,6}$/.test(args[0])) {
        if (users[username]) {
          users[username].color = args[0];
          await db.updateUser(username, { color: args[0] });
          socket.emit('profileUpdated', { color: args[0] });
          return { type: 'system', message: `${username}さんの名前の色を ${args[0]} に変更しました` };
        }
      }
      return { type: 'error', message: '使用方法: /color #カラーコード (例: /color #ff0000)' };

    case '/dice':
      const dice = Math.floor(Math.random() * 6) + 1;
      return {
        type: 'command_result',
        userMessage: 'サイコロを振った🎲',
        resultSender: 'サイコロ',
        resultMessage: `🎲 ${dice} が出た！`,
        resultColor: '#3498db'
      };

    case '/coin':
      const coin = Math.random() < 0.5 ? '表' : '裏';
      return {
        type: 'command_result',
        userMessage: 'コインを投げた🪙',
        resultSender: 'コイン',
        resultMessage: `🪙 ${coin}！`,
        resultColor: '#f39c12'
      };

    case '/help':
      let helpMessage = `コマンド一覧:
/omi - おみくじを引く
/color #カラーコード - 名前の色を変更
/dice - サイコロを振る
/coin - コインを投げる
/prm ユーザー名 内容 - プライベートメッセージを送る
/help - このヘルプを表示`;
      if (isAdmin) {
        helpMessage += `\n\n【管理者専用】\n/delete - 全メッセージを削除\n/mute ユーザー名 時間 - ユーザーをミュート\n/unmute ユーザー名 - ミュート解除\n/ban ユーザー名 - チャットから追い出す\n/unban ユーザー名 - BAN解除`;
      }
      return {
        type: 'system',
        message: helpMessage
      };

    default:
      return null;
  }
}

async function addMessageToStorage(messageData) {
  messages.push(messageData);
  if (messages.length > MAX_HISTORY) {
    messages.shift();
  }
  await db.addMessage(messageData);
}

function getUserStatuses() {
  const statuses = {};
  for (const [username, status] of userStatusMap) {
    statuses[username] = status;
  }
  return statuses;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  let currentUser = null;
  let currentAccount = null;

  socket.on('error', (error) => {
    console.error('Socket error:', error.message);
  });

  socket.on('signup', async ({ username, password }, callback) => {
    if (typeof callback !== 'function') {
      callback = () => {};
    }

    try {
      if (!db.isUsingDatabase()) {
        const dbError = db.getDbError();
        return callback({ 
          success: false, 
          error: 'データベースに接続されていません',
          dbError: dbError
        });
      }

      if (!username || username.length < 1 || username.length > 20) {
        return callback({ success: false, error: 'ユーザー名は1〜20文字で入力してください' });
      }

      if (!password || password.length < 4) {
        return callback({ success: false, error: 'パスワードは4文字以上で入力してください' });
      }

      if (username.includes('管理者')) {
        return callback({ success: false, error: 'この名前は使用できません' });
      }

      const result = await db.signup(username, password);
      callback(result);
    } catch (error) {
      console.error('Signup error:', error.message);
      callback({ success: false, error: 'アカウント作成中にエラーが発生しました' });
    }
  });

  socket.on('accountLogin', async ({ username, password, adminLogin, adminPassword }, callback) => {
    if (typeof callback !== 'function') {
      callback = () => {};
    }

    try {
      if (!db.isUsingDatabase()) {
        const dbError = db.getDbError();
        return callback({ 
          success: false, 
          error: 'データベースに接続されていません',
          dbError: dbError
        });
      }

      if (!username) {
        return callback({ success: false, error: '名前を入力してください' });
      }

      if (!password) {
        return callback({ success: false, error: 'パスワードを入力してください' });
      }

      if (adminLogin) {
        if (!adminPassword || adminPassword !== db.EXTRA_ADMIN_PASSWORD) {
          return callback({ success: false, error: '管理者パスワードが正しくありません' });
        }
      }

      const result = await db.login(username, password);

      if (result.success && bannedUsers.has(result.account.displayName)) {
        return callback({ success: false, error: 'あなたはチャットからBANされています' });
      }
      if (!result.success) {
        return callback(result);
      }

      const grantAdminByPassword = adminLogin && adminPassword === db.EXTRA_ADMIN_PASSWORD;

      currentUser = result.account.displayName;
      currentAccount = result.account;
      if (grantAdminByPassword) {
        currentAccount.isAdmin = true;
      }
      onlineUsers.set(socket.id, currentUser);

      const isFirstSocket = !userSockets.has(currentUser);
      addUserSocket(currentUser, socket.id);

      if (result.account.isAdmin || grantAdminByPassword) {
        adminUsers.add(socket.id);
      }

      if (result.account.statusText) {
        userStatusMap.set(currentUser, result.account.statusText);
      }

      let currentMessages = [];
      try {
        const freshMessages = await db.getMessages();
        if (freshMessages !== null) {
          messages = freshMessages;
          currentMessages = freshMessages;
        } else {
          currentMessages = messages || [];
        }
      } catch (dbFetchError) {
        console.error('Error fetching messages:', dbFetchError.message);
        currentMessages = messages || [];
      }

      let privateMessages = [];
      try {
        privateMessages = await db.getAllPrivateMessagesForUser(currentUser);
      } catch (pmError) {
        console.error('Error fetching private messages:', pmError.message);
      }

      let allPrivateMessagesForAdmin = [];
      const isAdminUser = result.account.isAdmin || grantAdminByPassword;
      const canMonitorPM = db.ADMIN_USERS.includes(currentUser);
      if (canMonitorPM) {
        try {
          allPrivateMessagesForAdmin = await db.getAllPrivateMessages();
        } catch (adminPmError) {
          console.error('Error fetching all private messages for admin:', adminPmError.message);
        }
      }

      const uniqueOnlineUsers = getUniqueOnlineUsers();
      console.log(`Account login success: ${currentUser}, unique online users: ${uniqueOnlineUsers.length}`);

      callback({
        success: true,
        account: currentAccount,
        history: currentMessages,
        privateMessageHistory: privateMessages,
        allPrivateMessages: canMonitorPM ? allPrivateMessagesForAdmin : null,
        onlineUsers: uniqueOnlineUsers,
        userStatuses: getUserStatuses()
      });

      if (isFirstSocket) {
        socket.broadcast.emit('userJoined', {
          username: currentUser,
          userCount: uniqueOnlineUsers.length,
          users: uniqueOnlineUsers
        });
      }
    } catch (error) {
      console.error('Account login error:', error.message);
      callback({ success: false, error: 'ログイン処理中にエラーが発生しました' });
    }
  });

  socket.on('tokenLogin', async ({ token }, callback) => {
    if (typeof callback !== 'function') {
      callback = () => {};
    }

    try {
      if (!db.isUsingDatabase()) {
        return callback({ success: false, error: 'データベースに接続されていません' });
      }

      if (!token) {
        return callback({ success: false, error: 'トークンが必要です' });
      }

      const result = await db.loginWithToken(token);
      if (!result.success) {
        return callback(result);
      }

      if (bannedUsers.has(result.account.displayName)) {
        return callback({ success: false, error: 'あなたはチャットからBANされています' });
      }

      currentUser = result.account.displayName;
      currentAccount = result.account;
      onlineUsers.set(socket.id, currentUser);

      const isFirstSocket = !userSockets.has(currentUser);
      addUserSocket(currentUser, socket.id);

      if (result.account.isAdmin) {
        adminUsers.add(socket.id);
      }

      if (result.account.statusText) {
        userStatusMap.set(currentUser, result.account.statusText);
      }

      let currentMessages = [];
      try {
        const freshMessages = await db.getMessages();
        if (freshMessages !== null) {
          messages = freshMessages;
          currentMessages = freshMessages;
        } else {
          currentMessages = messages || [];
        }
      } catch (dbFetchError) {
        console.error('Error fetching messages:', dbFetchError.message);
        currentMessages = messages || [];
      }

      let privateMessages = [];
      try {
        privateMessages = await db.getAllPrivateMessagesForUser(currentUser);
      } catch (pmError) {
        console.error('Error fetching private messages:', pmError.message);
      }

      let allPrivateMessagesForAdmin = [];
      const isAdminUser = result.account.isAdmin;
      const canMonitorPM = db.ADMIN_USERS.includes(currentUser);
      if (canMonitorPM) {
        try {
          allPrivateMessagesForAdmin = await db.getAllPrivateMessages();
        } catch (adminPmError) {
          console.error('Error fetching all private messages for admin:', adminPmError.message);
        }
      }

      const uniqueOnlineUsers = getUniqueOnlineUsers();
      console.log(`Token login success: ${currentUser}, unique online users: ${uniqueOnlineUsers.length}`);

      callback({
        success: true,
        account: result.account,
        history: currentMessages,
        privateMessageHistory: privateMessages,
        allPrivateMessages: canMonitorPM ? allPrivateMessagesForAdmin : null,
        onlineUsers: uniqueOnlineUsers,
        userStatuses: getUserStatuses()
      });

      if (isFirstSocket) {
        socket.broadcast.emit('userJoined', {
          username: currentUser,
          userCount: uniqueOnlineUsers.length,
          users: uniqueOnlineUsers
        });
      }
    } catch (error) {
      console.error('Token login error:', error.message);
      callback({ success: false, error: 'トークン認証に失敗しました' });
    }
  });

  socket.on('accountLogout', async ({ token }) => {
    if (token) {
      await db.logout(token);
    }
    if (currentUser) {
      const userName = currentUser;
      onlineUsers.delete(socket.id);
      adminUsers.delete(socket.id);
      const isLastSocket = removeUserSocket(userName, socket.id);

      if (isLastSocket) {
        userStatusMap.delete(userName);
        const uniqueOnlineUsers = getUniqueOnlineUsers();
        io.emit('userLeft', {
          username: userName,
          userCount: uniqueOnlineUsers.length,
          users: uniqueOnlineUsers
        });
      }
      currentUser = null;
      currentAccount = null;
    }
  });

  socket.on('updateAccountProfile', async (data, callback) => {
    if (typeof callback !== 'function') {
      callback = () => {};
    }

    if (!currentUser || !currentAccount) {
      return callback({ success: false, error: 'ログインしていません' });
    }

    try {
      const result = await db.updateAccountProfile(currentUser, {
        color: data.color,
        theme: data.theme,
        statusText: data.statusText
      });

      if (!result.success) {
        return callback(result);
      }

      currentAccount = { ...currentAccount, ...result.account };

      if (data.statusText !== undefined) {
        userStatusMap.set(currentUser, data.statusText);
        io.emit('userStatusUpdate', { username: currentUser, statusText: data.statusText });
      }

      callback({
        success: true,
        account: result.account
      });
    } catch (error) {
      console.error('Update profile error:', error.message);
      callback({ success: false, error: 'プロフィール更新に失敗しました' });
    }
  });

  socket.on('sendMessage', async (data, callback) => {
    if (typeof callback !== 'function') {
      callback = () => {};
    }
    if (!currentUser) return;

    const isAdmin = adminUsers.has(socket.id);
    const displayName = isAdmin ? `${currentUser} 管理者` : currentUser;
    const statusText = userStatusMap.get(currentUser) || '';

    try {
      const muteCheck = checkMuted(currentUser);
      if (muteCheck.muted) {
        socket.emit('systemMessage', `あなたはミュートされています。残り${muteCheck.remaining}秒`);
        return callback({ success: false, error: 'ミュート中です' });
      }

      if (data.message.startsWith('/')) {
        const result = await processCommand(data.message, currentUser, socket, isAdmin);
        if (result) {
          if (result.type === 'error') {
            socket.emit('systemMessage', result.message);
            return callback && callback({ success: true });
          } else if (result.type === 'command_result') {
            const userMsgData = {
              id: generateId(),
              username: displayName,
              message: result.userMessage,
              color: currentAccount?.color || '#000000',
              timestamp: new Date().toISOString(),
              replyTo: null,
              edited: false,
              isAdmin: isAdmin,
              statusText: statusText
            };

            await addMessageToStorage(userMsgData);
            io.emit('message', userMsgData);

            const resultMsgData = {
              id: generateId(),
              username: result.resultSender,
              message: result.resultMessage,
              color: result.resultColor,
              timestamp: new Date().toISOString(),
              replyTo: null,
              edited: false,
              isCommandResult: true
            };

            await addMessageToStorage(resultMsgData);
            io.emit('message', resultMsgData);

            return callback && callback({ success: true });
          } else if (result.type === 'private') {
            socket.emit('systemMessage', result.message);
            return callback && callback({ success: true });
          } else {
            io.emit('systemMessage', result.message);
            return callback && callback({ success: true });
          }
        }
      }

      const messageData = {
        id: generateId(),
        username: displayName,
        message: data.message,
        color: currentAccount?.color || '#000000',
        timestamp: new Date().toISOString(),
        replyTo: data.replyTo || null,
        edited: false,
        isAdmin: isAdmin,
        statusText: statusText
      };

      await addMessageToStorage(messageData);
      io.emit('message', messageData);
      callback({ success: true, id: messageData.id });
    } catch (error) {
      console.error('Error sending message:', error.message);
      callback({ success: false, error: 'メッセージ送信エラー' });
    }
  });

  socket.on('editMessage', async ({ id, newMessage }, callback) => {
    if (!currentUser) return;

    const displayName = adminUsers.has(socket.id) ? `${currentUser} 管理者` : currentUser;
    const result = await db.updateMessage(id, displayName, newMessage);
    if (!result.success) {
      return callback({ success: false, error: result.error || 'メッセージが見つからないか、編集権限がありません' });
    }

    const msgIndex = messages.findIndex(m => m.id === id);
    if (msgIndex !== -1) {
      messages[msgIndex].message = newMessage;
      messages[msgIndex].edited = true;
      messages[msgIndex].editedAt = new Date().toISOString();
    }

    io.emit('messageEdited', result.message || messages[msgIndex]);
    callback({ success: true });
  });

  socket.on('deleteMessage', async ({ id }, callback) => {
    if (!currentUser) return;

    const displayName = adminUsers.has(socket.id) ? `${currentUser} 管理者` : currentUser;
    const success = await db.deleteMessage(id, displayName);
    if (!success) {
      return callback({ success: false, error: 'メッセージが見つからないか、削除権限がありません' });
    }

    const msgIndex = messages.findIndex(m => m.id === id);
    if (msgIndex !== -1) {
      messages.splice(msgIndex, 1);
    }

    io.emit('messageDeleted', { id });
    callback({ success: true });
  });

  socket.on('typing', () => {
    if (currentUser) {
      socket.broadcast.emit('userTyping', currentUser);
    }
  });

  socket.on('stopTyping', () => {
    socket.broadcast.emit('userStopTyping');
  });

  socket.on('heartbeat', () => {
    socket.emit('heartbeat-ack');
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      const userName = currentUser;
      onlineUsers.delete(socket.id);
      adminUsers.delete(socket.id);
      const isLastSocket = removeUserSocket(userName, socket.id);

      if (isLastSocket) {
        userStatusMap.delete(userName);
        const uniqueOnlineUsers = getUniqueOnlineUsers();
        io.emit('userLeft', {
          username: userName,
          userCount: uniqueOnlineUsers.length,
          users: uniqueOnlineUsers
        });
        console.log(`${userName} left the chat (last socket)`);
      } else {
        console.log(`${userName} closed a tab (still connected in another tab)`);
      }
    }
  });
});

const PORT = process.env.PORT || 5000;


async function startServer() {
  const dbConnected = await db.initDatabase();

  if (dbConnected) {
    const dbUsers = await db.getUsers();
    const dbMessages = await db.getMessages();
    if (dbUsers) users = dbUsers;
    if (dbMessages) messages = dbMessages;
    console.log(`Loaded ${Object.keys(users).length} users and ${messages.length} messages from PostgreSQL`);
  } else {
    const dbError = db.getDbError();
    console.error('Database connection failed:', dbError ? dbError.message : 'Unknown error');
    console.log('Server will start but database features will not work');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Storage: ${db.isUsingDatabase() ? 'PostgreSQL' : 'Not connected'}`);
  });
}

startServer();

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server gracefully...');
  await db.closeDatabase();
  io.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
  setTimeout(() => {
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing connection...');
  await db.closeDatabase();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
