// ===== Firebase設定（無料プラン） =====
const firebaseConfig = {
    apiKey: "AIzaSyB4oMZNdMjrI6R9fFYwXtUfnwJwVkEIHJg",
    authDomain: "voice-call-signaling.firebaseapp.com",
    databaseURL: "https://voice-call-signaling-default-rtdb.firebaseio.com",
    projectId: "voice-call-signaling",
    storageBucket: "voice-call-signaling.appspot.com",
    messagingSenderId: "123456789012",
    appId: "1:123456789012:web:abcdef123456"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ===== メイン変数 =====
let peer, localStream, call;
let peerId = '';
let currentRoomId = '';
let isConnected = false;
let roomRef = null;

// ===== DOM読み込み完了 =====
document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('connectBtn');
    btn.addEventListener('click', connect);
    initPeer();
});

// ===== PeerJS初期化 =====
function initPeer() {
    if (!peer) {
        peer = new Peer({
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            secure: true
        });
        
        peer.on('open', id => {
            peerId = id;
            document.getElementById('status').textContent = '✅ 接続完了';
            document.getElementById('myId').textContent = `あなたのID: ${id}`;
            document.getElementById('connectBtn').disabled = false;
            document.getElementById('connectBtn').textContent = '🔗 接続';
        });
        
        peer.on('error', err => {
            console.error('PeerJSエラー:', err);
            document.getElementById('status').textContent = `⚠️ ${err.message}`;
        });
        
        peer.on('disconnected', () => {
            document.getElementById('status').textContent = '⚠️ 切断されました';
            document.getElementById('connectBtn').disabled = false;
        });
    }
    return peer;
}

// ===== マイク取得 =====
async function getAudio() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        return localStream;
    } catch (err) {
        alert('🎤 マイクへのアクセスが拒否されました。\nブラウザの設定を確認してください。');
        throw err;
    }
}

// ===== メイン接続関数 =====
async function connect() {
    const roomId = document.getElementById('roomId').value.trim() || 'room123';
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    if (isConnected) {
        // 切断処理
        disconnect();
        return;
    }
    
    btn.disabled = true;
    btn.textContent = '⏳ 接続中...';
    status.textContent = `「${roomId}」に接続中...`;
    
    try {
        await getAudio();
        await initPeer();
        currentRoomId = roomId;
        
        // Firebaseでルームに参加
        joinRoom(roomId);
        
    } catch (err) {
        console.error(err);
        status.textContent = '❌ エラーが発生しました';
        btn.disabled = false;
        btn.textContent = '🔗 再接続';
    }
}

// ===== Firebaseでルーム参加 =====
function joinRoom(roomId) {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    // ルームの参照を取得
    roomRef = database.ref(`rooms/${roomId}`);
    
    // ルームの状態を監視
    roomRef.on('value', snapshot => {
        const data = snapshot.val();
        handleRoomUpdate(data);
    });
    
    // 自分のIDをルームに登録
    roomRef.child('participants').child(peerId).set({
        id: peerId,
        joinedAt: Date.now()
    });
    
    // ルームの有効期限を設定（1時間で自動削除）
    roomRef.child('expires').set(Date.now() + 3600000);
    
    status.textContent = `📡 ルーム「${roomId}」に参加しました`;
    btn.textContent = '🔗 接続中...';
    
    // 既に相手がいるかチェック
    roomRef.child('participants').once('value', snapshot => {
        const participants = snapshot.val();
        const participantIds = Object.keys(participants || {});
        
        // 自分以外の参加者を探す
        const others = participantIds.filter(id => id !== peerId);
        
        if (others.length > 0) {
            // 相手がいるので発信
            others.forEach(otherId => {
                startCall(otherId);
            });
        } else {
            status.textContent = `⏳ ルーム「${roomId}」で相手を待っています...`;
            btn.textContent = '⏳ 待機中';
        }
    });
}

// ===== ルーム更新ハンドラ =====
function handleRoomUpdate(data) {
    if (!data || !data.participants) {
        return;
    }
    
    const participants = data.participants;
    const participantIds = Object.keys(participants);
    const others = participantIds.filter(id => id !== peerId);
    
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    if (others.length > 0 && !call) {
        // 新しい相手が参加した
        others.forEach(otherId => {
            if (!call || call.peer !== otherId) {
                status.textContent = `📞 相手が参加しました！`;
                startCall(otherId);
            }
        });
    }
    
    // 参加者数を表示
    const count = participantIds.length;
    if (count >= 2) {
        status.textContent = `✅ 通話中 (${count}人)`;
        btn.textContent = '📞 通話中';
        btn.disabled = false;
        document.getElementById('audioVisual').classList.add('active');
    }
}

// ===== 通話開始 =====
function startCall(targetPeerId) {
    if (call) {
        // 既存の通話を切断
        call.close();
        call = null;
    }
    
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    status.textContent = `📞 ${targetPeerId} に発信中...`;
    
    // 相手に発信
    call = peer.call(targetPeerId, localStream);
    
    if (!call) {
        status.textContent = '❌ 発信に失敗しました';
        return;
    }
    
    setupCall(call);
}

// ===== 通話セットアップ =====
function setupCall(mediaConnection) {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    const audioVisual = document.getElementById('audioVisual');
    const volumeFill = document.getElementById('volumeFill');
    
    // 着信応答
    mediaConnection.on('stream', remoteStream => {
        status.textContent = '✅ 通話中！';
        btn.textContent = '📞 通話中 (切断)';
        btn.disabled = false;
        isConnected = true;
        audioVisual.classList.add('active');
        
        // 相手の音声を再生
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.volume = 1.0;
        
        audio.play().catch(err => {
            console.error('音声再生エラー:', err);
            status.textContent = '⚠️ 音声再生エラー - 音量を確認してください';
        });
        
        console.log('✅ 通話確立！相手の音声を受信中');
        
        // 音量メーター（オプション）
        try {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(remoteStream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            
            function updateVolume() {
                if (!audioVisual.classList.contains('active')) return;
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const avg = sum / dataArray.length;
                const percent = Math.min(100, (avg / 128) * 100);
                volumeFill.style.width = percent + '%';
                requestAnimationFrame(updateVolume);
            }
            updateVolume();
        } catch (e) {
            // 音量メーターはオプション
        }
    });
    
    mediaConnection.on('close', () => {
        status.textContent = '📴 通話が終了しました';
        btn.textContent = '🔗 再接続';
        btn.disabled = false;
        isConnected = false;
        audioVisual.classList.remove('active');
        volumeFill.style.width = '0%';
        call = null;
        
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
    });
    
    mediaConnection.on('error', err => {
        console.error('通話エラー:', err);
        status.textContent = `⚠️ 通話エラー: ${err.message}`;
        btn.textContent = '🔗 再接続';
        btn.disabled = false;
        isConnected = false;
        audioVisual.classList.remove('active');
    });
}

// ===== 切断処理 =====
function disconnect() {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    if (call) {
        call.close();
        call = null;
    }
    
    if (roomRef) {
        roomRef.child(`participants/${peerId}`).remove();
        roomRef.off();
        roomRef = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    isConnected = false;
    status.textContent = '🔌 切断しました';
    btn.textContent = '🔗 接続';
    btn.disabled = false;
    document.getElementById('audioVisual').classList.remove('active');
    document.getElementById('volumeFill').style.width = '0%';
}

// ===== ページ終了時 =====
window.onbeforeunload = () => {
    disconnect();
    if (peer) {
        peer.destroy();
    }
};

// ===== エラーハンドリング（グローバル） =====
window.onerror = function(msg, url, line, col, error) {
    console.error('グローバルエラー:', msg, error);
    document.getElementById('status').textContent = `⚠️ エラー: ${msg}`;
};
