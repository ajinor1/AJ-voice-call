let peer, localStream, call;

// Peerサーバーに接続（CloudFlareの無料サーバーを使用）
function initPeer() {
    if (!peer) {
        peer = new Peer({
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            secure: true
        });
        
        peer.on('open', id => {
            document.getElementById('status').textContent = `接続完了 (ID: ${id})`;
        });
        
        peer.on('error', err => {
            document.getElementById('status').textContent = `エラー: ${err.message}`;
        });
    }
    return peer;
}

// マイクを取得
async function getAudio() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return localStream;
    } catch (err) {
        alert('マイクへのアクセスが拒否されました');
        throw err;
    }
}

// ルーム作成（発信者）
async function createRoom() {
    const roomId = document.getElementById('roomId').value || 'room123';
    const peer = initPeer();
    
    try {
        await getAudio();
        document.getElementById('status').textContent = '相手の参加を待っています...';
        
        // 相手からの着信を待機
        peer.on('call', incomingCall => {
            incomingCall.answer(localStream);
            setupCall(incomingCall);
        });
        
        alert(`ルーム「${roomId}」を作成しました。相手にこのIDを共有してください。`);
    } catch (err) {
        console.error(err);
    }
}

// ルームに参加（受信者）
async function joinRoom() {
    const roomId = document.getElementById('roomId').value || 'room123';
    const peer = initPeer();
    
    try {
        await getAudio();
        
        // 相手に発信
        const newCall = peer.call(roomId, localStream);
        setupCall(newCall);
        
        document.getElementById('status').textContent = '接続中...';
    } catch (err) {
        console.error(err);
    }
}

// 通話のセットアップ
function setupCall(mediaConnection) {
    call = mediaConnection;
    
    mediaConnection.on('stream', remoteStream => {
        document.getElementById('status').textContent = '✅ 通話中';
        // 相手の音声を再生
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.play().catch(console.error);
        
        // 自分の音声も確認用に再生（オプション）
        const localAudio = new Audio();
        localAudio.srcObject = localStream;
        localAudio.muted = true; // ハウリング防止
        localAudio.play().catch(console.error);
    });
    
    mediaConnection.on('close', () => {
        document.getElementById('status').textContent = '通話が終了しました';
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
    });
    
    mediaConnection.on('error', err => {
        console.error('通話エラー:', err);
        document.getElementById('status').textContent = '通話エラーが発生しました';
    });
}

// ページ終了時の処理
window.onbeforeunload = () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (peer) {
        peer.destroy();
    }
};
