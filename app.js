let peer, localStream, call;
let isCreating = false;

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
            document.getElementById('status').textContent = `接続完了 (ID: ${id})`;
            document.getElementById('myId').textContent = id;
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
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return localStream;
    } catch (err) {
        alert('マイクへのアクセスが拒否されました');
        throw err;
    }
}

// メイン関数：ボタン一つで作成or参加を自動判定
async function connect() {
    const roomId = document.getElementById('roomId').value || 'room123';
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    // ボタンを無効化（二重クリック防止）
    btn.disabled = true;
    btn.textContent = '接続中...';
    
    const peer = initPeer();
    
    try {
        await getAudio();
        status.textContent = `「${roomId}」に接続中...`;
        
        // まず相手に発信してみる（既存ルームに参加しようとする）
        const newCall = peer.call(roomId, localStream);
        
        // 通話セットアップ（成功したら既存ルーム）
        setupCall(newCall);
        
        // エラーハンドリング（ルームが存在しない場合）
        newCall.on('error', err => {
            // エラーが「相手が存在しない」の場合、自分が作成者になる
            if (err.message.includes('does not exist') || err.message.includes('not found')) {
                status.textContent = `ルーム「${roomId}」が見つかりません。新しく作成します...`;
                createRoom(roomId);
            } else {
                status.textContent = `エラー: ${err.message}`;
                btn.disabled = false;
                btn.textContent = '🔗 接続';
            }
        });
        
        // タイムアウト対策（5秒経過しても応答がない場合）
        setTimeout(() => {
            if (!call || !call.open) {
                status.textContent = `ルーム「${roomId}」が見つかりません。新しく作成します...`;
                createRoom(roomId);
            }
        }, 5000);
        
    } catch (err) {
        console.error(err);
        status.textContent = 'マイクの取得に失敗しました';
        btn.disabled = false;
        btn.textContent = '🔗 接続';
    }
}

// ルーム作成（発信者）
function createRoom(roomId) {
    if (isCreating) return;
    isCreating = true;
    
    const status = document.getElementById('status');
    const btn = document.getElementById('connectBtn');
    
    // 着信を待機
    peer.on('call', incomingCall => {
        if (incomingCall.peer === roomId) {
            incomingCall.answer(localStream);
            setupCall(incomingCall);
            status.textContent = '✅ 通話中（ルーム作成者）';
            btn.textContent = '📞 通話中';
        }
    });
    
    status.textContent = `ルーム「${roomId}」を作成しました。相手の参加を待っています...`;
    btn.textContent = '⏳ 待機中...';
    
    // 自分自身で通話状態を確認（エラー回避）
    setTimeout(() => {
        if (!call || !call.open) {
            // まだ誰も参加していない
        }
    }, 1000);
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
        
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.play().catch(console.error);
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
        status.textContent = '通話エラーが発生しました';
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
