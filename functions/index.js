const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

exports.sendTestPush = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です。');
  }
  const uid = request.auth.uid;
  const db = getFirestore();
  const tokensCol = db.collection(`users/${uid}/fcmTokens`);
  const snap = await tokensCol.get();
  if (snap.empty) {
    throw new HttpsError('failed-precondition', '登録済みのプッシュ通知トークンがありません。');
  }
  const tokens = snap.docs.map((d) => d.id);
  const res = await getMessaging().sendEachForMulticast({
    notification: { title: 'テスト通知', body: 'Study Density Log からのテスト通知です。' },
    tokens,
  });
  const invalidCodes = new Set(['messaging/invalid-registration-token', 'messaging/registration-token-not-registered']);
  const deletions = [];
  res.responses.forEach((r, i) => {
    if (!r.success && invalidCodes.has(r.error?.code)) deletions.push(tokensCol.doc(tokens[i]).delete());
  });
  await Promise.all(deletions);
  return { successCount: res.successCount, failureCount: res.failureCount };
});
