# リアルタイムチャットアプリ

## 概要
Socket.IOを使用したリアルタイムチャットアプリケーション。ユーザー認証、メッセージの編集・削除・返信機能、プロフィールカスタマイズ機能を搭載。

## 技術スタック
- Node.js + Express
- Socket.IO (リアルタイム通信)
- PostgreSQL (必須)

## プロジェクト構造
```
├── server.js          # サーバーメインファイル
├── db.js              # PostgreSQLデータベースモジュール
├── public/            # フロントエンドファイル
│   └── chat.html      # 統合版HTML（CSS/JS内蔵、外部サーバー接続対応）
├── render.yaml        # Render.comデプロイ設定
├── vercel.json        # Vercelデプロイ設定
├── railway.json       # Railwayデプロイ設定
├── Procfile           # Heroku/Koyebデプロイ設定
└── package.json
```

## デプロイ方法

### Render.com（推奨）
1. GitHubにリポジトリをプッシュ
2. Render.comでNew Web Serviceを作成
3. リポジトリを選択、render.yamlが自動検出される
4. **重要**: PostgreSQLアドオンを追加
   - Render ダッシュボード → New → PostgreSQL
   - Web Serviceに接続（Environment → DATABASE_URL が自動設定される）

### Vercel
1. Vercelにリポジトリを接続
2. vercel.jsonの設定で自動デプロイ
3. 外部PostgreSQL（Neon、Supabase等）のDATABASE_URLを環境変数に設定

### Railway
1. Railwayにリポジトリを接続
2. PostgreSQLプラグインを追加
3. railway.jsonの設定で自動デプロイ

### Heroku / Koyeb
- Procfileを使用して自動デプロイ
- Heroku Postgresアドオンを追加

## 外部サーバー接続（chat.htmlの単独利用）

chat.htmlは単独でダウンロードして使用可能。以下の方法で外部サーバーに接続：

### 方法1: URLパラメータ（最も簡単）
```
https://your-hosting.com/chat.html?server=https://test-bb-test.onrender.com
```

### 方法2: JavaScriptで設定
HTMLファイルの`<script>`タグの前に追加：
```html
<script>
  window.CHAT_SERVER_URL = 'https://test-bb-test.onrender.com';
</script>
```

## データベース設定

### 環境変数
- `DATABASE_URL`: PostgreSQL接続文字列（**必須**）
- `ADMIN_PASSWORD`: 管理者パスワード
- `NODE_ENV`: 環境（production/development）
- `PORT`: サーバーポート（デフォルト: 5000）

### ストレージの動作
- `DATABASE_URL`が設定されている場合 → PostgreSQL使用（メッセージ永久保存）
- `DATABASE_URL`が設定されていない場合 → エラーメッセージ表示（原因と解決方法を表示）

### エラーハンドリング
データベース接続に失敗した場合、以下の情報がチャット画面に表示されます：
- エラーメッセージ
- 原因の詳細
- 解決方法の案内

## 機能

### ユーザー認証
- 名前入力でチャットに参加
- 同じ名前の重複ログイン防止

### チャット機能
- リアルタイムメッセージング
- メッセージの編集
- メッセージの削除
- メッセージへの返信
- タイピングインジケーター
- メッセージ履歴の永続化 (最大500件)

### プロフィール設定
- 名前変更
- 名前の色カスタマイズ
- ひとこと (20文字以内)
- テーマ選択 (デフォルト、ダーク、ライト、ブルー)

### コマンド
- `/omi` - おみくじを引く
- `/color #カラーコード` - 名前の色を変更
- `/dice` - サイコロを振る
- `/coin` - コインを投げる
- `/prm ユーザー名 内容` - プライベートメッセージを送る
- `/help` - ヘルプを表示

### 接続管理
- 自動再接続機能
- pingTimeout: 120秒
- 未処理エラーハンドリング

## 最近の変更
- 2025-12-05: DATABASE_URL専用に変更（JSONフォールバック削除）、DB接続エラー時の詳細メッセージ表示を追加
- 2025-12-04: ログイン処理を改善（接続状態確認、タイムアウト処理、エラーハンドリング強化）
- 2025-12-04: /prmコマンド追加（プライベートメッセージ機能）、ミュート中はコマンドも使用不可に変更、/ban・/unbanコマンド追加（管理者専用）
- 2025-12-03: /mute、/unmuteコマンド追加（管理者専用）、URLの自動リンク化、コマンド結果を通常メッセージ形式で表示
- 2025-12-03: 管理者ログイン機能を追加（環境変数ADMIN_PASSWORDで設定）、/deleteコマンド（管理者専用）追加、コマンドボックスを通常背景色に変更
- 2025-12-03: 緊急ボタンを削除、テキストエリアを大きく（140px、文字18px）、コマンド一覧ボックスを新デザインに変更
- 2025-12-03: UIスタイルを参考リポジトリに合わせて調整（チャットボックス600px、テキストエリア100px等）
- 2025-12-03: チャットレイアウトをシンプルな縦型に変更
- 2025-12-03: おみくじ結果から説明文を削除（結果のみ表示）
- 2025-12-03: サーバー安定性向上（タイムアウト延長、エラーハンドリング追加）
- 2024-12-03: PostgreSQL対応を追加（Render等でメッセージ永久保存）
- 2024-12-03: chat.htmlに?server=パラメータ対応を追加
- 2024-12-03: db.jsモジュールを追加（DB/JSONの自動切り替え）
- 2024-12-03: 不要ファイル削除（index.html, script.js, style.css）
- 2024-12-03: chat.htmlに全フロントエンドを統合（外部サーバー接続対応）
- 2024-12-03: デプロイ設定追加（Render, Vercel, Railway, Heroku対応）
- 2024-12-03: メッセージ保存上限を500件に拡張
