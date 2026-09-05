# Windows セットアップガイド（日本語）

このリポジトリは Linux / NixOS で開発されています。Windows でも動きますが、
**Windows でしか起きない詰まりどころ**がいくつかあります。このドキュメントは
実際に Windows 11 + 日本語環境で最後まで通した記録をもとにした手順書です。

英語の本家ドキュメントは [README.md](../README.md)、プロトコルの詳細は
[m365-copilot-api.md](m365-copilot-api.md) を参照してください。

---

## 0. 先に知っておくべきこと

**このプロキシでツール呼び出し（コーディングエージェント）を使うには、
テナント側の権限が要ります。** チャットとしてだけ使うなら不要です。

| 用途 | 必要な権限 |
|---|---|
| チャットバックエンドとして使う | M365 Copilot ライセンスのみ |
| ツール呼び出し（GPT 系） | **Copilot extensibility**（エージェントの公開） |
| ツール呼び出し（Claude 系） | テナントで **Anthropic モデル**が有効 |

権限が無い場合、エラーではなく「モデルがツールを使ってくれない」という
分かりにくい形で失敗します。判別方法は [§7 トラブルシューティング](#7-トラブルシューティング)
を参照してください。

---

## 1. 前提ソフトウェアの導入

```powershell
winget install OpenJS.NodeJS        # Node.js 24 以上
npm install -g pnpm@10.32.1
```

### PATH の罠

Node をインストールしても、**既存のターミナルには PATH が反映されません**。
「Node は入れたのに `node` が見つからない」の大半はこれです。新しい
ターミナルを開くか、そのセッションで次を実行してください。

```powershell
$env:PATH = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:PATH"
```

恒久化するなら PowerShell プロファイル（`$PROFILE`）に同じ行を追記します。

確認:

```powershell
node -v      # v24.x 以上
pnpm -v      # 10.x
```

---

## 2. ビルド

```powershell
cd C:\path\to\m365-copilot-proxy
pnpm install
pnpm --filter @m365-copilot/core exec playwright install chromium
pnpm build
```

### Playwright のブラウザは別途ダウンロードが必要

`pnpm install` だけでは Chromium 本体は落ちてきません
（`pnpm-workspace.yaml` の `allowBuilds` に playwright が無いため、
インストールスクリプトが走りません）。忘れるとサインイン時にこう落ちます:

```
Executable doesn't exist at C:\Users\<you>\AppData\Local\ms-playwright\chromium-1208\chrome-win64\chrome.exe
```

**`--filter` を付ける点が重要です。** playwright はルートではなく
`@m365-copilot/core` の依存なので、ルートから実行すると失敗します:

```powershell
pnpm exec playwright install chromium     # ✗ Command "playwright" not found
npx playwright install                    # ✗ 同上（ルートから実行した場合）
```

既存の Chrome / Edge を使うこともできます（ダウンロード不要）:

```powershell
$env:CHROMIUM_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

### テスト

```powershell
npx vitest run      # 認証・ネットワーク不要
```

---

## 3. サインイン

### 方法 A: 対話サインイン（推奨）

パスワードも TOTP シードもディスクに置かずに済みます。ブラウザ窓が開くので、
普段どおり手でサインインしてください。

```powershell
$env:M365_ENABLE_INTERACTIVE_APPROVAL = "1"
```

初回だけです。以降は `msal-cache.json` から無音で更新されます。
プッシュ通知・FIDO2・Okta / Ping / Duo 連携のテナントでも使えます。

> このパスでは**ブラウザ指紋の偽装を一切行いません**（UA・locale・timezone の
> 上書きも `navigator.webdriver` のマスクもしない）。人間が可視ウィンドウで
> MFA を完了しているので、Entra ID が読む信号はすべて真実で構いません。

### 方法 B: 自動ログイン

`C:\Users\<you>\.config\opencode-m365\secrets.json` に配置します。

```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "JBSWY3DPEHPK3PXP"
}
```

`mfaSecret` は 6 桁コードではなく **base32 のシード**です。取得方法は
[README の該当節](../README.md#getting-the-totp-secret)を参照。

> **注意:** このファイルはパスワードと MFA シードを平文で同居させます。
> 読める人はアカウントを完全に乗っ取れます。業務アカウントで使う前に
> 管理者の承認を取り、可能なら方法 A を選んでください。

### 設定ファイルの場所

Windows では `homedir()` が `C:\Users\<you>` になるため、すべてここに置かれます。

| ファイル | 内容 |
|---|---|
| `.config\opencode-m365\secrets.json` | 認証情報（方法 B のみ） |
| `.config\opencode-m365\msal-cache.json` | トークンキャッシュ（自動生成） |
| `.config\opencode-m365\browser-profile\` | AAD の SSO / デバイス Cookie |
| `.config\opencode-m365\agent-id.json` | Copilot Studio エージェント ID |
| `.config\opencode-m365\debug.log` | `M365_DEBUG=1` のときのログ |

---

## 4. プロキシの起動

```powershell
$env:PATH = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:PATH"
$env:HOST = "127.0.0.1"
$env:M365_DEBUG = "1"
cd C:\path\to\m365-copilot-proxy
node packages\proxy\bin\m365-proxy.mjs 4141
```

`Listening on http://127.0.0.1:4141` が出れば成功です。

### `HOST=127.0.0.1` は省略しないでください

このプロキシの `/v1/chat/completions` には**認証がありません**。さらに CORS が
全オリジン許可のため、`HOST` を指定しないと（Nitro の既定で全インターフェースに
bind され）同一 LAN の誰でもあなたの Copilot 枠を消費できます。
NixOS モジュールが既定で `127.0.0.1` に固定しているのも同じ理由です。

### 疎通確認

```powershell
curl.exe http://127.0.0.1:4141/health
curl.exe http://127.0.0.1:4141/v1/models
```

> `/health` は**認証に失敗していても `ok` を返します**。起動時の認証エラーは
> `[unhandledRejection]` として出るだけでサーバは listen を続けるので、
> 監視から見ると正常に見えてしまいます。起動ログを目で確認してください。

---

## 5. pi から使う

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`C:\Users\<you>\.pi\agent\models.json` を作成します:

```json
{
  "providers": {
    "m365": {
      "api": "openai-completions",
      "apiKey": "m365",
      "baseUrl": "http://127.0.0.1:4141/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5)" },
        { "id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5 (via M365)" },
        { "id": "m365-copilot", "name": "M365 Copilot (Auto)" }
      ]
    }
  }
}
```

### チャットとして使う

```powershell
$env:PI_OFFLINE = "1"
pi --provider m365 --model gpt-5.5-think-deeper -nt -p "質問"
```

`-nt` はツール無し。このときツール定義も指示文も**一切注入されません**。

### ツールありで使う

```powershell
pi --provider m365 --model gpt-5.5-think-deeper --tools bash,read,list,edit,write -p "タスク"
```

**`--tools` でツールを絞ってください。** 全ツールを載せると、プロキシが注入する
指示文が膨らみ、M365 の `Disengaged` フィルタを踏みやすくなります。
これが「pi は動くが重量級ハーネスは動かない」と言われる理由です。

対話モードは `-p` を外すだけです。対話モードのほうが quota に優しくなります
（会話が継続するため、重い指示文の全文注入は最初の 1 ターンだけ。以降は
新規メッセージのみの差分送信になります）。

---

## 6. Windows 固有の挙動

### PowerShell フェンスもツール呼び出しとして扱われます

モデルが ```` ```powershell ````・```` ```cmd ````・```` ```bat ```` などで返した場合も、
ハーネスの shell ツールへルーティングされます。以前はこれらが散文に降格され、
「PowerShell を使え」と指示したユーザーのターンが全て無効化されていました（issue #7）。

### ホスト OS がモデルに伝えられます

プロキシは Windows 上で動くとき、注入する指示文の末尾に次を追加します:

```
HOST PLATFORM: Windows. ... POSIX の作法（`<<'EOF'` ヒアドキュメント、`sed -i`、
`ls`/`grep`）はここでは動きません。```powershell ブロックを使ってください ...
```

これが無いと、指示文が毎回教える POSIX の作法にモデルが従い、Windows では
すべて失敗します。この打ち消しはユーザー側のメモリ指示より強く効きます。

### パス

Windows パスはそのまま使えます。空白を含むパスは引用符で囲んでください。
`m365-proxy` の起動シムは内部で `file://` URL に変換しています
（かつてはここで `ERR_UNSUPPORTED_ESM_URL_SCHEME` を出して起動できませんでした）。

---

## 7. トラブルシューティング

### `node` / `pnpm` / `pi` / `gh` が見つからない

インストール直後のターミナルには PATH が反映されていません。§1 の PATH 行を
実行するか、新しいターミナルを開いてください。

### `Executable doesn't exist at ...chromium-1208\chrome-win64\chrome.exe`

Playwright のブラウザ未取得です。§2 の `--filter` 付きコマンドを実行してください。

### `Auth failed: No cached token and no secrets.json`

サインイン方法が未設定です。§3 のどちらかを設定してください。

### `M365 Copilot returned an empty response (throttle N/600)`

エラーメッセージは「コンテンツフィルタ / 不正なエージェント / 一時的な障害」を
候補に挙げますが、**実際にはもう 2 つ原因があります**。切り分け手順:

**手順 1 — 別のモデルで対照実験する。** これが最も確実です。

```powershell
$body = '{"model":"gpt-5.5-think-deeper","messages":[{"role":"user","content":"Reply with exactly: ALIVE"}]}'
Invoke-WebRequest -Uri "http://127.0.0.1:4141/v1/chat/completions" -Method POST `
  -ContentType "application/json" -Body $body -UseBasicParsing
```

- GPT が応答する → **アカウント全体の調速ではありません**。空応答を返した
  モデルのトーンがそのアカウントに提供されていない可能性が高い（例: Anthropic
  モデルが未有効）
- GPT も空 → スレッドレート調速の可能性。短時間に多数の会話を開くと発生します。
  30 分ほど間隔を空けてください（再ログインでは解消しません）

**手順 2 — ログでフレームを確認する。**

```powershell
Get-Content "$env:USERPROFILE\.config\opencode-m365\debug.log" | Select-String "Disengaged"
```

- `Disengaged` あり → コンテンツフィルタ。プロンプトの形（命令形・全部大文字・
  「他は変更するな」等）を弱めてください
- `Disengaged` 無し + `ReferencesListComplete` + `offense:"None"` で本文ゼロ →
  調速か、トーン未提供のどちらか。手順 1 で切り分けます

> 補足: 存在しない／退役したトーンを指定した場合は、空応答ではなく
> `Failed to invoke 'Chat'` という明示的なエラーになります。`/v1/models` は
> 現在も `quick` と `gpt-5.4-quick` を広告していますが、これらは 502 になります。

### モデルがツールを使わず「ファイルをアップロードしてください」と返す

ほぼ確実に **Copilot Studio エージェントの公開に失敗**しています。確認:

```powershell
Get-Content "$env:USERPROFILE\.config\opencode-m365\debug.log" | Select-String "agent"
```

次の行が出ていれば、テナントの権限不足です:

```
Failed to publish bot: 403 { "Code": "CopilotExtensibilityNotEnabled",
  "Message": "Publishing this agent requires Copilot extensibility,
              which is not enabled for your account." }
[model] No agent available   →   agent=none
```

`agent=none` の状態では、GPT 系はツール指示に従わず、M365 自身のサンドボックス
（`/mnt/data`）で作業して結果だけを返します。**プロンプトの書き方では解決しません**
（9 種のフレーミングを総当たりして 0/9 でした）。テナント管理者に
Copilot extensibility の有効化を依頼してください。

### モデルが「修正しました」と言うのにファイルが変わらない

M365 のサンドボックス内で修正し、Teams の成果物リンクを返しています。
プロキシはこれを検出して再試行を強制します（日本語の応答にも対応済み）。
検出されずに素通りする場合は、応答文とともに issue を立ててください。

### ログの読み方

```powershell
# 指示文が全文注入されたターン（mode=full）と差分送信（mode=delta）
Get-Content "$env:USERPROFILE\.config\opencode-m365\debug.log" | Select-String "mode="

# 実際に注入された指示文
Get-Content "$env:USERPROFILE\.config\opencode-m365\debug.log" | Select-String "Formatted prompt:"
```

`M365_TRACE=1` にすると切り詰めが無効になり、WS フレームとプロンプトが全文
記録されます。**会話内容が平文で残る**ので、調査が終わったら削除してください。

---

## 8. セキュリティ上の注意

- **`HOST=127.0.0.1` を必ず指定する。** API は無認証・CORS 全許可です
- **エージェントの自動承認モードを使わない。** モデルが出したフェンスが 1 個の
  ターンは、無条件でシェル呼び出しに変換されます。最初は手動承認で挙動を
  確認してください
- **`secrets.json` の権限を絞る。** 既定では特別な権限設定は行われません。
  共有マシンでは方法 A（対話サインイン）を選んでください
- **`M365_TRACE=1` を常用しない。** 会話内容が平文でログに残ります
- **業務テナントでは管理者の承認を取る。** このプロキシは Microsoft の
  非公開 API に、あなた自身の資格情報でアクセスします

---

## 9. 参考

- [README.md](../README.md) — 英語の本家ドキュメント
- [m365-copilot-api.md](m365-copilot-api.md) — プロトコルの詳細（正典）
- [hypotheses.md](hypotheses.md) — 実験ノート。§15 に Windows 対応と
  ライセンスゲートの検証記録があります
- [AGENTS.md](../AGENTS.md) — このリポジトリで作業する際の指針
