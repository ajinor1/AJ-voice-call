let peer, localStream, call;
let currentRoomId = '';
let isCreating = false;
let peerId = '';

// DOMが読み込まれたら実行
document.addEventListener('DOMContentLoaded', function() {
    // ボタンにイベントリスナーを設定
    const btn = document.getElementById('connectBtn');
    btn.addEventListener('click', connect);
    
    // Peerを初期化
    initPeer();
});

// Peerサーバーに接続
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
            document.getElementById('status').textContent = '接続完了';
            document.getElementById('myId').textContent = `あなたのID: ${id}`;
            document.getElementById('connectBtn').disabled = false;
        });
        
        peer.on('error', err => {
            document.getElementById('status').textContent = `エラー: ${err.message}`;
            console.error(err);
        });
    }
    return peer;
}

// マイク取得
async function getAudio() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: true,
            video: false
        });
        return localStream;
    } catch (err) {
        alert('マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。');
        throw err;
    }
}

// メイン関数
async function connect() {
    const roomId = document.getElementById('roomId').value || 'room123';
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    btn.disabled = true;
    btn.textContent = '接続中...';
    status.textContent = `「${roomId}」に接続中...`;
    
    try {
        await getAudio();
        const peer = initPeer();
        tryToJoin(roomId);
    } catch (err) {
        console.error(err);
        status.textContent = 'エラー: マイクが使えません';
        btn.disabled = false;
        btn.textContent = '🔗 接続';
    }
}

// 参加を試みる
function tryToJoin(roomId) {
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    const targetId = roomId;
    
    if (targetId === peerId) {
        createRoom(roomId);
        return;
    }
    
    const newCall = peer.call(targetId, localStream);
    
    newCall.on('error', err => {
        console.log('参加エラー:', err.message);
        createRoom(roomId);
    });
    
    setupCall(newCall);
    
    setTimeout(() => {
        if (!call || !call.open) {
            createRoom(roomId);
        }
    }, 5000);
}

// ルーム作成
function createRoom(roomId) {
    if (isCreating) return;
    isCreating = true;
    
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    currentRoomId = roomId;
    
    status.textContent = `ルーム「${roomId}」を作成しました。相手を待っています...`;
    btn.textContent = '⏳ 待機中...';
    
    peer.on('call', incomingCall => {
        status.textContent = '✅ 通話中（作成者）';
        btn.textContent = '📞 通話中';
        btn.disabled = false;
        incomingCall.answer(localStream);
        setupCall(incomingCall);
    });
}

// 通話セットアップ
function setupCall(mediaConnection) {
    call = mediaConnection;
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    mediaConnection.on('stream', remoteStream => {
        status.textContent = '✅ 通話中';
        btn.textContent = '📞 通話中';
        btn.disabled = false;
        isCreating = false;
        
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.play().catch(err => {
            console.error('音声再生エラー:', err);
            status.textContent = '⚠️ 音声再生エラー';
        });
        
        console.log('通話確立！相手の音声を受信中');
    });
    
    mediaConnection.on('close', () => {
        status.textContent = '通話が終了しました';
        btn.textContent = '🔗 再接続';
        btn.disabled = false;
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        call = null;
        isCreating = false;
    });
    
    mediaConnection.on('error', err => {
        console.error('通話エラー:', err);
        status.textContent = `通話エラー: ${err.message}`;
    });
}

// ページ終了時
window.onbeforeunload = () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (peer) {
        peer.destroy();
    }
};
