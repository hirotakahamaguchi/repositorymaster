# 株式会社MANEXION 稟議システム (ringi-system)

多段階承認・差戻し（申請者へ / 前ステップへ）に対応した稟議ワークフローシステムです。
**依存パッケージなし**（Node.js 組み込みの `node:http` + `node:sqlite`）で動作します。

## 起動

```bash
node server.js
```

→ http://localhost:3000 を開く。初回起動時にサンプルユーザーと承認ルートテンプレートが自動投入されます。
データは `data/ringi.db`（SQLite）に保存されます。

- Node.js **22.13 以上**（`node:sqlite` を使用。起動時に ExperimentalWarning が出ますが動作に影響ありません）
- 環境変数: `PORT`（既定 3000）、`RINGI_DB`（DB ファイルパス）

テスト:

```bash
npm test
```

## 主な機能

| 機能 | 内容 |
|---|---|
| 多段階承認 | 任意の段数の承認ステップ。各ステップは **1人承認（any）** / **全員承認（all）** を選択可 |
| 承認ルートテンプレート | 管理者が作成・編集。ステップごとに **適用最低金額** を設定でき、金額が未満なら自動スキップ（例: 10万円以上で部長、100万円以上で社長） |
| 個別ルート指定 | テンプレートを使わず、申請ごとにステップ・承認者を自由に組める |
| 申請画面 | 基本情報（件名・区分・希望期日・支払先・内容）／**明細行**（品目×数量×単価 → 合計が申請金額に自動反映）／**添付ファイル**（1件5MB・**最大5件**、見積書など）／承認ルート（金額に応じた適用ステップをプレビュー）／**申請前の確認ダイアログ** |
| 差戻し（任意） | 承認者は承認/却下のほかに任意で差戻しができる。差戻し先は **申請者**（修正→再申請でステップ1からやり直し）または **承認済みの前ステップ**（そこから再承認）。理由コメント必須 |
| 却下 | 理由必須。以降の操作は不可 |
| 取下げ・下書き | 申請者は承認中の稟議を取下げ可能。下書き保存/削除 |
| 再申請 | 差戻し後に編集して再申請。申請回数（round）を記録し、判断はリセット |
| 監査ログ | 作成・申請・承認・却下・差戻し・取下げ・コメントを全てタイムラインに記録 |
| 権限制御 | 閲覧は申請者 / ルート上の承認者 / 管理者のみ。編集は申請者のみ。承認は現在ステップの承認者のみ |
| **ユーザー管理（管理者のみ）** | ユーザーの追加・編集と **管理者権限 / 承認者権限 / 有効・無効** の設定。承認者権限のあるユーザーだけが承認ルートの承認者に指定できる。画面は管理者以外には表示されず、API も 403 で拒否。自分自身の管理者解除・無効化、最後の管理者の解除は不可（ロックアウト防止） |
| コメント | 関係者同士でのコメント投稿 |

## 状態遷移

```
draft ──申請──▶ pending ──全ステップ承認──▶ approved
  ▲                │  │  │
  │                │  │  └──却下──▶ rejected
  │                │  └──取下げ──▶ withdrawn
  │                └──差戻し(申請者へ)──▶ returned ──再申請──▶ pending
  │                └──差戻し(前ステップへ)──▶ pending (current_seq が戻る)
  └── 下書き保存
```

## 認証・ログイン

ログインID + パスワードでログインします（`lib/auth.js`）。

- パスワードは **scrypt** でハッシュ化して保存（平文は保持しない）
- セッションは `sessions` テーブルで管理し、**HttpOnly / SameSite=Lax の Cookie**（`sid`）で識別。有効期間 7 日
- 連続 5 回失敗で 60 秒ロック。更新系 API は `X-Requested-With: fetch` ヘッダ必須（CSRF 対策）
- 本人は「パスワード変更」画面から変更可。管理者は「ユーザー管理」から再設定可（対象ユーザーのセッションは破棄され再ログインが必要）
- HTTPS 配下で運用する場合は環境変数 `RINGI_SECURE_COOKIE=1` で Cookie に `Secure` を付与（リバースプロキシが `X-Forwarded-Proto: https` を付ける場合は自動）

### 初期アカウント（初期パスワードはすべて `password` — 運用前に必ず変更してください）

| ID | ログインID | 氏名 | 部署 / 役職 | 承認者 | 管理者 |
|---|---|---|---|---|---|
| 1 | `yamada` | 山田 太郎 | 営業部 担当 | | |
| 2 | `sato` | 佐藤 花子 | 営業部 課長 | ✔ | |
| 3 | `suzuki` | 鈴木 一郎 | 営業部 部長 | ✔ | |
| 4 | `takahashi` | 高橋 美咲 | 経理部 課長 | ✔ | |
| 5 | `tanaka` | 田中 健 | 経理部 部長 | ✔ | |
| 6 | `watanabe` | 渡辺 社長 | 代表取締役 | ✔ | ✔ |
| 7 | `ito` | 伊藤 次郎 | 開発部 担当 | | |
| 8 | `admin` | 中村 管理 | 総務部 システム管理者 | | ✔ |

権限は管理者（`watanabe` / `admin`）でログインし「ユーザー管理」から変更できます。
既存の DB（ログイン機能追加前）を使う場合は、起動時に上記ログインID（初期データと一致しないユーザーは `user<ID>`）と初期パスワード `password` が自動付与されます。
ログイン画面の「デモアカウント」表示は `public/app.js` の `login-demo` ブロックを削除すれば消せます。

### 試し方

1. `yamada` でログイン → 「新規申請」→ テンプレート「一般経費申請」、金額 200,000 円で申請
2. ログアウトして `sato`（課長）でログイン → 「承認待ち」から承認
3. `suzuki`（部長）でログイン → 「差し戻す（任意）」で差戻し先「申請者」を選んで差戻し
4. `yamada` でログイン → 編集して再申請（ステップ1からやり直し）
5. 社長決裁などの最終段で「ステップ2に戻す」を選ぶと、前ステップから再承認になる

## バックアップ（CSV 出力）

全データを **1 回につき 1 フォルダ** にまとめて出力します。管理者の「バックアップ」画面、または CLI から実行できます。

```bash
npm run backup
```

出力先: `backups/backup_YYYYMMDD_HHMMSS/`（環境変数 `RINGI_BACKUP_DIR` または `node backup.js <出力先>` で変更可）

| ファイル | 内容 |
|---|---|
| `users.csv` | ユーザー（パスワードは含まない） |
| `route_templates.csv` / `route_template_steps.csv` | 承認ルートテンプレートとステップ・承認者 |
| `ringi.csv` | 稟議（申請者名・ルート名・ステータス名を付加） |
| `ringi_items.csv` | 稟議の明細行 |
| `ringi_steps.csv` / `ringi_step_approvers.csv` | 承認ステップと各承認者の判断・コメント |
| `history.csv` | 操作履歴（申請・承認・差戻し・却下・コメント…） |
| `attachments.csv` + `attachments/` | 添付ファイル一覧と **ファイルの実体**（`<稟議番号>_<添付ID>_<元のファイル名>`） |
| `ringi.db` | SQLite データベースの **完全コピー**（`VACUUM INTO` による整合スナップショット。復元用） |
| `manifest.json` / `README.txt` | 件数・作成日時などのメタ情報と説明 |

- CSV は **UTF-8（BOM 付き）・CRLF** で、Excel でそのまま開けます。ヘッダは日本語。
- 復元: サーバーを停止し、`data/ringi.db` をバックアップ内の `ringi.db` で置き換えて再起動。
- 定期バックアップは Windows タスクスケジューラ / cron で `npm run backup` を実行してください。
- 画面からはテーブルごとの CSV を個別にダウンロードすることもできます（`GET /api/admin/export/<table>.csv`）。

## API 一覧

すべて JSON。ログイン後の Cookie（`sid`）でユーザーを識別。GET 以外は `X-Requested-With: fetch` ヘッダ必須。

| Method | Path | 内容 |
|---|---|---|
| POST | /api/auth/login | ログイン `{login_id, password}` → Set-Cookie。失敗 401、ロック中 429 |
| POST | /api/auth/logout | ログアウト（Cookie 破棄） |
| POST | /api/auth/password | 自分のパスワード変更 `{current_password, new_password}` |
| GET | /api/me, /api/users, /api/constants | ログインユーザー・有効ユーザー一覧・定数 |
| GET | /api/users?all=1 | 全ユーザー一覧（無効含む・管理者のみ） |
| POST | /api/users | ユーザー追加 `{login_id, password, name, dept, title, role:'admin'\|'user', is_approver, active}`（管理者のみ） |
| PUT | /api/users/:id | ユーザー更新（部分更新可・管理者のみ。`password` を含めるとパスワード再設定） |
| GET/POST | /api/templates | テンプレート一覧 / 作成（管理者） |
| GET/PUT/DELETE | /api/templates/:id | 取得 / 更新 / 削除（管理者） |
| GET | /api/templates/:id/resolve?amount=N | 金額条件を適用したステップ列 |
| GET | /api/ringi?filter=inbox\|mine\|all&status=&q= | 一覧（inbox=自分の承認待ち） |
| GET | /api/ringi/counts | バッジ用件数 |
| POST | /api/ringi | 作成 `{title, category, amount, body, desired_date, vendor, items:[{name,qty,unit_price,note}], attachments:[{filename,mime,data(base64)}], template_id \| steps:[{name,mode,approver_ids}], submit, comment}` ※items があれば amount は合計で上書き |
| GET/PUT/DELETE | /api/ringi/:id | 詳細 / 編集（下書き・差戻し中のみ。`remove_attachment_ids` で添付削除） / 下書き削除 |
| GET | /api/ringi/:id/attachments/:aid | 添付ファイルのダウンロード（閲覧権限が必要） |
| GET/POST | /api/admin/backups | バックアップ一覧 / 作成（管理者のみ） |
| DELETE | /api/admin/backups/:name | バックアップフォルダの削除（管理者のみ） |
| GET | /api/admin/export/:table.csv | テーブル単位の CSV ダウンロード（管理者のみ） |
| POST | /api/ringi/:id/submit | 申請・再申請 `{comment}` |
| POST | /api/ringi/:id/approve | 承認 `{comment}` |
| POST | /api/ringi/:id/reject | 却下 `{comment}`（必須） |
| POST | /api/ringi/:id/return | 差戻し `{target_seq, comment}`（0=申請者、n=承認済み前ステップ） |
| POST | /api/ringi/:id/withdraw | 取下げ `{comment}` |
| POST | /api/ringi/:id/comment | コメント `{comment}` |

詳細レスポンスの `perms` に、そのユーザーが実行可能な操作（`can_approve`, `can_return`, `return_targets` など）が含まれます。

## 構成

```
server.js            HTTP サーバー・ルーティング・Cookie 認証・CSRF チェック
lib/auth.js          パスワードハッシュ (scrypt)・セッション・ログイン試行制限
lib/backup.js        バックアップ (CSV 出力・添付書き出し・DB コピー)
backup.js            バックアップ CLI (npm run backup)
backups/             バックアップ出力先 (自動生成)
lib/db.js            スキーマ定義・初期データ・マイグレーション（既存DBへの列追加）
lib/workflow.js      ワークフローのビジネスロジック（状態遷移・権限・監査ログ）
public/              フロントエンド（index.html / app.js / style.css）
test/                結合テスト（node:test）
docs/                納品ドキュメント（導入手順書・操作マニュアル・システム仕様書・テスト結果）
start.bat / backup.bat  Windows 用 起動 / バックアップ スクリプト
data/ringi.db        SQLite データ（自動生成）
```
