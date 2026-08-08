// ===== 設定 =====
const supabaseUrl = 'https://jkhmlkdehtrdvkdyygzi.supabase.co/rest/v1/';  // ← あなたのURLに変更
const supabaseKey = 'sb_publishable_se7oqUzI7Pc5aGKAj2RQ1w_fDHTuZZW';              // ← あなたのキーに変更
const supabase = createClient(supabaseUrl, supabaseKey);

// ===== 状態 =====
let localStream = null;
const peers = {};
let roomId = '';
let userName = '';
let channel = null;
let isMuted = false;

// ===== DOM要素 =====
const videoGrid = document.getElementById('video-grid');
const roomIdInput = document.getElementById('roomId');
const userNameInput = document.getElementById('userName');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const muteBtn = document.getElementById('muteBtn');
const statusEl = document.getElementById('connection-status');
const countEl = document.getElementById('participant-count');

// ===== メディア取得 =====
async function getMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 15 }
            }
        });
        addVideo('自分', localStream, true);
        updateStatus('online', '接続済み');
        return true;
    } catch (e) {
        updateStatus('offline', 'カメラ/マイクエラー');
        alert('カメラとマイクの許可が必要です');
        return false;
    }
}

// ===== 映像追加 =====
function addVideo(name, stream, isLocal = false) {
    // 既に存在すればスキップ
    const exist = document.getElementById('video-' + name);
    if (exist) return;

    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = 'video-' + name;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const label = document.createElement('div');
    label.className = 'label' + (isLocal ? ' local' : '');
    label.textContent = isLocal ? '👤 ' + name : name;

    container.appendChild(video);
    container.appendChild(label);
    videoGrid.appendChild(container);
    
    updateParticipantCount();
}

// ===== 映像削除 =====
function removeVideo(name) {
    const el = document.getElementById('video-' + name);
    if (el) {
        el.remove();
        updateParticipantCount();
    }
}

// ===== 参加者数更新 =====
function updateParticipantCount() {
    const count = document.querySelectorAll('.video-container').length;
    countEl.textContent = '👤 ' + count + '人';
}

// ===== ステータス更新 =====
function updateStatus(state, text) {
    statusEl.className = 'status ' + state;
    statusEl.textContent = text;
}

// ===== 相手と接続 =====
function connectToPeer(targetId) {
    if (peers[targetId]) return;
    if (targetId === userName) return;

    const peer = new SimplePeer({
        initiator: true,
        stream: localStream,
        trickle: false,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        }
    });

    peer.on('signal', signal => {
        if (channel) {
            channel.send({
                type: 'broadcast',
                event: 'signal',
                payload: { from: userName, signal, to: targetId }
            });
        }
    });

    peer.on('stream', stream => {
        addVideo(targetId, stream);
    });

    peer.on('close', () => {
        removeVideo(targetId);
        delete peers[targetId];
    });

    peer.on('error', err => {
        console.warn('Peer error:', err);
    });

    peers[targetId] = peer;
}

// ===== 通話参加 =====
async function joinCall() {
    roomId = roomIdInput.value.trim();
    userName = userNameInput.value.trim() || '匿名';

    if (!roomId) {
        alert('ルーム名を入力してください');
        return;
    }

    if (!await getMedia()) return;

    // Supabaseチャンネル
    channel = supabase.channel('room:' + roomId);

    // シグナル受信
    channel.on('broadcast', { event: 'signal' }, (payload) => {
        const data = payload.payload;
        if (data.from === userName) return;

        if (!peers[data.from]) {
            const peer = new SimplePeer({
                initiator: false,
                stream: localStream,
                trickle: false,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            peer.on('signal', signal => {
                if (channel) {
                    channel.send({
                        type: 'broadcast',
                        event: 'signal',
                        payload: { from: userName, signal, to: data.from }
                    });
                }
            });

            peer.on('stream', stream => {
                addVideo(data.from, stream);
            });

            peer.on('close', () => {
                removeVideo(data.from);
                delete peers[data.from];
            });

            peer.signal(data.signal);
            peers[data.from] = peer;
        } else {
            peers[data.from].signal(data.signal);
        }
    });

    // Presence（参加者管理）
    channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const users = Object.keys(state).filter(id => id !== userName);
        
        // 新しく来た人と接続
        users.forEach(id => {
            if (!peers[id]) {
                connectToPeer(id);
            }
        });
    });

    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
        newPresences.forEach(p => {
            if (p.user !== userName && !peers[p.user]) {
                connectToPeer(p.user);
            }
        });
    });

    channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        leftPresences.forEach(p => {
            removeVideo(p.user);
            if (peers[p.user]) {
                peers[p.user].destroy();
                delete peers[p.user];
            }
        });
    });

    // チャンネル参加
    await channel.subscribe();
    
    // 自分をPresence登録
    await channel.track({
        user: userName,
        joined_at: new Date().toISOString()
    });

    // UI更新
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    roomIdInput.disabled = true;
    userNameInput.disabled = true;
    updateStatus('online', '通話中');
}

// ===== 通話退出 =====
function leaveCall() {
    // 全Peer切断
    Object.values(peers).forEach(p => p.destroy());
    Object.keys(peers).forEach(key => delete peers[key]);

    if (channel) {
        channel.unsubscribe();
        channel = null;
    }

    // 自分の映像以外を削除
    document.querySelectorAll('.video-container:not(#video-自分)').forEach(el => el.remove());
    
    // 音声停止
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    // UI更新
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    roomIdInput.disabled = false;
    userNameInput.disabled = false;
    updateStatus('offline', 'オフライン');
    updateParticipantCount();
}

// ===== ミュート切り替え =====
function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
    muteBtn.classList.toggle('muted', isMuted);
}

// ===== イベント登録 =====
joinBtn.onclick = joinCall;
leaveBtn.onclick = leaveCall;
muteBtn.onclick = toggleMute;

// ===== 初期状態 =====
updateStatus('offline', 'オフライン');
updateParticipantCount();

// Enterキーで参加
roomIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall();
});
userNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall();
});
