# Study Density Log (MVP)

## 概要
iPhone Safariでホーム画面追加して使える、学習の「実時間」と「集中換算時間」を記録するPWAです。Firebase Authentication + Cloud Firestoreでユーザー別同期します。

## ファイル構成
- `index.html`: 画面骨組み（6画面 + 下部ナビ）
- `style.css`: ダークテーマUI
- `app.js`: 認証、Firestore CRUD、集計、描画、JSONバックアップ
- `manifest.json`: PWAマニフェスト
- `service-worker.js`: 静的ファイルキャッシュ
- `firestore.rules`: ユーザー分離セキュリティルール

## ローカル実行（Windows）
1. このフォルダを開く
2. `app.js` の `firebaseConfig` を自分のFirebase値へ置換
3. ローカルサーバーを起動（例）
   - `py -m http.server 5500`
4. `http://localhost:5500` を開く

## デプロイ
静的ファイルのみなので GitHub Pages / Cloudflare Pages / Netlify にそのまま配置可能。

## Firebase設定
### Authentication
- Googleプロバイダを有効化。
- 承認済みドメインにデプロイドメインを追加。
- ログイン方式は `signInWithRedirect` を使用（iPhone Safari / ホーム画面追加PWAでの安定性を優先）。

### Firestore
- データは `users/{uid}/...` 配下のみ使用。
- `firestore.rules` を適用してください。

## Firestore Security Rules
`firestore.rules` を以下コマンドでデプロイ（Firebase CLI）:
```bash
firebase deploy --only firestore:rules
```

## バックアップ
- 設定画面でJSONエクスポート/インポート。
- 現在のMVPはFirestore保存 + service-workerによる静的ファイルキャッシュ + JSONバックアップを中心に実装。
- IndexedDBは**将来的なオフライン補助機能**（ローカルキュー/一時キャッシュ）として導入予定。

## MVPでできること
- 初期教科/ラベル投入
- 記録追加/編集/削除
- 今日/今週/今月/累計の実時間・集中換算
- 週目標と達成率
- 次テストまで日数
- 教科別/ラベル別/質別の時間配分
- PWA基本対応

## 今後の拡張案
- IndexedDB本格オフラインキュー
- 教材別グラフ強化
- 週間・月間レポートPDF
- ストップウォッチ記録
