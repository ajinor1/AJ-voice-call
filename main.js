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
let localPeerId = null;
let isCallActive = false;
const peersRef = ref(database, 'peers');
const offersRef = ref(database, 'offers');
const answersRef = ref(database, 'answers');
const iceCandidatesRef = ref(database, 'iceCandidates');
// onDisconnect ハンドルと heartbeat
let onDisconnectHandle = null;
let heartbeatTimer = null;
const PEER_TTL = 30_000; // 表示する最長寿命（ミリ秒）

// マップ：各ピアに紐づくリスナー参照（後で off するため）
const peerListeners = new Map();
// マップ：リモート音声用の audio 要素
const remoteAudios = new Map();

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
        localPeerId = generatePeerId();
        updateStatus('通話ルームに参加中...', 'connecting');

// Firebase に自分の情報を登録（myPeerRef を作る）
const myPeerRef = ref(database, `peers/${localPeerId}`);
await set(myPeerRef, {
  id: localPeerId,
  timestamp: Date.now(),
  status: 'active'
});

// onDisconnect で自動削除（タブ落ち／ブラウザ落ち対策）
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
}, 10000); // 10秒ごと

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
        for (const peerId of Array.from(peerConnections.keys())) {
            cleanupPeer(peerId);
            const pc = peerConnections.get(peerId);
            if (pc) pc.close();
            peerConnections.delete(peerId);
        }
        // onDisconnect のキャンセルと heartbeat 停止
        if (typeof onDisconnectHandle !== 'undefined' && onDisconnectHandle) {
            try { await onDisconnectHandle.cancel(); } catch (e) { /* ignore */ }
            onDisconnectHandle = null;
        }
        if (typeof heartbeatTimer !== 'undefined' && heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        // Firebase から自分の情報を削除
        if (localPeerId) {
            await remove(ref(database, `peers/${localPeerId}`));
            await remove(ref(database, `offers/${localPeerId}`));
            await remove(ref(database, `answers/${localPeerId}`));
            await remove(ref(database, `iceCandidates/${localPeerId}`));
        }

        // peersRef のリスナーを削除
        off(peersRef);

        isCallActive = false;
        localPeerId = null;

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
        // 自分以外で、かつ最近更新されたピアだけ表示する（PEER_TTL を参照）
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
    if (peerIds.length === 0) {
        peerListEl.style.display = 'none';
        return;
    }

    peerListEl.style.display = 'block';
    peersEl.innerHTML = peerIds.map(peerId => {
        const pc = peerConnections.get(peerId);
        const status = pc && pc.connectionState === 'connected' ? '接続済み' : '接続中...';
        return `<div class="peer-item">
                    <span>${peerId.slice(0, 15)}...</span>
                    <span class="peer-status">${status}</span>
                </div>`;
    }).join('');
}

async function createPeerConnection(peerId, initiator) {
    try {
        const peerConnection = new RTCPeerConnection(peerConnectionConfig);
        peerConnections.set(peerId, peerConnection);

        // ローカルストリーム追加
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        // ICE候補を処理
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const candidateRef = ref(database, `iceCandidates/${localPeerId}/${peerId}`);
                const candidateKey = Math.random().toString(36).slice(2);
                set(ref(database, `iceCandidates/${localPeerId}/${peerId}/${candidateKey}`), {
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid,
                    timestamp: Date.now()
                });
            }
        };

        // リモートストリームを受け取る
        peerConnection.ontrack = (event) => {
            console.log('リモートストリーム受信:', peerId);
            // audio 要素を作成して再生
            let audioEl = remoteAudios.get(peerId);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.controls = false;
                audioEl.style.display = 'none';
                document.body.appendChild(audioEl);
                remoteAudios.set(peerId, audioEl);
            }
            // 一般的には event.streams[0] に音声が含まれる
            if (event.streams && event.streams[0]) {
                audioEl.srcObject = event.streams[0];
            }
        };

        // 接続状態の変化を監視
        peerConnection.onconnectionstatechange = () => {
            console.log(`ピア ${peerId} の接続状態: ${peerConnection.connectionState}`);
            updatePeerList(Array.from(peerConnections.keys()));
            if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
                // 切断されたらクリーンアップ
                cleanupPeer(peerId);
                if (peerConnections.has(peerId)) {
                    peerConnections.get(peerId).close();
                    peerConnections.delete(peerId);
                }
            }
        };

        if (initiator) {
            // Offer を作成して送信
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await set(ref(database, `offers/${localPeerId}/${peerId}`), {
                sdp: offer.sdp,
                type: 'offer',
                timestamp: Date.now()
            });
        }

        // リモートピアからの Offer を監視
        const remoteOfferRef = ref(database, `offers/${peerId}/${localPeerId}`);
        onValue(remoteOfferRef, async (snapshot) => {
            const offerData = snapshot.val();
            if (!offerData) return;

            const state = peerConnection.signalingState;
            // 普通のケース: stable -> setRemote + createAnswer
            if (state === 'stable') {
                try {
                    await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    await set(ref(database, `answers/${localPeerId}/${peerId}`), {
                        sdp: answer.sdp,
                        type: 'answer',
                        timestamp: Date.now()
                    });
                } catch (err) {
                    console.error('Offer 処理エラー:', err);
                }
                return;
            }

            // glare: 自分が既にローカルオファーを出している場合
            if (state === 'have-local-offer') {
                // tie-breaker: localPeerId > peerId の一致したルールで決定
                if (localPeerId > peerId) {
                    // 自分のオファーを保持してリモートオファーを無視
                    console.log('Glare detected: keeping local offer for', peerId);
                    return;
                } else {
                    // 相手のオファーを受け入れる — rollback を試みる
                    try {
                        await peerConnection.setLocalDescription({ type: 'rollback' });
                    } catch (e) {
                        console.warn('Rollback unsupported or failed, recreating PeerConnection', e);
                        // フォールバック: 現在の接続を破棄して再作成
                        cleanupPeer(peerId);
                        const pc = peerConnections.get(peerId);
                        if (pc) {
                            try { pc.close(); } catch (e) { /* noop */ }
                            peerConnections.delete(peerId);
                        }
                        // 再作成して受け入れ側として処理
                        await createPeerConnection(peerId, false);
                        return;
                    }
                    try {
                        await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                        const answer = await peerConnection.createAnswer();
                        await peerConnection.setLocalDescription(answer);
                        await set(ref(database, `answers/${localPeerId}/${peerId}`), {
                            sdp: answer.sdp,
                            type: 'answer',
                            timestamp: Date.now()
                        });
                    } catch (err) {
                        console.error('Glare Offer 処理エラー:', err);
                    }
                }
            }
        });

        // リモートピアからの Answer を監視
        const remoteAnswerRef = ref(database, `answers/${peerId}/${localPeerId}`);
        onValue(remoteAnswerRef, async (snapshot) => {
            const answerData = snapshot.val();
            if (!answerData) return;
            const state = peerConnection.signalingState;
            if (state === 'have-local-offer' || state === 'have-local-pranswer') {
                try {
                    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerData.sdp });
                } catch (err) {
                    console.error('Answer 処理エラー:', err);
                }
            } else {
                console.warn('Ignoring remote answer because signalingState is', state);
            }
        });

        // リモートピアからの ICE候補を監視
        const remoteCandidatesRef = ref(database, `iceCandidates/${peerId}/${localPeerId}`);
        onValue(remoteCandidatesRef, async (snapshot) => {
            const candidates = snapshot.val() || {};
            for (const candidateKey in candidates) {
                const candidateData = candidates[candidateKey];
                try {
                    await peerConnection.addIceCandidate(
                        { candidate: candidateData.candidate, sdpMLineIndex: candidateData.sdpMLineIndex, sdpMid: candidateData.sdpMid }
                    );
                } catch (error) {
                    console.error('ICE候補追加エラー:', error);
                }
            }
        });

        // リスナー参照を保持（終了時に off する）
        peerListeners.set(peerId, [remoteOfferRef, remoteAnswerRef, remoteCandidatesRef]);

    } catch (error) {
        console.error('PeerConnection 作成エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

// ページ離脱時に通話を終了
window.addEventListener('beforeunload', () => {
    if (isCallActive) {
        // 非同期処理は完了を保証できないため fire-and-forget
        endCall();
    }
});

// 初期化完了
updateStatus('準備完了。「通話開始」をクリック', 'normal');
