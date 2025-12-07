const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const MAX_HISTORY = 500;
const SALT_ROUNDS = 10;
const ADMIN_PASSWORD = 'choco1234banana';
const ADMIN_USERS = ['ばなな', 'チョコわかめ'];
const EXTRA_ADMIN_PASSWORD = 'a0966a';

let pool = null;
let useDatabase = false;

let dbError = null;

async function initDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    dbError = {
      type: 'NO_DATABASE_URL',
      message: 'DATABASE_URLが設定されていません',
      cause: '環境変数DATABASE_URLが未設定です',
      solution: 'RenderダッシュボードでWeb ServiceのEnvironmentにDATABASE_URLを追加してください。PostgreSQLのInternal Database URLを設定してください。'
    };
    console.log('DATABASE_URL not set');
    return false;
  }
  
  try {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000
    });
    
    await pool.query('SELECT 1');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        suffix INTEGER,
        display_name VARCHAR(60) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        status_text VARCHAR(100) DEFAULT '',
        login_token VARCHAR(255),
        color VARCHAR(20) DEFAULT '#000000',
        theme VARCHAR(20) DEFAULT 'default',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
      )
    `);
    
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username_suffix ON accounts(username, suffix) WHERE suffix IS NOT NULL
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username VARCHAR(50) PRIMARY KEY,
        color VARCHAR(20) DEFAULT '#000000',
        custom_message VARCHAR(50) DEFAULT '',
        theme VARCHAR(20) DEFAULT 'default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        color VARCHAR(20) DEFAULT '#000000',
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        reply_to_id VARCHAR(50),
        reply_to_username VARCHAR(50),
        reply_to_message TEXT,
        edited BOOLEAN DEFAULT FALSE,
        edited_at TIMESTAMPTZ,
        is_system_reply BOOLEAN DEFAULT FALSE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS private_messages (
        id VARCHAR(50) PRIMARY KEY,
        from_user VARCHAR(60) NOT NULL,
        to_user VARCHAR(60) NOT NULL,
        message TEXT NOT NULL,
        color VARCHAR(20) DEFAULT '#000000',
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_private_messages_timestamp ON private_messages(timestamp DESC)
    `);
    
    await seedAdminAccounts();
    
    useDatabase = true;
    dbError = null;
    console.log('PostgreSQL database connected successfully');
    return true;
  } catch (error) {
    console.error('Failed to connect to PostgreSQL:', error.message);
    
    if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      dbError = {
        type: 'HOST_NOT_FOUND',
        message: 'データベースホストが見つかりません',
        cause: `ホスト名が間違っているか、ネットワークに問題があります: ${error.message}`,
        solution: 'DATABASE_URLのホスト名が正しいか確認してください。RenderのPostgreSQLダッシュボードからInternal Database URLをコピーしてください。'
      };
    } else if (error.message.includes('authentication') || error.message.includes('password')) {
      dbError = {
        type: 'AUTH_FAILED',
        message: '認証に失敗しました',
        cause: 'ユーザー名またはパスワードが間違っています',
        solution: 'DATABASE_URLのユーザー名とパスワードが正しいか確認してください。RenderのPostgreSQLダッシュボードから正しい接続情報を取得してください。'
      };
    } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
      dbError = {
        type: 'CONNECTION_TIMEOUT',
        message: '接続がタイムアウトしました',
        cause: 'データベースサーバーへの接続に時間がかかりすぎています',
        solution: 'RenderのPostgreSQLが起動しているか確認してください。Internal Database URLを使用していることを確認してください（External URLは外部からのアクセス用です）。'
      };
    } else if (error.message.includes('does not exist')) {
      dbError = {
        type: 'DATABASE_NOT_FOUND',
        message: 'データベースが見つかりません',
        cause: `指定されたデータベースが存在しません: ${error.message}`,
        solution: 'DATABASE_URLのデータベース名が正しいか確認してください。RenderでPostgreSQLデータベースが作成されているか確認してください。'
      };
    } else {
      dbError = {
        type: 'CONNECTION_ERROR',
        message: 'データベース接続エラー',
        cause: error.message,
        solution: 'DATABASE_URLが正しく設定されているか確認してください。Renderダッシュボード → PostgreSQL → ConnectionsからInternal Database URLをコピーして、Web ServiceのEnvironmentに設定してください。'
      };
    }
    
    return false;
  }
}

function getDbError() {
  return dbError;
}

async function getUsers() {
  if (!useDatabase) return null;
  
  try {
    const result = await pool.query('SELECT * FROM users');
    const users = {};
    result.rows.forEach(row => {
      users[row.username] = {
        color: row.color,
        customMessage: row.custom_message,
        theme: row.theme,
        createdAt: row.created_at
      };
    });
    return users;
  } catch (error) {
    console.error('Error loading users:', error.message);
    return null;
  }
}

async function upsertUser(username, data) {
  if (!useDatabase) return false;
  
  try {
    await pool.query(`
      INSERT INTO users (username, color, custom_message, theme)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO UPDATE SET
        color = COALESCE($2, users.color),
        custom_message = COALESCE($3, users.custom_message),
        theme = COALESCE($4, users.theme)
    `, [username, data.color || '#000000', data.customMessage || '', data.theme || 'default']);
    return true;
  } catch (error) {
    console.error('Error upserting user:', error.message);
    return false;
  }
}

async function updateUser(username, data) {
  if (!useDatabase) return false;
  
  try {
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (data.color !== undefined) {
      updates.push(`color = $${paramCount++}`);
      values.push(data.color);
    }
    if (data.customMessage !== undefined) {
      updates.push(`custom_message = $${paramCount++}`);
      values.push(data.customMessage);
    }
    if (data.theme !== undefined) {
      updates.push(`theme = $${paramCount++}`);
      values.push(data.theme);
    }
    
    if (updates.length === 0) return true;
    
    values.push(username);
    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE username = $${paramCount}`,
      values
    );
    return true;
  } catch (error) {
    console.error('Error updating user:', error.message);
    return false;
  }
}

async function renameUser(oldUsername, newUsername) {
  if (!useDatabase) return false;
  
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const oldUser = await client.query('SELECT * FROM users WHERE username = $1', [oldUsername]);
      if (oldUser.rows.length > 0) {
        const user = oldUser.rows[0];
        await client.query(`
          INSERT INTO users (username, color, custom_message, theme, created_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (username) DO UPDATE SET
            color = $2, custom_message = $3, theme = $4
        `, [newUsername, user.color, user.custom_message, user.theme, user.created_at]);
      }
      
      await client.query('UPDATE messages SET username = $1 WHERE username = $2', [newUsername, oldUsername]);
      
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error renaming user:', error.message);
    return false;
  }
}

async function getMessages(limit = MAX_HISTORY) {
  if (!useDatabase) return null;
  
  try {
    const result = await pool.query(
      'SELECT * FROM messages ORDER BY timestamp ASC LIMIT $1',
      [limit]
    );
    
    return result.rows.map(row => ({
      id: row.id,
      username: row.username,
      message: row.message,
      color: row.color,
      timestamp: row.timestamp,
      replyTo: row.reply_to_id ? {
        id: row.reply_to_id,
        username: row.reply_to_username,
        message: row.reply_to_message
      } : null,
      edited: row.edited,
      editedAt: row.edited_at,
      isSystemReply: row.is_system_reply
    }));
  } catch (error) {
    console.error('[DB] Error loading messages:', error.message);
    return null;
  }
}

async function addMessage(messageData) {
  if (!useDatabase) return false;
  
  try {
    await pool.query(`
      INSERT INTO messages (id, username, message, color, timestamp, reply_to_id, reply_to_username, reply_to_message, edited, is_system_reply)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      messageData.id,
      messageData.username,
      messageData.message,
      messageData.color,
      messageData.timestamp,
      messageData.replyTo?.id || null,
      messageData.replyTo?.username || null,
      messageData.replyTo?.message || null,
      messageData.edited || false,
      messageData.isSystemReply || false
    ]);
    
    await trimMessages();
    return true;
  } catch (error) {
    console.error('Error adding message:', error.message);
    return false;
  }
}

async function updateMessage(id, username, newMessage) {
  if (!useDatabase) return false;
  
  try {
    const result = await pool.query(
      'UPDATE messages SET message = $1, edited = true, edited_at = NOW() WHERE id = $2 AND username = $3 RETURNING *',
      [newMessage, id, username]
    );
    
    if (result.rows.length === 0) {
      return { success: false, error: 'Message not found or no permission' };
    }
    
    const row = result.rows[0];
    return {
      success: true,
      message: {
        id: row.id,
        username: row.username,
        message: row.message,
        color: row.color,
        timestamp: row.timestamp,
        edited: row.edited,
        editedAt: row.edited_at
      }
    };
  } catch (error) {
    console.error('Error updating message:', error.message);
    return { success: false, error: error.message };
  }
}

async function deleteMessage(id, username) {
  if (!useDatabase) return false;
  
  try {
    const result = await pool.query(
      'DELETE FROM messages WHERE id = $1 AND username = $2 RETURNING id',
      [id, username]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error deleting message:', error.message);
    return false;
  }
}

async function deleteAllMessages() {
  if (!useDatabase) return false;
  
  try {
    await pool.query('DELETE FROM messages');
    return true;
  } catch (error) {
    console.error('Error deleting all messages:', error.message);
    return false;
  }
}

async function trimMessages() {
  if (!useDatabase) return;
  
  try {
    await pool.query(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY timestamp DESC OFFSET $1
      )
    `, [MAX_HISTORY]);
  } catch (error) {
    console.error('Error trimming messages:', error.message);
  }
}

function isUsingDatabase() {
  return useDatabase;
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
  }
}

async function seedAdminAccounts() {
  if (!useDatabase && !pool) return;
  
  try {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
    
    for (const adminName of ADMIN_USERS) {
      const exists = await pool.query('SELECT id FROM accounts WHERE display_name = $1', [adminName]);
      if (exists.rows.length === 0) {
        await pool.query(`
          INSERT INTO accounts (username, suffix, display_name, password_hash, is_admin)
          VALUES ($1, NULL, $1, $2, TRUE)
        `, [adminName, passwordHash]);
        console.log(`Admin account created: ${adminName}`);
      }
    }
  } catch (error) {
    console.error('Error seeding admin accounts:', error.message);
  }
}

async function signup(username, password) {
  if (!useDatabase) return { success: false, error: 'データベースに接続されていません' };
  
  try {
    const isAdminName = ADMIN_USERS.includes(username);
    
    if (isAdminName) {
      const isValidAdmin = await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS));
      if (password !== ADMIN_PASSWORD) {
        return { success: false, error: 'この名前は使用できません' };
      }
      
      const existing = await pool.query('SELECT id FROM accounts WHERE display_name = $1', [username]);
      if (existing.rows.length > 0) {
        return { success: false, error: 'このアカウントは既に存在します' };
      }
      
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const token = crypto.randomBytes(32).toString('hex');
      
      await pool.query(`
        INSERT INTO accounts (username, suffix, display_name, password_hash, is_admin, login_token)
        VALUES ($1, NULL, $1, $2, TRUE, $3)
      `, [username, passwordHash, token]);
      
      return { 
        success: true, 
        account: { 
          displayName: username, 
          isAdmin: true, 
          token,
          color: '#000000',
          theme: 'default',
          statusText: ''
        } 
      };
    }
    
    const result = await pool.query(
      'SELECT COALESCE(MAX(suffix), 0) + 1 as next_suffix FROM accounts WHERE username = $1',
      [username]
    );
    const suffix = result.rows[0].next_suffix;
    const displayName = `${username}#${suffix}`;
    
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const token = crypto.randomBytes(32).toString('hex');
    
    await pool.query(`
      INSERT INTO accounts (username, suffix, display_name, password_hash, login_token)
      VALUES ($1, $2, $3, $4, $5)
    `, [username, suffix, displayName, passwordHash, token]);
    
    return { 
      success: true, 
      account: { 
        displayName, 
        isAdmin: false, 
        token,
        color: '#000000',
        theme: 'default',
        statusText: ''
      } 
    };
  } catch (error) {
    console.error('Signup error:', error.message);
    if (error.message.includes('duplicate')) {
      return { success: false, error: 'このユーザー名は既に使用されています' };
    }
    return { success: false, error: 'アカウント作成に失敗しました' };
  }
}

async function login(username, password) {
  if (!useDatabase) return { success: false, error: 'データベースに接続されていません' };
  
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
      return { success: false, error: 'アカウントが見つかりません' };
    }
    
    for (const account of result.rows) {
      const isValid = await bcrypt.compare(password, account.password_hash);
      
      if (isValid) {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query('UPDATE accounts SET login_token = $1, last_login = NOW() WHERE id = $2', [token, account.id]);
        
        return {
          success: true,
          account: {
            displayName: account.display_name,
            isAdmin: account.is_admin,
            token,
            color: account.color,
            theme: account.theme,
            statusText: account.status_text
          }
        };
      }
    }
    
    return { success: false, error: 'パスワードが間違っています' };
  } catch (error) {
    console.error('Login error:', error.message);
    return { success: false, error: 'ログインに失敗しました' };
  }
}

async function loginWithToken(token) {
  if (!useDatabase) return { success: false, error: 'データベースに接続されていません' };
  
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE login_token = $1', [token]);
    
    if (result.rows.length === 0) {
      return { success: false, error: 'セッションが無効です' };
    }
    
    const account = result.rows[0];
    await pool.query('UPDATE accounts SET last_login = NOW() WHERE id = $1', [account.id]);
    
    return {
      success: true,
      account: {
        displayName: account.display_name,
        isAdmin: account.is_admin,
        token: account.login_token,
        color: account.color,
        theme: account.theme,
        statusText: account.status_text
      }
    };
  } catch (error) {
    console.error('Token login error:', error.message);
    return { success: false, error: 'トークン認証に失敗しました' };
  }
}

async function logout(token) {
  if (!useDatabase) return false;
  
  try {
    await pool.query('UPDATE accounts SET login_token = NULL WHERE login_token = $1', [token]);
    return true;
  } catch (error) {
    console.error('Logout error:', error.message);
    return false;
  }
}

async function updateAccountProfile(displayName, data) {
  if (!useDatabase) return { success: false };
  
  try {
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (data.color !== undefined) {
      updates.push(`color = $${paramCount++}`);
      values.push(data.color);
    }
    if (data.theme !== undefined) {
      updates.push(`theme = $${paramCount++}`);
      values.push(data.theme);
    }
    if (data.statusText !== undefined) {
      updates.push(`status_text = $${paramCount++}`);
      values.push(data.statusText);
    }
    
    if (updates.length === 0) return { success: true };
    
    values.push(displayName);
    const result = await pool.query(
      `UPDATE accounts SET ${updates.join(', ')} WHERE display_name = $${paramCount} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return { success: false, error: 'アカウントが見つかりません' };
    }
    
    const account = result.rows[0];
    return {
      success: true,
      account: {
        displayName: account.display_name,
        isAdmin: account.is_admin,
        color: account.color,
        theme: account.theme,
        statusText: account.status_text
      }
    };
  } catch (error) {
    console.error('Update profile error:', error.message);
    return { success: false, error: 'プロフィール更新に失敗しました' };
  }
}

async function getAccountByDisplayName(displayName) {
  if (!useDatabase) return null;
  
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE display_name = $1', [displayName]);
    if (result.rows.length === 0) return null;
    
    const account = result.rows[0];
    return {
      displayName: account.display_name,
      isAdmin: account.is_admin,
      color: account.color,
      theme: account.theme,
      statusText: account.status_text
    };
  } catch (error) {
    console.error('Get account error:', error.message);
    return null;
  }
}

async function addPrivateMessage(messageData) {
  if (!useDatabase) return false;
  
  try {
    await pool.query(`
      INSERT INTO private_messages (id, from_user, to_user, message, color, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      messageData.id,
      messageData.from,
      messageData.to,
      messageData.message,
      messageData.color || '#000000',
      messageData.timestamp
    ]);
    return true;
  } catch (error) {
    console.error('Error adding private message:', error.message);
    return false;
  }
}

async function getPrivateMessages(user1, user2, limit = 100) {
  if (!useDatabase) return [];
  
  try {
    const result = await pool.query(`
      SELECT * FROM private_messages 
      WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
      ORDER BY timestamp DESC LIMIT $3
    `, [user1, user2, limit]);
    
    return result.rows.map(row => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      message: row.message,
      color: row.color,
      timestamp: row.timestamp
    })).reverse();
  } catch (error) {
    console.error('Error getting private messages:', error.message);
    return [];
  }
}

async function getAllPrivateMessagesForUser(username, limit = 100) {
  if (!useDatabase) return [];
  
  try {
    const result = await pool.query(`
      SELECT * FROM private_messages 
      WHERE from_user = $1 OR to_user = $1
      ORDER BY timestamp DESC LIMIT $2
    `, [username, limit]);
    
    return result.rows.map(row => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      message: row.message,
      color: row.color,
      timestamp: row.timestamp
    })).reverse();
  } catch (error) {
    console.error('Error getting all private messages for user:', error.message);
    return [];
  }
}

async function getAllPrivateMessages(limit = 200) {
  if (!useDatabase) return [];
  
  try {
    const result = await pool.query(`
      SELECT * FROM private_messages 
      ORDER BY timestamp DESC LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      message: row.message,
      color: row.color,
      timestamp: row.timestamp
    })).reverse();
  } catch (error) {
    console.error('Error getting all private messages:', error.message);
    return [];
  }
}

module.exports = {
  initDatabase,
  isUsingDatabase,
  getDbError,
  getUsers,
  upsertUser,
  updateUser,
  renameUser,
  getMessages,
  addMessage,
  updateMessage,
  deleteMessage,
  deleteAllMessages,
  closeDatabase,
  signup,
  login,
  loginWithToken,
  logout,
  updateAccountProfile,
  getAccountByDisplayName,
  addPrivateMessage,
  getPrivateMessages,
  getAllPrivateMessagesForUser,
  getAllPrivateMessages,
  ADMIN_USERS,
  MAX_HISTORY,
  EXTRA_ADMIN_PASSWORD
};
