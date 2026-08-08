// ===== メイン変数 =====
let peer = null;
let localStream = null;
let call = null;
let peerId = '';
let isConnected = false;
let isCalling = false;
let callStartTime = null;
let callTimerInterval = null;
let audioContext = null;
let analyser = null;
let animationFrameId = null;

// ===== DOM読み込み完了 =====
document.addEventListener('DOMContentLoaded', function() {
    const callBtn = document.getElementById('callBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const targetInput = document.getElementById('targetId');
    
    callBtn.addEventListener('click', makeCall);
    disconnectBtn.addEventListener('click', disconnect);
    
    // エンターキーで発信
    targetInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !callBtn.disabled) {
            makeCall();
        }
    });
    
    // ペーストされたIDを自動でトリム
    targetInput.addEventListener('paste', function() {
        setTimeout(() => {
            this.value = this.value.trim();
        }, 10);
    });
    
    initPeer();
});

// ===== PeerJS初期化 =====
function initPeer() {
    if (peer) {
        return peer;
    }
    
    // PeerJSサーバーに接続
    peer = new Peer({
        host: 'peerjs-server.herokuapp.com',
        port: 443,
        path: '/',
        secure: true,
        debug: 0
    });
    
    // 接続成功
    peer.on('open', id => {
        peerId = id;
        document.getElementById('myId').textContent = id;
        document.getElementById('callBtn').disabled = false;
        updateStatus('✅ 接続完了 - 通話できます', 'connected');
    });
    
    // エラー
    peer.on('error', err => {
        console.error('PeerJSエラー:', err);
        const errorMsg = err.message || '不明なエラー';
        
        // 既に通話中のエラーは無視
        if (errorMsg.includes('already in a call')) {
            return;
        }
        
        // 相手が見つからない場合
        if (errorMsg.includes('does not exist')) {
            updateStatus('❌ 相手が見つかりません。IDを確認してください', 'error');
            resetCallButton();
            return;
        }
        
        updateStatus(`⚠️ ${errorMsg}`, 'error');
        
        // 切断された場合は再接続を試みる
        if (errorMsg.includes('disconnected') || errorMsg.includes('close')) {
            setTimeout(() => {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                }
            }, 3000);
        }
    });
    
    // 切断
    peer.on('disconnected', () => {
        updateStatus('⚠️ 切断されました - 再接続中...', 'error');
        document.getElementById('callBtn').disabled = true;
    });
    
    // 再接続
    peer.on('connected', () => {
        updateStatus('✅ 再接続完了', 'connected');
        document.getElementById('callBtn').disabled = false;
    });
    
    // 着信処理
    peer.on('call', incomingCall => {
        // 既に通話中なら拒否
        if (call) {
            incomingCall.close();
            return;
        }
        
        // 着信通知
        const callerId = incomingCall.peer;
        updateStatus(`📞 ${callerId.substring(0, 8)}... からの着信...`, 'waiting');
        
        // マイクがなければ取得
        if (!localStream) {
            getAudio().then(() => {
                answerCall(incomingCall);
            }).catch(() => {
                updateStatus('❌ マイクが取得できません', 'error');
                incomingCall.close();
            });
        } else {
            answerCall(incomingCall);
        }
    });
    
    return peer;
}

// ===== マイク取得 =====
async function getAudio() {
    try {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000
            }
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

// ===== 着信応答 =====
async function answerCall(incomingCall) {
    try {
        call = incomingCall;
        call.answer(localStream);
        setupCall(call);
        updateStatus('✅ 通話中！', 'connected');
        showCallUI(true);
    } catch (err) {
        console.error('着信応答エラー:', err);
        updateStatus('❌ 着信応答に失敗しました', 'error');
        call = null;
    }
}

// ===== 発信 =====
async function makeCall() {
    const targetId = document.getElementById('targetId').value.trim();
    
    if (!targetId) {
        updateStatus('⚠️ 相手のIDを入力してください', 'error');
        return;
    }
    
    if (targetId === peerId) {
        updateStatus('⚠️ 自分自身には発信できません', 'error');
        return;
    }
    
    if (isCalling) {
        return;
    }
    
    const callBtn = document.getElementById('callBtn');
    callBtn.disabled = true;
    callBtn.textContent = '⏳ 発信中...';
    isCalling = true;
    
    try {
        // マイク取得
        if (!localStream) {
            await getAudio();
        }
        
        updateStatus(`📞 ${targetId.substring(0, 8)}... に発信中...`, 'waiting');
        
        // 発信
        call = peer.call(targetId, localStream);
        
        if (!call) {
            throw new Error('発信に失敗しました');
        }
        
        setupCall(call);
        
    } catch (err) {
        console.error('発信エラー:', err);
        updateStatus(`❌ 発信エラー: ${err.message}`, 'error');
        resetCallButton();
        isCalling = false;
        call = null;
    }
}

// ===== 通話セットアップ =====
function setupCall(mediaConnection) {
    const status = document.getElementById('status');
    const callBtn = document.getElementById('callBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const audioVisual = document.getElementById('audioVisual');
    
    // 通話開始時間
    callStartTime = Date.now();
    startCallTimer();
    
    // 相手のストリームを受信
    mediaConnection.on('stream', remoteStream => {
        updateStatus('✅ 通話中！', 'connected');
        audioVisual.classList.add('active');
        showCallUI(true);
        resetCallButton();
        isCalling = false;
        isConnected = true;
        
        // 相手の音声を再生
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.volume = 1.0;
        
        audio.play().catch(err => {
            console.error('音声再生エラー:', err);
            updateStatus('⚠️ 音声再生エラー', 'error');
        });
        
        // 音量メーター
        setupVolumeMeter(remoteStream);
    });
    
    // 通話終了
    mediaConnection.on('close', () => {
        endCall();
    });
    
    // エラー
    mediaConnection.on('error', err => {
        console.error('通話エラー:', err);
        updateStatus(`⚠️ 通話エラー: ${err.message}`, 'error');
        endCall();
    });
}

// ===== 音量メーター =====
function setupVolumeMeter(stream) {
    try {
        // 既存のコンテキストをクリーンアップ
        cleanupAudioContext();
        
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

// ===== クリーンアップ =====
function cleanupAudioContext() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    analyser = null;
}

// ===== 通話時間表示 =====
function startCallTimer() {
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
    }
    callTimerInterval = setInterval(() => {
        if (!callStartTime) return;
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        document.getElementById('callDuration').textContent = `${minutes}:${seconds}`;
    }, 1000);
}

function stopCallTimer() {
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    document.getElementById('callDuration').textContent = '00:00';
}

// ===== UI状態更新 =====
function showCallUI(inCall) {
    const callBtn = document.getElementById('callBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    
    if (inCall) {
        callBtn.style.display = 'none';
        disconnectBtn.style.display = 'block';
        document.getElementById('callStatus').textContent = '📞 通話中';
    } else {
        callBtn.style.display = 'block';
        disconnectBtn.style.display = 'none';
        document.getElementById('callStatus').textContent = '待機中';
    }
}

function resetCallButton() {
    const callBtn = document.getElementById('callBtn');
    callBtn.disabled = false;
    callBtn.textContent = '📞 発信';
    isCalling = false;
}

function updateStatus(message, type = '') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = type;
}

// ===== 切断 =====
function disconnect() {
    endCall();
    updateStatus('🔌 切断しました', '');
    showCallUI(false);
    document.getElementById('audioVisual').classList.remove('active');
    resetVolumeMeter();
}

function endCall() {
    // 通話切断
    if (call) {
        call.close();
        call = null;
    }
    
    // マイク停止
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    isConnected = false;
    isCalling = false;
    callStartTime = null;
    stopCallTimer();
    cleanupAudioContext();
    resetVolumeMeter();
    showCallUI(false);
    resetCallButton();
    document.getElementById('audioVisual').classList.remove('active');
}

// ===== 音量メーターリセット =====
function resetVolumeMeter() {
    cleanupAudioContext();
    const volumeFill = document.getElementById('volumeFill');
    const volumePercent = document.getElementById('volumePercent');
    if (volumeFill) volumeFill.style.width = '0%';
    if (volumePercent) volumePercent.textContent = '0%';
}

// ===== IDコピー =====
function copyMyId() {
    const id = document.getElementById('myId').textContent;
    if (id && id !== '読み込み中...') {
        navigator.clipboard.writeText(id).then(() => {
            const btn = document.getElementById('copyIdBtn');
            const originalText = btn.textContent;
            btn.textContent = '✅ コピー完了!';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        }).catch(() => {
            // フォールバック: 選択してコピーを促す
            const range = document.createRange();
            const selection = window.getSelection();
            const el = document.getElementById('myId');
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('copy');
            alert('IDをコピーしました！');
        });
    }
}

// ===== ページ終了時 =====
window.addEventListener('beforeunload', () => {
    disconnect();
    if (peer && !peer.destroyed) {
        peer.destroy();
    }
});

// ===== グローバルエラーハンドリング =====
window.addEventListener('error', function(e) {
    console.error('グローバルエラー:', e.message);
    if (!e.message.includes('ResizeObserver')) {
        updateStatus(`⚠️ エラーが発生しました`, 'error');
    }
});

// ===== ネットワーク状態 =====
window.addEventListener('online', () => {
    updateStatus('🔄 ネットワーク復旧 - 再接続中...', 'waiting');
    if (peer && !peer.destroyed) {
        peer.reconnect();
    }
});

window.addEventListener('offline', () => {
    updateStatus('📶 ネットワーク切断', 'error');
});
