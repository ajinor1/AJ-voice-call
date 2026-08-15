import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, off } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

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
    return 'peer_' + Math.random().toString(36).substr(2, 9);
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
        await set(ref(database, `peers/${localPeerId}`), {
            id: localPeerId,
            timestamp: Date.now(),
            status: 'active'
        });

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

        // すべての PeerConnection を閉じる
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();

        // Firebase から自分の情報を削除
        await remove(ref(database, `peers/${localPeerId}`));
        await remove(ref(database, `offers/${localPeerId}`));
        await remove(ref(database, `answers/${localPeerId}`));
        await remove(ref(database, `iceCandidates/${localPeerId}`));

        // リスナーを削除
        off(peersRef);

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

async function monitorPeers() {
    onValue(peersRef, async (snapshot) => {
        const peers = snapshot.val() || {};
        const peerIds = Object.keys(peers).filter(id => id !== localPeerId);

        // 接続していない新しいピアに接続
        for (const peerId of peerIds) {
            if (!peerConnections.has(peerId)) {
                await createPeerConnection(peerId, true); // initiator
            }
        }

        // 削除されたピアの接続をクローズ
        for (const peerId of peerConnections.keys()) {
            if (!peerIds.includes(peerId)) {
                peerConnections.get(peerId).close();
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
                    <span>${peerId.substr(0, 15)}...</span>
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
                const candidateKey = Math.random().toString(36).substr(2);
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
            // 音声は自動的に再生される
        };

        // 接続状態の変化を監視
        peerConnection.onconnectionstatechange = () => {
            console.log(`ピア ${peerId} の接続状態: ${peerConnection.connectionState}`);
            updatePeerList(Array.from(peerConnections.keys()));
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
            if (offerData && peerConnection.remoteDescription === null) {
                try {
                    await peerConnection.setRemoteDescription(
                        new RTCSessionDescription({
                            type: 'offer',
                            sdp: offerData.sdp
                        })
                    );

                    // Answer を作成して送信
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    await set(ref(database, `answers/${localPeerId}/${peerId}`), {
                        sdp: answer.sdp,
                        type: 'answer',
                        timestamp: Date.now()
                    });
                } catch (error) {
                    console.error('Offer 処理エラー:', error);
                }
            }
        });

        // リモートピアからの Answer を監視
        const remoteAnswerRef = ref(database, `answers/${peerId}/${localPeerId}`);
        onValue(remoteAnswerRef, async (snapshot) => {
            const answerData = snapshot.val();
            if (answerData && peerConnection.remoteDescription === null) {
                try {
                    await peerConnection.setRemoteDescription(
                        new RTCSessionDescription({
                            type: 'answer',
                            sdp: answerData.sdp
                        })
                    );
                } catch (error) {
                    console.error('Answer 処理エラー:', error);
                }
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
                        new RTCIceCandidate({
                            candidate: candidateData.candidate,
                            sdpMLineIndex: candidateData.sdpMLineIndex,
                            sdpMid: candidateData.sdpMid
                        })
                    );
                } catch (error) {
                    console.error('ICE候補追加エラー:', error);
                }
            }
        });

    } catch (error) {
        console.error('PeerConnection 作成エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

// ページ離脱時に通話を終了
window.addEventListener('beforeunload', async () => {
    if (isCallActive) {
        await endCall();
    }
});

// 初期化完了
updateStatus('準備完了。「通話開始」をクリック', 'normal');
