// ═══════════════════════════════════════════════════════════════
//  STUDY QUEST PRO — MÓDULO MULTIJUGADOR FIREBASE
//  Funciones: Ranking en tiempo real, Amigos por ID,
//             Desafíos directos, Chat entre amigos
// ═══════════════════════════════════════════════════════════════

const MP = {
    db: null,
    myId: null,
    unsubscribers: [],   // Para limpiar listeners
    friendListeners: {}, // playerId → unsubscribe
    chatListeners: {},   // chatId → unsubscribe

    // ── Inicialización ─────────────────────────────────────────
    init() {
        try {
            this.db = firebase.database();
            this.myId = this._getOrCreateId();
            console.log('[MP] Iniciado. ID:', this.myId);
            this._startPresence();
            this._listenGlobalRanking();
            this._listenIncomingChallenges();
            this._listenFriendsRealtime();
            this._listenGlobalChat();
            this._updateMyProfile();
            this._renderMyId();
        } catch (e) {
            console.error('[MP] Error al iniciar Firebase:', e);
        }
    },

    // ── ID único del jugador ───────────────────────────────────
    _getOrCreateId() {
        let id = localStorage.getItem('hvPlayerId');
        if (!id) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            id = 'HV-' + Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            localStorage.setItem('hvPlayerId', id);
        }
        return id;
    },

    _renderMyId() {
        const el = document.getElementById('my-player-id');
        if (el) el.textContent = this.myId;
    },

    // ── Presencia online ───────────────────────────────────────
    _startPresence() {
        const ref = this.db.ref(`players/${this.myId}/lastSeen`);
        ref.set(firebase.database.ServerValue.TIMESTAMP);
        const connRef = this.db.ref('.info/connected');
        connRef.on('value', snap => {
            if (snap.val()) {
                this.db.ref(`players/${this.myId}/online`).set(true);
                this.db.ref(`players/${this.myId}/online`).onDisconnect().set(false);
                this.db.ref(`players/${this.myId}/lastSeen`).onDisconnect().set(firebase.database.ServerValue.TIMESTAMP);
            }
        });
    },

    // ── Publicar mi perfil en Firebase ────────────────────────
    _updateMyProfile() {
        if (!this.db || !this.myId) return;
        this.db.ref(`players/${this.myId}`).update({
            name: appState.userName,
            points: appState.totalPuntos,
            xp: appState.totalXP,
            level: appState.currentLevel,
            rank: appState.currentRank,
            banner: appState.equippedBanner || 'Estudiante',
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    },

    // Llamar esto cada vez que saveState() se ejecute
    onSave() {
        this._updateMyProfile();
        this._checkChallengeProgress();
    },

    // ── Ranking global en tiempo real ─────────────────────────
    _globalPlayers: {},

    _listenGlobalRanking() {
        const ref = this.db.ref('players').orderByChild('points').limitToLast(100);
        const unsub = ref.on('value', snap => {
            this._globalPlayers = {};
            snap.forEach(child => {
                if (child.key !== this.myId) {
                    const d = child.val();
                    this._globalPlayers[child.key] = {
                        id: child.key,
                        name: d.name || 'Jugador',
                        points: d.points || 0,
                        rank: d.rank || 'Novato',
                        level: d.level || 1,
                        online: d.online || false,
                        isRealPlayer: true
                    };
                }
            });
            // Notificar al ranking local que hay datos nuevos
            if (typeof renderRanking === 'function') renderRanking(getCurrentRankingFilter?.() || 'all');
        });
        this.unsubscribers.push(() => ref.off('value', unsub));
    },

    getGlobalPlayers() {
        return Object.values(this._globalPlayers);
    },

    // ── Amigos por ID ─────────────────────────────────────────
    async addFriendById(friendId) {
        friendId = friendId.trim().toUpperCase();
        if (!friendId.startsWith('HV-') || friendId.length < 5) {
            showCustomAlert('ID inválido. Formato: HV-XXXXXX', 'error');
            return;
        }
        if (friendId === this.myId) {
            showCustomAlert('¡Ese es tu propio ID! 😄', 'warning');
            return;
        }

        // Verificar que el jugador existe
        const snap = await this.db.ref(`players/${friendId}`).once('value');
        if (!snap.exists()) {
            showCustomAlert('No se encontró ningún jugador con ese ID. ¿Ya se conectó alguna vez?', 'error');
            return;
        }

        const data = snap.val();

        // Guardar vínculo en Firebase (bidireccional)
        await this.db.ref(`friends/${this.myId}/${friendId}`).set(true);
        await this.db.ref(`friends/${friendId}/${this.myId}`).set(true);

        // Agregar localmente
        const friendData = {
            id: friendId,
            name: data.name || 'Jugador',
            points: data.points || 0,
            rank: data.rank || 'Novato',
            isFriend: true,
            isRealPlayer: true
        };

        // Actualizar o agregar en appState.friends
        const existing = appState.friends.findIndex(f => f.id === friendId);
        if (existing >= 0) {
            appState.friends[existing] = { ...appState.friends[existing], ...friendData };
        } else {
            appState.friends.push(friendData);
        }

        SoundSystem.addFriend();
        showCustomAlert(`✅ ¡${data.name} agregado como amigo en tiempo real!`, 'success');
        saveState();
        this._listenFriendRealtime(friendId);
        renderFriendsList();
        renderRanking(getCurrentRankingFilter?.() || 'all');
    },

    _listenFriendsRealtime() {
        // Escuchar la lista de amigos del usuario desde Firebase
        this.db.ref(`friends/${this.myId}`).once('value', snap => {
            if (!snap.exists()) return;
            snap.forEach(child => {
                this._listenFriendRealtime(child.key);
            });
        });

        // También escuchar cambios futuros (nuevos amigos que me agregan)
        this.db.ref(`friends/${this.myId}`).on('child_added', snap => {
            this._listenFriendRealtime(snap.key);
        });
    },

    _listenFriendRealtime(friendId) {
        if (this.friendListeners[friendId]) return; // ya escuchando

        const ref = this.db.ref(`players/${friendId}`);
        ref.on('value', snap => {
            if (!snap.exists()) return;
            const data = snap.val();
            const idx = appState.friends.findIndex(f => f.id === friendId);
            const updated = {
                id: friendId,
                name: data.name || 'Jugador',
                points: data.points || 0,
                rank: data.rank || 'Novato',
                level: data.level || 1,
                online: data.online || false,
                isFriend: true,
                isRealPlayer: true
            };
            if (idx >= 0) {
                appState.friends[idx] = { ...appState.friends[idx], ...updated };
            } else {
                appState.friends.push(updated);
            }
            saveState();
            renderFriendsList();
            renderRanking(getCurrentRankingFilter?.() || 'all');
        });

        this.friendListeners[friendId] = () => ref.off('value');
    },

    // ── Desafíos directos ─────────────────────────────────────
    _activeChallenges: {},

    async sendChallenge(friendId, type, goalLabel, durationHours) {
        const types = {
            study: { label: 'Estudiar más minutos', field: 'totalHoras' },
            points: { label: 'Ganar más puntos', field: 'totalPuntos' },
            xp: { label: 'Ganar más XP', field: 'totalXP' }
        };
        const t = types[type];
        if (!t) return;

        const challenge = {
            from: this.myId,
            fromName: appState.userName,
            to: friendId,
            type,
            label: t.label,
            field: t.field,
            durationHours,
            startTime: firebase.database.ServerValue.TIMESTAMP,
            endTime: Date.now() + durationHours * 3600000,
            status: 'pending',
            fromProgress: appState[t.field] || 0,
            toProgress: 0,
            fromBaseline: appState[t.field] || 0,
            toBaseline: 0
        };

        const ref = await this.db.ref('challenges').push(challenge);
        showCustomAlert(`⚔️ ¡Desafío enviado! Esperando respuesta...`, 'success');
        return ref.key;
    },

    async acceptChallenge(challengeId) {
        const snap = await this.db.ref(`challenges/${challengeId}`).once('value');
        const c = snap.val();
        if (!c || c.status !== 'pending') return;

        await this.db.ref(`challenges/${challengeId}`).update({
            status: 'active',
            toBaseline: appState[c.field] || 0,
            toProgress: appState[c.field] || 0
        });
        showCustomAlert(`⚔️ ¡Desafío aceptado! ¡Que empiece la batalla!`, 'success');
        SoundSystem.win();
    },

    async rejectChallenge(challengeId) {
        await this.db.ref(`challenges/${challengeId}`).update({ status: 'rejected' });
        showCustomAlert('Desafío rechazado.', 'info');
        this._renderChallenges();
    },

    _listenIncomingChallenges() {
        // Desafíos donde soy el receptor
        this.db.ref('challenges')
            .orderByChild('to')
            .equalTo(this.myId)
            .on('value', snap => {
                this._activeChallenges = {};
                snap.forEach(child => {
                    this._activeChallenges[child.key] = { id: child.key, ...child.val() };
                });
                this._renderChallenges();
                this._checkPendingChallengeNotifs();
            });

        // Desafíos donde soy el retador
        this.db.ref('challenges')
            .orderByChild('from')
            .equalTo(this.myId)
            .on('value', snap => {
                snap.forEach(child => {
                    const c = child.val();
                    if (!this._activeChallenges[child.key]) {
                        this._activeChallenges[child.key] = { id: child.key, ...c };
                    }
                });
                this._renderChallenges();
            });
    },

    _pendingNotifiedIds: new Set(),
    _checkPendingChallengeNotifs() {
        Object.values(this._activeChallenges).forEach(c => {
            if (c.status === 'pending' && c.to === this.myId && !this._pendingNotifiedIds.has(c.id)) {
                this._pendingNotifiedIds.add(c.id);
                showCustomAlert(`⚔️ ¡${c.fromName} te desafía! "${c.label}" por ${c.durationHours}h. ¡Ve a Desafíos!`, 'info');
                // Poner badge en nav
                const badge = document.getElementById('challenge-badge');
                if (badge) badge.style.display = 'inline-block';
            }
        });
    },

    _checkChallengeProgress() {
        Object.values(this._activeChallenges).forEach(c => {
            if (c.status !== 'active') return;
            const isFrom = c.from === this.myId;
            const isTo = c.to === this.myId;
            if (!isFrom && !isTo) return;

            const currentVal = appState[c.field] || 0;
            const field = isFrom ? 'fromProgress' : 'toProgress';
            const baseline = isFrom ? c.fromBaseline : c.toBaseline;
            const progress = currentVal - baseline;

            this.db.ref(`challenges/${c.id}`).update({ [field]: progress });

            // Verificar si expiró
            if (Date.now() > c.endTime && c.status === 'active') {
                this.db.ref(`challenges/${c.id}`).update({ status: 'completed' });
            }
        });
    },

    _renderChallenges() {
        const container = document.getElementById('challenges-container');
        if (!container) return;
        const badge = document.getElementById('challenge-badge');

        const list = Object.values(this._activeChallenges);
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--secondary-text);text-align:center;padding:15px">No tienes desafíos activos. ¡Reta a un amigo!</p>';
            if (badge) badge.style.display = 'none';
            return;
        }

        let pendingCount = 0;
        container.innerHTML = list.map(c => {
            const isFrom = c.from === this.myId;
            const myName = isFrom ? 'Tú' : c.fromName;
            const rivalName = isFrom ? (appState.friends.find(f => f.id === c.to)?.name || c.to) : c.fromName;
            const myProgress = isFrom ? (c.fromProgress || 0) : (c.toProgress || 0);
            const rivalProgress = isFrom ? (c.toProgress || 0) : (c.fromProgress || 0);

            let timeLeft = '';
            if (c.endTime) {
                const ms = c.endTime - Date.now();
                if (ms > 0) {
                    const h = Math.floor(ms / 3600000);
                    const m = Math.floor((ms % 3600000) / 60000);
                    timeLeft = `⏱ ${h}h ${m}m restantes`;
                } else {
                    timeLeft = '⏱ Tiempo agotado';
                }
            }

            let statusHtml = '';
            if (c.status === 'pending' && c.to === this.myId) {
                pendingCount++;
                statusHtml = `
                    <div class="challenge-actions">
                        <button onclick="MP.acceptChallenge('${c.id}')" class="btn-accept-challenge">✅ Aceptar</button>
                        <button onclick="MP.rejectChallenge('${c.id}')" class="btn-reject-challenge">❌ Rechazar</button>
                    </div>`;
            } else if (c.status === 'pending' && c.from === this.myId) {
                statusHtml = `<p class="challenge-waiting">⏳ Esperando respuesta...</p>`;
            } else if (c.status === 'active') {
                const myPct = Math.min(100, (myProgress / Math.max(myProgress, rivalProgress, 1)) * 100);
                const rivalPct = Math.min(100, (rivalProgress / Math.max(myProgress, rivalProgress, 1)) * 100);
                statusHtml = `
                    <div class="challenge-progress">
                        <div class="cp-row">
                            <span>Tú</span>
                            <div class="cp-bar"><div class="cp-fill mine" style="width:${myPct}%"></div></div>
                            <span>${myProgress}</span>
                        </div>
                        <div class="cp-row">
                            <span>${rivalName}</span>
                            <div class="cp-bar"><div class="cp-fill rival" style="width:${rivalPct}%"></div></div>
                            <span>${rivalProgress}</span>
                        </div>
                    </div>`;
            } else if (c.status === 'completed') {
                const iWon = myProgress > rivalProgress;
                statusHtml = `<p class="challenge-result ${iWon ? 'won' : 'lost'}">${iWon ? '🏆 ¡Ganaste!' : '😔 Perdiste'} — Tú: ${myProgress} vs ${rivalName}: ${rivalProgress}</p>`;
            } else if (c.status === 'rejected') {
                statusHtml = `<p class="challenge-result lost">❌ Desafío rechazado</p>`;
            }

            return `
                <div class="challenge-card status-${c.status}">
                    <div class="challenge-header">
                        <span class="challenge-type-icon">⚔️</span>
                        <div>
                            <h4>${c.label}</h4>
                            <small>${myName} vs ${rivalName} · ${timeLeft}</small>
                        </div>
                        <span class="challenge-status-badge ${c.status}">${
                            c.status === 'pending' ? '⏳ Pendiente' :
                            c.status === 'active' ? '🔥 Activo' :
                            c.status === 'completed' ? '✅ Terminado' : '❌ Rechazado'
                        }</span>
                    </div>
                    ${statusHtml}
                </div>`;
        }).join('');

        if (badge) badge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
    },

    // ── Chat entre amigos y global ─────────────────────────────
    _currentChatId: null,

    openChat(friendId, friendName) {
        const chatId = [this.myId, friendId].sort().join('_');
        this._currentChatId = chatId;

        const modal = document.getElementById('chat-modal');
        document.getElementById('chat-title').textContent = `💬 Chat con ${friendName}`;
        modal.style.display = 'flex';

        // Escuchar mensajes
        if (this.chatListeners[chatId]) {
            this.chatListeners[chatId](); // Desuscribir anterior
        }
        const ref = this.db.ref(`chats/${chatId}/messages`).limitToLast(50);
        ref.on('value', snap => {
            const msgs = [];
            snap.forEach(child => msgs.push(child.val()));
            this._renderChatMessages(msgs);
        });
        this.chatListeners[chatId] = () => ref.off('value');
    },

    closeChat() {
        document.getElementById('chat-modal').style.display = 'none';
        this._currentChatId = null;
    },

    sendChatMessage(text) {
        if (!text.trim() || !this._currentChatId) return;
        this.db.ref(`chats/${this._currentChatId}/messages`).push({
            senderId: this.myId,
            senderName: appState.userName,
            text: text.trim(),
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    _renderChatMessages(msgs) {
        const container = document.getElementById('chat-messages');
        if (!container) return;
        container.innerHTML = msgs.map(m => {
            const isMe = m.senderId === this.myId;
            return `
                <div class="chat-msg ${isMe ? 'mine' : 'theirs'}">
                    ${!isMe ? `<span class="chat-sender">${m.senderName}</span>` : ''}
                    <div class="chat-bubble">${m.text}</div>
                    <span class="chat-time">${m.timestamp ? new Date(m.timestamp).toLocaleTimeString('es', {hour:'2-digit',minute:'2-digit'}) : ''}</span>
                </div>`;
        }).join('');
        container.scrollTop = container.scrollHeight;
    },

    // Chat global
    openGlobalChat() {
        this._currentChatId = '__global__';
        const modal = document.getElementById('chat-modal');
        document.getElementById('chat-title').textContent = '🌍 Chat Global';
        modal.style.display = 'flex';

        if (this.chatListeners['__global__']) this.chatListeners['__global__']();
        const ref = this.db.ref('globalChat/messages').limitToLast(50);
        ref.on('value', snap => {
            const msgs = [];
            snap.forEach(child => msgs.push(child.val()));
            this._renderChatMessages(msgs);
        });
        this.chatListeners['__global__'] = () => ref.off('value');
    },

    _listenGlobalChat() {
        // Solo para badge de mensajes nuevos
        this.db.ref('globalChat/messages').limitToLast(1).on('child_added', snap => {
            const msg = snap.val();
            if (msg && msg.senderId !== this.myId) {
                // Si el chat no está abierto, mostrar notificación suave
                if (this._currentChatId !== '__global__') {
                    const badge = document.getElementById('global-chat-badge');
                    if (badge) badge.style.display = 'inline-block';
                }
            }
        });
    },

    sendGlobalMessage(text) {
        if (!text.trim()) return;
        this.db.ref('globalChat/messages').push({
            senderId: this.myId,
            senderName: appState.userName,
            text: text.trim(),
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    // ── UI Helper: abrir modal de desafío ─────────────────────
    openChallengeModal(friendId, friendName) {
        document.getElementById('challenge-modal').style.display = 'flex';
        document.getElementById('challenge-modal-title').textContent = `⚔️ Desafiar a ${friendName}`;
        document.getElementById('challenge-friend-id').value = friendId;
    },

    closeChallengeModal() {
        document.getElementById('challenge-modal').style.display = 'none';
    },

    async submitChallenge() {
        const friendId = document.getElementById('challenge-friend-id').value;
        const type = document.getElementById('challenge-type').value;
        const hours = parseInt(document.getElementById('challenge-hours').value) || 24;
        await this.sendChallenge(friendId, type, '', hours);
        this.closeChallengeModal();
    }
};
