'use strict';

// --------------------------------------------------------------------------
// Zoom Phone AR(IVR) Webhook 受信 PoC
//   - phone.callee_call_element_completed Webhook を受けて
//     call_history_uuid を取り出し、Call History API を呼び出して
//     発信元電話番号(caller_did_number) と 各 IVR で押された番号(press_key) を
//     コンソールにログ出力する最小サンプル。
//   - 今回のみコメントは日本語で記載する(コードおよびログは英語)。
// --------------------------------------------------------------------------

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

// .env から設定値を読み込む
const {
  PORT = 3000,
  ZOOM_WEBHOOK_SECRET_TOKEN,
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
} = process.env;

// 起動前に必須環境変数が揃っているかチェック
for (const [k, v] of Object.entries({
  ZOOM_WEBHOOK_SECRET_TOKEN,
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
})) {
  if (!v) {
    console.error(`[fatal] Missing required env: ${k}`);
    process.exit(1);
  }
}

const app = express();

// Zoom の署名検証には raw body が必要なので Buffer を温存したうえで JSON パースする
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// --------------------------------------------------------------------------
// Server-to-Server OAuth アクセストークン取得
//   - account_credentials グラントで /oauth/token を叩く
//   - 5分マージンで簡易キャッシュする(PoC なので in-memory)
// --------------------------------------------------------------------------
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://zoom.us/oauth/token',
    null,
    {
      params: {
        grant_type: 'account_credentials',
        account_id: ZOOM_ACCOUNT_ID,
      },
      headers: {
        Authorization: `Basic ${basic}`,
      },
      timeout: 10_000,
    }
  );

  const { access_token, expires_in } = res.data;
  cachedToken = {
    accessToken: access_token,
    expiresAt: now + expires_in * 1000,
  };
  return access_token;
}

// --------------------------------------------------------------------------
// Call History API 呼び出し
//   GET /v2/phone/call_history/{callHistoryUuid}
//   - レスポンスの call_path[] もしくは call_elements[] のいずれかを使える。
//     本サンプルでは call_path[] を採用(API 仕様の代表的な形式)。
// --------------------------------------------------------------------------
async function fetchCallHistory(callHistoryUuid) {
  const token = await getAccessToken();
  const res = await axios.get(
    `https://api.zoom.us/v2/phone/call_history/${encodeURIComponent(callHistoryUuid)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    }
  );
  return res.data;
}

// --------------------------------------------------------------------------
// Webhook 署名検証
//   - Zoom は v0 形式で x-zm-signature を送ってくる
//     message = `v0:${x-zm-request-timestamp}:${rawBody}`
//     expected = `v0=${HMAC_SHA256(secretToken, message)}`
// --------------------------------------------------------------------------
function verifyZoomSignature(req) {
  const ts = req.header('x-zm-request-timestamp');
  const signature = req.header('x-zm-signature');
  if (!ts || !signature || !req.rawBody) return false;

  const message = `v0:${ts}:${req.rawBody}`;
  const hash = crypto
    .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest('hex');
  const expected = `v0=${hash}`;

  // timingSafeEqual で長さが違うと throw するので先に長さチェック
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------
// press_key 抽出
//   - call_path[] の中で is_node === 0 かつ press_key フィールドを持つ要素を
//     順番に拾うと、各 IVR(operator_name) でエンドユーザーが押した番号が並ぶ。
//   - IVR が多段になっているケースにも対応(配列で返す)。
// --------------------------------------------------------------------------
function extractPressedKeys(callHistory) {
  const path = Array.isArray(callHistory.call_path) ? callHistory.call_path : [];
  return path
    .filter((el) => el.is_node === 0 && typeof el.press_key !== 'undefined')
    .map((el) => ({
      operator_name: el.operator_name,
      operator_ext_number: el.operator_ext_number,
      press_key: el.press_key,
    }));
}

// --------------------------------------------------------------------------
// Webhook 受信エンドポイント
// --------------------------------------------------------------------------
app.post('/zoom/webhook', async (req, res) => {
  const body = req.body || {};
  const event = body.event;

  // 1) URL validation イベント
  //    Marketplace でエンドポイントを登録したり再検証する際に飛んでくる。
  //    plainToken を HMAC-SHA256(secretToken) でハッシュして返す必要がある。
  if (event === 'endpoint.url_validation') {
    const plainToken = body?.payload?.plainToken;
    const encryptedToken = crypto
      .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');
    return res.status(200).json({ plainToken, encryptedToken });
  }

  // 2) 通常イベントは署名検証
  if (!verifyZoomSignature(req)) {
    console.warn('[warn] Invalid Zoom signature, rejecting request');
    return res.status(401).send('invalid signature');
  }

  // 3) 今回ハンドルするのは phone.callee_call_element_completed のみ
  if (event !== 'phone.callee_call_element_completed') {
    // それ以外は黙って 200 返す(Zoom 側でリトライされないように)
    return res.status(200).send('ignored');
  }

  // 先に 200 を返してから非同期処理を進める
  //   - Zoom の Webhook は一定時間内に 2xx が返らないとリトライ対象になるため、
  //     API 呼び出しなどの重い処理は ACK 後に実行する。
  res.status(200).send('ok');

  // ここから非同期に API 呼び出し → ログ出力
  try {
    const callElement = body?.payload?.object?.call_elements?.[0];
    const callHistoryUuid = callElement?.call_history_uuid;
    if (!callHistoryUuid) {
      console.warn('[warn] call_history_uuid not found in webhook payload');
      return;
    }

    console.log(`[info] Webhook received. call_history_uuid=${callHistoryUuid}`);

    const history = await fetchCallHistory(callHistoryUuid);
    const callerDidNumber = history.caller_did_number;
    const pressedKeys = extractPressedKeys(history);

    // 要求されたログ出力: 発信元電話番号 と 各 IVR で押された番号
    console.log('--------------------------------------------------');
    console.log(`caller_did_number : ${callerDidNumber}`);
    if (pressedKeys.length === 0) {
      console.log('pressed keys      : (none)');
    } else {
      pressedKeys.forEach((k, i) => {
        console.log(
          `pressed key [${i + 1}]   : ${k.press_key}  @ ${k.operator_name} (ext ${k.operator_ext_number})`
        );
      });
    }
    console.log('--------------------------------------------------');

    // TODO: ここで顧客側 Lambda へ POST する(今回は PoC のためスキップ)
    //   await axios.post(CUSTOMER_LAMBDA_URL, { callerDidNumber, pressedKeys });
  } catch (err) {
    // 失敗しても Zoom 側は既に 200 を受け取っているので、ここはログだけ
    const detail = err.response?.data || err.message;
    console.error('[error] Failed to process webhook:', detail);
  }
});

// ヘルスチェック用
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`[info] Zoom Phone webhook receiver listening on :${PORT}`);
  console.log('[info] POST /zoom/webhook  (register this URL in Zoom Marketplace)');
});
