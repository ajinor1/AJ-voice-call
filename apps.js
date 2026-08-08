// ===== Firebase設定（⚠️ 実際の使用時は環境変数に移動してください） =====
// 注意: このキーはデモ用です。本番環境では絶対に公開しないでください。
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
let peer = null;
let localStream = null;
let call = null;
let peerId = '';
let currentRoomId = '';
let isConnected = false;
let roomRef = null;
let activeCallId = null;
let audioContext = null;
let analyser = null;
let animationFrameId = null;
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// ===== DOM読み込み完了 =====
document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('connectBtn');
    btn.addEventListener('click', toggleConnection);
    initPeer();
    
    // エンターキーで接続
    document.getElementById('roomId').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            toggleConnection();
        }
    });
});

// ===== PeerJS初期化 =====
function initPeer() {
    if (peer) {
        return peer;
    }
    
    // より安定したPeerJSサーバーを使用
    peer = new Peer({
        host: 'peerjs-server.herokuapp.com',
        port: 443,
        path: '/',
        secure: true,
        debug: 0
    });
    
    peer.on('open', id => {
        peerId = id;
        updateStatus('✅ 接続完了', 'online');
        document.getElementById('myId').textContent = `📱 あなたのID: ${id}`;
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('connectBtn').textContent = '🔗 接続';
    });
    
    peer.on('error', err => {
        console.error('PeerJSエラー:', err);
        const errorMsg = err.message || '不明なエラー';
        
        // 既に通話中のエラーは無視
        if (errorMsg.includes('already in a call')) {
            return;
        }
        
        updateStatus(`⚠️ ${errorMsg}`, 'offline');
        
        // 再接続を試みる
        if (!isReconnecting && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            attemptReconnect();
        }
    });
    
    peer.on('disconnected', () => {
        updateStatus('⚠️ 切断されました - 再接続中...', 'offline');
        document.getElementById('connectBtn').disabled = true;
        
        if (!isReconnecting && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            attemptReconnect();
        }
    });
    
    peer.on('close', () => {
        updateStatus('📴 接続が閉じられました', 'offline');
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('connectBtn').textContent = '🔗 再接続';
        isConnected = false;
    });
    
    return peer;
}

// ===== 再接続処理 =====
function attemptReconnect() {
    if (isReconnecting) return;
    
    isReconnecting = true;
    reconnectAttempts++;
    updateStatus(`🔄 再接続試行 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`, 'waiting');
    
    setTimeout(() => {
        if (peer && !peer.destroyed) {
            peer.reconnect();
        } else {
            initPeer();
        }
        isReconnecting = false;
    }, 3000 * reconnectAttempts);
}

// ===== ステータス更新 =====
function updateStatus(message, type = 'waiting') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    
    const badge = document.querySelector('.badge');
    if (badge) {
        badge.className = `badge ${type}`;
        badge.textContent = type === 'online' ? 'オンライン' : 
                           type === 'offline' ? 'オフライン' : '待機中';
    }
}

// ===== 接続/切断切り替え =====
async function toggleConnection() {
    const btn = document.getElementById('connectBtn');
    
    if (isConnected || call) {
        // 切断
        disconnect();
        return;
    }
    
    // 接続
    await connect();
}

// ===== マイク取得 =====
async function getAudio() {
    try {
        // 既存のストリームをクリーンアップ
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 1
            },
            video: false
        });
        return localStream;
    } catch (err) {
        console.error('マイク取得エラー:', err);
        let errorMsg = '🎤 マイクへのアクセスが拒否されました。\n';
        
        if (err.name === 'NotAllowedError') {
            errorMsg += 'ブラウザの設定でマイクを許可してください。';
        } else if (err.name === 'NotFoundError') {
            errorMsg += 'マイクが接続されていません。';
        } else {
            errorMsg += 'ブラウザの設定を確認してください。';
        }
        
        alert(errorMsg);
        throw err;
    }
}

// ===== メイン接続関数 =====
async function connect() {
    const roomId = document.getElementById('roomId').value.trim() || 'room123';
    const btn = document.getElementById('connectBtn');
    
    if (!peer || !peerId) {
        updateStatus('⏳ PeerJSを初期化中...', 'waiting');
        await initPeer();
        
        // 初期化完了を待つ
        if (!peerId) {
            await new Promise(resolve => {
                peer.once('open', resolve);
            });
        }
    }
    
    btn.disabled = true;
    btn.textContent = '⏳ 接続中...';
    updateStatus(`「${roomId}」に接続中...`, 'waiting');
    
    try {
        await getAudio();
        currentRoomId = roomId;
        
        // Firebaseでルームに参加
        joinRoom(roomId);
        
    } catch (err) {
        console.error(err);
        updateStatus('❌ エラーが発生しました', 'offline');
        btn.disabled = false;
        btn.textContent = '🔗 再接続';
    }
}

// ===== Firebaseでルーム参加 =====
function joinRoom(roomId) {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    // 既存のリスナーを削除
    if (roomRef) {
        roomRef.off();
        roomRef = null;
    }
    
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
        joinedAt: Date.now(),
        status: 'online'
    });
    
    // ルームの有効期限を設定（30分で自動削除）
    roomRef.child('expires').set(Date.now() + 1800000);
    
    // ルームが空になったら自動削除（30分後に削除）
    roomRef.child('cleanup').set({
        scheduledAt: Date.now(),
        expiresIn: 1800000
    });
    
    updateStatus(`📡 ルーム「${roomId}」に参加しました`, 'online');
    btn.textContent = '🔗 接続中...';
    
    // 既に相手がいるかチェック
    roomRef.child('participants').once('value', snapshot => {
        const participants = snapshot.val();
        if (!participants) return;
        
        const participantIds = Object.keys(participants);
        // 自分以外の参加者を探す
        const others = participantIds.filter(id => id !== peerId);
        
        if (others.length > 0 && !call && !activeCallId) {
            // 最初の相手にだけ発信
            const targetId = others[0];
            activeCallId = targetId;
            updateStatus(`📞 ${targetId.substring(0, 8)}... に発信します`, 'waiting');
            startCall(targetId);
        } else if (others.length === 0) {
            updateStatus(`⏳ ルーム「${roomId}」で相手を待っています...`, 'waiting');
            btn.textContent = '⏳ 待機中';
        }
        
        updateParticipantCount(participantIds.length);
    });
}

// ===== 参加者数更新 =====
function updateParticipantCount(count) {
    const el = document.getElementById('participantInfo');
    if (count === 0) {
        el.textContent = '👤 参加者: 0人 (あなただけです)';
    } else if (count === 1) {
        el.textContent = '👤 参加者: あなただけです';
    } else {
        el.textContent = `👥 参加者: ${count}人 (通話中)`;
    }
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
    
    updateParticipantCount(participantIds.length);
    
    // 他の参加者がいる場合
    if (others.length > 0) {
        // 既に通話中でない場合のみ発信
        if (!call && !activeCallId) {
            const targetId = others[0];
            activeCallId = targetId;
            updateStatus(`📞 ${targetId.substring(0, 8)}... が参加しました！`, 'waiting');
            startCall(targetId);
        }
        
        // 通話中はステータス更新
        if (call) {
            updateStatus(`✅ 通話中 (${participantIds.length}人)`, 'online');
            btn.textContent = '📞 通話中 (切断)';
            btn.disabled = false;
            document.getElementById('audioVisual').classList.add('active');
        }
    } else {
        // 相手がいなくなった
        if (call) {
            // 通話を切断
            call.close();
            call = null;
            activeCallId = null;
            isConnected = false;
            document.getElementById('audioVisual').classList.remove('active');
            resetVolumeMeter();
        }
        updateStatus(`⏳ ルームで相手を待っています...`, 'waiting');
        btn.textContent = '⏳ 待機中';
    }
}

// ===== 通話開始 =====
function startCall(targetPeerId) {
    if (call) {
        call.close();
        call = null;
    }
    
    if (!localStream) {
        updateStatus('❌ マイクが準備できていません', 'offline');
        return;
    }
    
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    updateStatus(`📞 ${targetPeerId.substring(0, 8)}... に発信中...`, 'waiting');
    
    try {
        call = peer.call(targetPeerId, localStream);
        
        if (!call) {
            updateStatus('❌ 発信に失敗しました', 'offline');
            activeCallId = null;
            return;
        }
        
        setupCall(call);
    } catch (err) {
        console.error('発信エラー:', err);
        updateStatus(`❌ 発信エラー: ${err.message}`, 'offline');
        activeCallId = null;
        btn.disabled = false;
        btn.textContent = '🔗 再接続';
    }
}

// ===== 通話セットアップ =====
function setupCall(mediaConnection) {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    const audioVisual = document.getElementById('audioVisual');
    const volumeFill = document.getElementById('volumeFill');
    const volumePercent = document.getElementById('volumePercent');
    
    // 着信応答
    mediaConnection.on('stream', remoteStream => {
        updateStatus('✅ 通話中！', 'online');
        btn.textContent = '📞 切断';
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
            updateStatus('⚠️ 音声再生エラー - 音量を確認してください', 'offline');
        });
        
        console.log('✅ 通話確立！相手の音声を受信中');
        
        // 音量メーターのセットアップ
        setupVolumeMeter(remoteStream);
    });
    
    mediaConnection.on('close', () => {
        updateStatus('📴 通話が終了しました', 'offline');
        btn.textContent = '🔗 接続';
        btn.disabled = false;
        isConnected = false;
        audioVisual.classList.remove('active');
        resetVolumeMeter();
        call = null;
        activeCallId = null;
        
        // マイクストリームを停止
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        
        // Firebaseから参加者を削除
        if (roomRef && peerId) {
            roomRef.child(`participants/${peerId}`).remove();
        }
    });
    
    mediaConnection.on('error', err => {
        console.error('通話エラー:', err);
        const errorMsg = err.message || '不明なエラー';
        
        // 既に通話中のエラーは無視
        if (errorMsg.includes('already in a call')) {
            return;
        }
        
        updateStatus(`⚠️ 通話エラー: ${errorMsg}`, 'offline');
        btn.textContent = '🔗 再接続';
        btn.disabled = false;
        isConnected = false;
        audioVisual.classList.remove('active');
        resetVolumeMeter();
        call = null;
        activeCallId = null;
    });
}

// ===== 音量メーター =====
function setupVolumeMeter(stream) {
    try {
        // 既存のAudioContextをクリーンアップ
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        
        if (analyser) {
            analyser = null;
        }
        
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const volumeFill = document.getElementById('volumeFill');
        const volumePercent = document.getElementById('volumePercent');
        
        function updateVolume() {
            if (!analyser || !document.getElementById('audioVisual').classList.contains('active')) {
                return;
            }
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            const percent = Math.min(100, Math.round((avg / 128) * 100));
            volumeFill.style.width = percent + '%';
            volumePercent.textContent = percent + '%';
            
            animationFrameId = requestAnimationFrame(updateVolume);
        }
        
        updateVolume();
    } catch (e) {
        console.warn('音量メーター設定エラー:', e);
    }
}

// ===== 音量メーターリセット =====
function resetVolumeMeter() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    
    analyser = null;
    
    const volumeFill = document.getElementById('volumeFill');
    const volumePercent = document.getElementById('volumePercent');
    if (volumeFill) volumeFill.style.width = '0%';
    if (volumePercent) volumePercent.textContent = '0%';
}

// ===== 切断処理 =====
function disconnect() {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    // 通話切断
    if (call) {
        call.close();
        call = null;
    }
    
    // 音量メーターリセット
    resetVolumeMeter();
    
    // Firebaseから参加者を削除
    if (roomRef && peerId) {
        roomRef.child(`participants/${peerId}`).remove();
        roomRef.off();
        roomRef = null;
    }
    
    // マイクストリームを停止
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    isConnected = false;
    activeCallId = null;
    reconnectAttempts = 0;
    isReconnecting = false;
    
    updateStatus('🔌 切断しました', 'offline');
    btn.textContent = '🔗 接続';
    btn.disabled = false;
    document.getElementById('audioVisual').classList.remove('active');
    document.getElementById('volumeFill').style.width = '0%';
    document.getElementById('volumePercent').textContent = '0%';
    document.getElementById('participantInfo').textContent = '👤 参加者: 0人';
}

// ===== ページ終了時 =====
window.addEventListener('beforeunload', () => {
    disconnect();
    if (peer && !peer.destroyed) {
        peer.destroy();
    }
});

// ===== エラーハンドリング（グローバル） =====
window.addEventListener('error', function(e) {
    console.error('グローバルエラー:', e.message, e.error);
    if (e.message && !e.message.includes('ResizeObserver')) {
        updateStatus(`⚠️ エラー: ${e.message.substring(0, 50)}...`, 'offline');
    }
});

// ===== オフライン検出 =====
window.addEventListener('online', () => {
    updateStatus('🔄 ネットワーク復旧 - 再接続中...', 'waiting');
    if (!isConnected && !call) {
        attemptReconnect();
    }
});

window.addEventListener('offline', () => {
    updateStatus('📶 ネットワーク切断', 'offline');
});
