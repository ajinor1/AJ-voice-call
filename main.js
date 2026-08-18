import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, off, onDisconnect } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

// Firebase 設定
const firebaseConfig = {
    apiKey: "AIzaSyBgwdi7XhnG-bYn2hwAfO-s3n92ky_9eMo",
    authDomain: "aj-voice-call-e157e.firebaseapp.com",
    databaseURL: "https://aj-voice-call-e157e-default-rtdb.firebaseio.com",
    projectId: "aj-voice-call-e157e",
    storageBucket: "aj-voice-call-e157e.firebasestorage.app",
    messagingSenderId: "332396481182",
    appId: "1:332396481182:web:5482f3b68cd83544b2c98f",
    measurementId: "G-4EDK28K1PS"
};

// Firebase 初期化
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// グローバル変数
let localStream = null;
let peerConnections = new Map();
let localPeerId = generatePeerId();
let isCallActive = false;
const peersRef = ref(database, 'peers');
const offersRef = ref(database, 'offers');
const answersRef = ref(database, 'answers');
const iceCandidatesRef = ref(database, 'iceCandidates');

// マップ：各ピアに紐づくリスナー参照（後で off するため）
const peerListeners = new Map();
// マップ：リモート音声用の audio 要素
const remoteAudios = new Map();

// onDisconnect ハンドルと heartbeat
let onDisconnectHandle = null;
let heartbeatTimer = null;
const PEER_TTL = 30_000; // 30秒

// WebRTC 設定
const peerConnectionConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
};

// UI 要素
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const endBtn = document.getElementById('endBtn');
const peerListEl = document.getElementById('peerList');
const peersEl = document.getElementById('peers');

// イベントリスナー
startBtn.addEventListener('click', startCall);
endBtn.addEventListener('click', endCall);

// ユーティリティ
function generatePeerId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return 'peer_' + crypto.randomUUID();
    }
    return 'peer_' + Math.random().toString(36).slice(2, 11);
}

function updateStatus(message, type = 'normal') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    console.log(`[${type.toUpperCase()}] ${message}`);
}

async function startCall() {
    try {
        updateStatus('マイクへのアクセスを許可してください...', 'connecting');

        // マイクストリーム取得
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        isCallActive = true;
        updateStatus('通話ルームに参加中...', 'connecting');

        // Firebase に自分の情報を登録
        const myPeerRef = ref(database, `peers/${localPeerId}`);
        await set(myPeerRef, {
            id: localPeerId,
            timestamp: Date.now(),
            status: 'active'
        });

        // onDisconnect で自動削除（タブ／ブラウザ落ち対策）
        try {
            onDisconnectHandle = onDisconnect(myPeerRef);
            await onDisconnectHandle.remove();
        } catch (e) {
            console.warn('onDisconnect setup failed', e);
            onDisconnectHandle = null;
        }

        // heartbeat（定期的に timestamp を更新）
        heartbeatTimer = setInterval(() => {
            set(myPeerRef, {
                id: localPeerId,
                timestamp: Date.now(),
                status: 'active'
            }).catch(e => console.warn('heartbeat failed', e));
        }, 10000); // 10sごと

        // 既存の参加者を監視
        monitorPeers();

        // UI 更新
        startBtn.disabled = true;
        endBtn.disabled = false;
        updateStatus('通話待機中...接続を待っています', 'connected');

    } catch (error) {
        console.error('エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

async function endCall() {
    try {
        updateStatus('通話を終了中...', 'connecting');

        // ローカルストリームを停止
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        // すべての PeerConnection を閉じる（および関連リスナー/オーディオをクリーンアップ）
        peerConnections.forEach((pc, peerId) => {
            cleanupPeer(peerId);
            try { pc.close(); } catch (e) { /* noop */ }
        });
        peerConnections.clear();

        // onDisconnect のキャンセルと heartbeat 停止
        if (onDisconnectHandle) {
            try { await onDisconnectHandle.cancel(); } catch (e) { /* ignore */ }
            onDisconnectHandle = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        // Firebase から自分の情報を削除
        await remove(ref(database, `peers/${localPeerId}`));
        await remove(ref(database, `offers/${localPeerId}`));
        await remove(ref(database, `answers/${localPeerId}`));
        await remove(ref(database, `iceCandidates/${localPeerId}`));

        // peersRef のリスナーを削除
        try { off(peersRef); } catch (e) { /* noop */ }

        isCallActive = false;

        // UI 更新
        startBtn.disabled = false;
        endBtn.disabled = true;
        peerListEl.style.display = 'none';
        peersEl.innerHTML = '';
        updateStatus('通話を終了しました', 'normal');

    } catch (error) {
        console.error('エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

function cleanupPeer(peerId) {
    // オフライン/切断時に各種リスナーを解除
    const refs = peerListeners.get(peerId);
    if (refs) {
        for (const r of refs) {
            try { off(r); } catch (e) { /* noop */ }
        }
        peerListeners.delete(peerId);
    }

    // リモートオーディオ要素を削除
    const audioEl = remoteAudios.get(peerId);
    if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
        remoteAudios.delete(peerId);
    }
}

async function monitorPeers() {
    onValue(peersRef, async (snapshot) => {
        const peers = snapshot.val() || {};
        // フィルタ: 自分以外かつ最近更新されたピアだけ表示
        const peerIds = Object.entries(peers)
            .filter(([id, data]) => id !== localPeerId && (Date.now() - (data.timestamp || 0) < PEER_TTL))
            .map(([id]) => id);

        // 接続していない新しいピアに接続
        for (const peerId of peerIds) {
            if (!peerConnections.has(peerId)) {
                // deterministic initiator: 比較で一方のみ initiator=true にする
                const initiator = localPeerId > peerId;
                await createPeerConnection(peerId, initiator); // initiator may be true/false
            }
        }

        // 削除されたピアの接続をクローズ
        for (const peerId of Array.from(peerConnections.keys())) {
            if (!peerIds.includes(peerId)) {
                cleanupPeer(peerId);
                const pc = peerConnections.get(peerId);
                if (pc) pc.close();
                peerConnections.delete(peerId);
            }
        }

        // UI 更新
        updatePeerList(peerIds);
    });
}

function updatePeerList(peerIds) {
    if (!peerIds || peerIds.length === 0) {
        peerListEl.style.display = 'none';
        return;
    }

{