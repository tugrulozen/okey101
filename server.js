const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Okey101 = require('./game');
const Validator = require('./validator');
const ytSearch = require('yt-search'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); 

const rooms = {}; 
const users = {}; 

function createRoom(roomId, roomName, hostId, settings) {
    return {
        id: roomId, name: roomName, status: 'waiting', 
        players: [null, null, null, null], spectators: [], hostId: hostId,
        globalOyun: null, siraKimde: 0, ortayaAcilanTumPerler: [], 
        yerdekiTaslar: { 0: null, 1: null, 2: null, 3: null }, oyunIlkTur: true,
        turnTimer: null, turnEndTime: null,
        music: { queue: [], currentSong: null, skipVotes: [] },
        settings: settings || { rounds: 1, isEsli: false, isKatlamali: false },
        currentRound: 1, overallScores: { 0: 0, 1: 0, 2: 0, 3: 0 }, teamScores: { A: 0, B: 0 },
        currentMaxSeri: 100, currentMaxCift: 4, startingPlayerIndex: 0,
        teamMaxSeri: { 0: 100, 1: 100 }, teamMaxCift: { 0: 4, 1: 4 } // YENİ: Takımlara özel katlama sınırı
    };
}

function getPublicRooms() { return Object.values(rooms).map(r => ({ id: r.id, name: r.name, playerCount: r.players.filter(p=>p!==null).length, status: r.status, playerIds: r.players.filter(p=>p!==null).map(p => p.playerId) })); }

function getRoomBySocket(socketId) {
    for (let rId in rooms) { 
        let isPlayer = rooms[rId].players.find(p => p && p.socketId === socketId);
        let isSpectator = rooms[rId].spectators.find(p => p && p.socketId === socketId);
        if (isPlayer || isSpectator) return rooms[rId]; 
    }
    return null;
}

function takeSnapshot(room, pInfo) {
    pInfo.turnState.snapshot = {
        el: JSON.parse(JSON.stringify(pInfo.el)), perler: JSON.parse(JSON.stringify(room.ortayaAcilanTumPerler)),
        perAcmisMi: pInfo.perAcmisMi, ciftAcmisMi: pInfo.ciftAcmisMi, toplamSeriIsleme: pInfo.turnState.toplamSeriIsleme || 0,
        roomMaxSeri: room.currentMaxSeri, roomMaxCift: room.currentMaxCift,
        teamMaxSeri: { ...room.teamMaxSeri }, teamMaxCift: { ...room.teamMaxCift },
        acmaPuani: pInfo.acmaPuani, acmaCift: pInfo.acmaCift
    };
}

function getSafeRoomState(room) {
    return {
        id: room.id, name: room.name, hostId: room.hostId, status: room.status,
        settings: room.settings || { rounds: 1, isEsli: false, isKatlamali: false },
        currentRound: room.currentRound || 1, turnEndTime: room.turnEndTime, siraKimde: room.siraKimde,
        currentMaxSeri: room.currentMaxSeri || 100, currentMaxCift: room.currentMaxCift || 4,
        teamMaxSeri: room.teamMaxSeri || {0:100, 1:100}, teamMaxCift: room.teamMaxCift || {0:4, 1:4},
        players: room.players.map(p => p ? { isim: p.isim, perAcmisMi: p.perAcmisMi, ciftAcmisMi: p.ciftAcmisMi, connected: p.connected, playerId: p.playerId, acmaPuani: p.acmaPuani, acmaCift: p.acmaCift } : null),
        spectators: room.spectators.map(p => p.isim)
    };
}

function playNextSong(room) {
    room.music.skipVotes = []; room.music.currentSong = room.music.queue.shift() || null;
    if (room.music.currentSong) {
        room.music.currentSong.startedAt = Date.now(); 
        io.to(room.id).emit('music_play', { ...room.music.currentSong, elapsedTime: 0 });
    } else { io.to(room.id).emit('music_play', null); }
}

function sendSyncedMusic(socket, room) {
    if (room && room.music && room.music.currentSong) {
        let elapsed = (Date.now() - room.music.currentSong.startedAt) / 1000; 
        socket.emit('music_play', { ...room.music.currentSong, elapsedTime: elapsed }); 
    }
}

function getOkeyRepresentedTile(group, okeyIndex, gameOkey) {
    let effTiles = group.map(t => Validator.getEffectiveTile(t, gameOkey));
    let normalTiles = effTiles.filter(t => !Validator.isOkey(t, gameOkey));
    if (normalTiles.length === 0) return null; 

    let isSet = normalTiles.every(t => t.value === normalTiles[0].value);
    if (isSet) { return { isSet: true, value: normalTiles[0].value, presentColors: normalTiles.map(t=>t.color) }; } 
    else {
        let color = normalTiles[0].color; let firstNormalIdx = effTiles.findIndex(t => !Validator.isOkey(t, gameOkey));
        let firstNormalVal = effTiles[firstNormalIdx].value; let targetVal = firstNormalVal + (okeyIndex - firstNormalIdx);
        return { isSet: false, color: color, value: targetVal };
    }
}

function tryAttachTileStrict(per, tile, gameOkey) {
    let isOkeyTile = Validator.isOkey(tile, gameOkey); let eTile = Validator.getEffectiveTile(tile, gameOkey);
    let normalTiles = per.filter(t => !Validator.isOkey(t, gameOkey));
    if (normalTiles.length === 0) return null;

    let isSet = true; let firstVal = Validator.getEffectiveTile(normalTiles[0], gameOkey).value;
    for (let t of normalTiles) { if (Validator.getEffectiveTile(t, gameOkey).value !== firstVal) { isSet = false; break; } }

    if (isSet) {
        if (isOkeyTile) { return [...per, tile]; } 
        else { if (eTile.value === firstVal) { let presentColors = normalTiles.map(t => Validator.getEffectiveTile(t, gameOkey).color); if (!presentColors.includes(eTile.color)) return [...per, tile]; } }
        return null;
    } else {
        if (per.length >= 13) return null;
        let runColor = Validator.getEffectiveTile(normalTiles[0], gameOkey).color;
        if (!isOkeyTile && eTile.color !== runColor) return null;

        let firstNormalIdx = per.findIndex(t => !Validator.isOkey(t, gameOkey));
        let firstNormalVal = Validator.getEffectiveTile(per[firstNormalIdx], gameOkey).value;
        let leftMostVal = firstNormalVal - firstNormalIdx; let rightMostVal = leftMostVal + per.length - 1;

        if (isOkeyTile) {
            if (rightMostVal < 13) return [...per, tile]; 
            if (leftMostVal > 1) return [tile, ...per]; 
            return null;
        } else {
            if (eTile.value === rightMostVal + 1 && eTile.value <= 13) return [...per, tile];
            if (eTile.value === leftMostVal - 1 && eTile.value >= 1) return [tile, ...per];
        }
        return null;
    }
}

function isTilePlayable(tile, room) {
    let gameOkey = room.globalOyun.okey;
    if (Validator.isOkey(tile, gameOkey)) return true; 

    for (let per of room.ortayaAcilanTumPerler) {
        if (per.length === 2) {
            let okeyIndex = per.findIndex(t => Validator.isOkey(t, gameOkey));
            if (okeyIndex !== -1) {
                let norm = per.find(x => !Validator.isOkey(x, gameOkey)) || per[0];
                let eNew = Validator.getEffectiveTile(tile, gameOkey); let eNorm = Validator.getEffectiveTile(norm, gameOkey);
                if (eNew.color === eNorm.color && eNew.value === eNorm.value) return true;
            }
            continue; 
        }
        let okeyIndex = per.findIndex(t => Validator.isOkey(t, gameOkey));
        if (okeyIndex !== -1) {
            let rep = getOkeyRepresentedTile(per, okeyIndex, gameOkey); let eNew = Validator.getEffectiveTile(tile, gameOkey);
            if (rep && rep.isSet) { if (eNew.value === rep.value && !rep.presentColors.includes(eNew.color) && rep.presentColors.length === 3) return true; } 
            else if (rep) { if (eNew.color === rep.color && eNew.value === rep.value) return true; }
        }
        if (tryAttachTileStrict(per, tile, gameOkey) !== null) return true;
    }
    return false;
}

function checkYandanAlinanTas(pInfo, socket) {
    if (pInfo.turnState.yandanAlinanTas) {
        if (!pInfo.el.find(t => t.id === pInfo.turnState.yandanAlinanTas.id)) {
            pInfo.turnState.yandanAlinanTas = null; pInfo.turnState.elAcmadanYandanAldi = false; socket.emit('yandanIptalKaldir'); 
        }
    }
}

function broadcastRoom(room) { io.to(room.id).emit('odaGuncellendi', getSafeRoomState(room)); }

io.on('connection', (socket) => {
    
    socket.on('isimDegistir', (yeniIsim) => {
        if(!yeniIsim || !yeniIsim.trim()) return;
        if(users[socket.id]) users[socket.id].isim = yeniIsim.trim();
        for (let rId in rooms) {
            let room = rooms[rId]; let changed = false;
            for(let i=0; i<4; i++){ if(room.players[i] && room.players[i].socketId === socket.id) { room.players[i].isim = users[socket.id].isim; changed = true; } }
            let spec = room.spectators.find(s => s.socketId === socket.id); if (spec) { spec.isim = users[socket.id].isim; changed = true; }
            if (changed) broadcastRoom(room);
        }
    });

    socket.on('kimlikBildir', ({ playerId, isim }) => {
        users[socket.id] = { playerId, isim }; let activeRoom = null;
        for (let rId in rooms) { 
            let pIdx = rooms[rId].players.findIndex(p => p && p.playerId === playerId);
            if (pIdx !== -1) { rooms[rId].players[pIdx].socketId = socket.id; rooms[rId].players[pIdx].connected = true; rooms[rId].players[pIdx].isim = isim; activeRoom = rooms[rId]; break; } 
            let spec = rooms[rId].spectators.find(s => s && s.playerId === playerId);
            if (spec) { spec.socketId = socket.id; spec.isim = isim; activeRoom = rooms[rId]; break; }
        }
        if (activeRoom) {
            socket.join(activeRoom.id); let benimIndex = activeRoom.players.findIndex(p => p && p.playerId === playerId);
            if (activeRoom.status === 'playing' && benimIndex !== -1) {
                socket.emit('reconnectData', { istaka: activeRoom.players[benimIndex].el, gosterge: activeRoom.globalOyun.gosterge, okey: activeRoom.globalOyun.okey, kalanTas: activeRoom.globalOyun.deck.length, benimIndex: benimIndex, isimler: activeRoom.players.map(p => p?p.isim:"Boş"), yerdekiTaslar: activeRoom.yerdekiTaslar, ortayaAcilanTumPerler: activeRoom.ortayaAcilanTumPerler, siraKimde: activeRoom.siraKimde, oyunIlkTur: activeRoom.oyunIlkTur });
                let solIdx = (activeRoom.siraKimde - 1 + 4) % 4;
                if (activeRoom.siraKimde === benimIndex) socket.emit('siraSende', { soldanGelenTas: activeRoom.yerdekiTaslar[solIdx], ilkTurMu: (activeRoom.oyunIlkTur && benimIndex === activeRoom.startingPlayerIndex), turnEndTime: activeRoom.turnEndTime }); else socket.emit('siraBaskasinda', { idx: activeRoom.siraKimde, turnEndTime: activeRoom.turnEndTime });
            }
            broadcastRoom(activeRoom); sendSyncedMusic(socket, activeRoom); 
        } else { socket.emit('hubGoster', getPublicRooms()); }
    });

    socket.on('odaOlustur', (ayarlar) => {
        let u = users[socket.id]; if(!u) return; let roomId = 'room_' + Date.now();
        let rName = ayarlar.odaAdi || `${u.isim}'in Masası`; rName = rName.substring(0, 20);
        let newRoom = createRoom(roomId, rName, u.playerId, ayarlar);
        newRoom.spectators.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim });
        rooms[roomId] = newRoom; socket.join(roomId); broadcastRoom(newRoom); io.emit('hubGuncelle', getPublicRooms());
    });

    socket.on('ayarlariGuncelle', (ayarlar) => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room && room.hostId === u.playerId && room.status === 'waiting') {
            room.settings = ayarlar; room.name = (ayarlar.odaAdi || room.name).substring(0, 20);
            broadcastRoom(room); socket.emit('bilgi', 'Oda ayarları güncellendi.');
        }
    });

    socket.on('odayaKatil', (roomId) => {
        let room = rooms[roomId]; let u = users[socket.id]; if (!room || !u) return socket.emit('hata', 'Oda bulunamadı.');
        let pIdx = room.players.findIndex(p => p && p.playerId === u.playerId);
        if (pIdx !== -1) { room.players[pIdx].socketId = socket.id; room.players[pIdx].connected = true; } 
        else { let spec = room.spectators.find(s => s.playerId === u.playerId); if (!spec) room.spectators.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim }); else spec.socketId = socket.id; }
        socket.join(roomId); broadcastRoom(room); sendSyncedMusic(socket, room);
    });

    socket.on('otur', (seatIdx) => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (!room || !u || room.status !== 'waiting') return;
        for(let i=0; i<4; i++){ if(room.players[i] && room.players[i].playerId === u.playerId) room.players[i] = null; }
        room.spectators = room.spectators.filter(s => s.playerId !== u.playerId);
        if (room.players[seatIdx] === null) { room.players[seatIdx] = { playerId: u.playerId, socketId: socket.id, isim: u.isim, connected: true, el: [], perAcmisMi: false, ciftAcmisMi: false, turnState: {}, cezalar: 0 }; } 
        else { room.spectators.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim }); socket.emit('hata', 'Bu koltuk dolu!'); }
        broadcastRoom(room); io.emit('hubGuncelle', getPublicRooms());
    });

    socket.on('sarkiAraEkle', (sarkiIsmi) => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (!room || !u || !sarkiIsmi.trim()) return;
        ytSearch(sarkiIsmi).then(results => {
            const video = results.videos.length > 0 ? results.videos[0] : null;
            if (video) {
                let songObj = { id: video.videoId, title: video.title, duration: video.timestamp, ekleyen: u.isim };
                room.music.queue.push(songObj); io.to(room.id).emit('yeniChatMesaji', { isim: '🎵 DJ Area51', mesaj: `"${songObj.title}" sıraya eklendi!`, type: 'system' });
                if (!room.music.currentSong) playNextSong(room);
            } else { socket.emit('hata', 'Şarkı bulunamadı.'); }
        }).catch(err => { socket.emit('hata', 'Şarkı aranırken bir sorun oluştu.'); });
    });
    
    socket.on('sarkiAtlaOy', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (!room || !u || !room.music.currentSong) return;
        if (!room.music.skipVotes.includes(u.playerId)) {
            room.music.skipVotes.push(u.playerId); let requiredVotes = Math.ceil(room.players.filter(p=>p!==null).length / 2);
            if (room.music.skipVotes.length >= requiredVotes) { io.to(room.id).emit('yeniChatMesaji', { isim: '🎵 DJ Area51', mesaj: 'Çoğunluk sağlandı, şarkı atlanıyor ⏭️', type: 'system' }); playNextSong(room); } 
            else { io.to(room.id).emit('music_voteUpdate', { current: room.music.skipVotes.length, required: requiredVotes }); }
        }
    });
    socket.on('sarkiBittiOtoGecis', () => { let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (room && room.hostId === u.playerId) { playNextSong(room); } });

    socket.on('masadanAyril', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room) {
            let pIdx = room.players.findIndex(p => p && p.playerId === u.playerId);
            if (room.status === 'playing' && pIdx !== -1) { 
                io.to(room.id).emit('hata', `${u.isim} masadan ayrıldı. Oyun iptal edildi!`);
                room.players[pIdx] = null; 
                room.status = 'waiting'; room.currentRound = 1; room.overallScores = { 0: 0, 1: 0, 2: 0, 3: 0 }; room.teamScores = { A: 0, B: 0 };
                if (room.turnTimer) clearTimeout(room.turnTimer);
            } else { 
                if(pIdx !== -1) room.players[pIdx] = null; 
                room.spectators = room.spectators.filter(s => s.playerId !== u.playerId);
                if (room.players.every(p => p === null) && room.spectators.length === 0) delete rooms[room.id]; 
                else if (room.hostId === u.playerId) { let nextHost = room.players.find(p=>p!==null) || room.spectators[0]; if(nextHost) room.hostId = nextHost.playerId; } 
            }
            socket.leave(room.id); if(rooms[room.id]) broadcastRoom(rooms[room.id]); io.emit('hubGuncelle', getPublicRooms()); socket.emit('hubGoster', getPublicRooms());
        }
    });

    socket.on('chatMesaji', (mesaj) => { let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (room && u && mesaj.trim() !== '') io.to(room.id).emit('yeniChatMesaji', { isim: u.isim, mesaj: mesaj.trim(), type: 'normal' }); });
    
    socket.on('oyunuBaslat', () => { 
        let room = getRoomBySocket(socket.id); let u = users[socket.id]; 
        if (room && u && room.hostId === u.playerId) {
            if (room.players.filter(p => p !== null).length === 4) { startGame(room); } else { socket.emit('hata', 'Masanın tüm koltukları dolmadan oyun başlatılamaz!'); }
        }
    });

    socket.on('ortadanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id);
        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && room.globalOyun.deck.length > 0) {
            let cekilenTas = room.globalOyun.deck.pop(); room.players[index].el.push(cekilenTas); room.players[index].turnState.tasCektiMi = true; takeSnapshot(room, room.players[index]);
            socket.emit('tasCekildi', cekilenTas); io.to(room.id).emit('desteGuncellendi', room.globalOyun.deck.length);
        }
    });

    socket.on('yandanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id); let solIdx = (index - 1 + 4) % 4; let yandakiTas = room.yerdekiTaslar[solIdx];
        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && yandakiTas) {
            room.players[index].el.push(yandakiTas); room.players[index].turnState.tasCektiMi = true; room.players[index].turnState.yandanAlinanTas = yandakiTas; 
            if (!room.players[index].perAcmisMi && !room.players[index].ciftAcmisMi) { room.players[index].turnState.elAcmadanYandanAldi = true; }
            socket.emit('yandanAldinZorunluAc'); takeSnapshot(room, room.players[index]); socket.emit('tasCekildi', yandakiTas); room.yerdekiTaslar[solIdx] = null; io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 
        }
    });

    socket.on('yandanAlmaIptal', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id); let pInfo = room.players[index];
        if (index === room.siraKimde && pInfo.turnState.yandanAlinanTas) {
            let solIdx = (index - 1 + 4) % 4; let tas = pInfo.turnState.yandanAlinanTas; pInfo.el = pInfo.el.filter(t => t.id !== tas.id); room.yerdekiTaslar[solIdx] = tas;
            pInfo.turnState.tasCektiMi = false; pInfo.turnState.yandanAlinanTas = null; pInfo.turnState.elAcmadanYandanAldi = false; pInfo.turnState.snapshot = null; 
            socket.emit('yandanIptalEdildi', tas.id); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar);
        }
    });

    socket.on('tasAt', (atilanTas) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id); let pInfo = room.players[index];
        if (index === room.siraKimde) {
            if (!pInfo.turnState.tasCektiMi) return socket.emit('hata', 'Taş çekmeden atamazsınız!');
            let yTas = pInfo.turnState.yandanAlinanTas;
            if (yTas && pInfo.el.find(t => t.id === yTas.id)) return socket.emit('hata', 'Yandan aldığınız taşı kullanmadınız, iptal edin veya işleyin!');

            let isOkeyTile = Validator.isOkey(atilanTas, room.globalOyun.okey);
            let isPlayable = room.ortayaAcilanTumPerler.length > 0 && isTilePlayable(atilanTas, room);

            if (pInfo.el.length === 1 && isOkeyTile) { pInfo.el = []; return oyunuBitir(room, index, "Okey Atarak Bitti"); }

            if (isOkeyTile || isPlayable) { pInfo.cezalar += 101; let sebepMsj = isOkeyTile ? 'yere Okey' : 'işlek taş'; io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sebepMsj} attı ve 101 ceza yedi!`, type: 'system' }); io.to(room.id).emit('bilgi', `${pInfo.isim}, ${sebepMsj} attığı için ceza yedi.`); }

            pInfo.el = pInfo.el.filter(t => t.id !== atilanTas.id); room.yerdekiTaslar[index] = atilanTas;
            socket.emit('tasAtildiOnay', atilanTas.id); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 
            if (room.siraKimde === room.startingPlayerIndex && room.oyunIlkTur) room.oyunIlkTur = false;

            if (pInfo.el.length === 0) return oyunuBitir(room, index, "El Bitti");
            if (room.globalOyun.deck.length === 0) return oyunuBitir(room, -1, "Deste Bitti"); 

            room.siraKimde = (room.siraKimde + 1) % 4; sirayiGecir(room, room.siraKimde);
        }
    });

    socket.on('geriToplaTalebi', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id);
        if (index !== room.siraKimde) return socket.emit('hata', 'Sıra sizde değil!'); let pInfo = room.players[index];
        if (!pInfo.turnState.snapshot) return socket.emit('hata', 'Önce taş çekmelisiniz veya toplanacak hamle yok.');
        
        pInfo.el = JSON.parse(JSON.stringify(pInfo.turnState.snapshot.el)); room.ortayaAcilanTumPerler = JSON.parse(JSON.stringify(pInfo.turnState.snapshot.perler)); 
        pInfo.perAcmisMi = pInfo.turnState.snapshot.perAcmisMi; pInfo.ciftAcmisMi = pInfo.turnState.snapshot.ciftAcmisMi; 
        pInfo.turnState.toplamSeriIsleme = pInfo.turnState.snapshot.toplamSeriIsleme || 0; pInfo.turnState.islenenPerler = {}; 
        pInfo.acmaPuani = pInfo.turnState.snapshot.acmaPuani || null; pInfo.acmaCift = pInfo.turnState.snapshot.acmaCift || null;
        
        if (pInfo.turnState.snapshot.roomMaxSeri !== undefined) room.currentMaxSeri = pInfo.turnState.snapshot.roomMaxSeri;
        if (pInfo.turnState.snapshot.roomMaxCift !== undefined) room.currentMaxCift = pInfo.turnState.snapshot.roomMaxCift;
        if (pInfo.turnState.snapshot.teamMaxSeri) room.teamMaxSeri = pInfo.turnState.snapshot.teamMaxSeri;
        if (pInfo.turnState.snapshot.teamMaxCift) room.teamMaxCift = pInfo.turnState.snapshot.teamMaxCift;

        if (pInfo.turnState.yandanAlinanTas) socket.emit('yandanAldinZorunluAc');
        socket.emit('geriToplandi', { el: pInfo.el, perler: room.ortayaAcilanTumPerler });
        io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); broadcastRoom(room);
    });

    socket.on('seriAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];
        if (pInfo.ciftAcmisMi && !pInfo.perAcmisMi) return socket.emit('hata', 'Çift açan oyuncu yeni seri açamaz, serilere sadece taş işleyebilir!');

        let isAlreadyOpened = pInfo.perAcmisMi || pInfo.ciftAcmisMi;
        let runsOnTable = room.ortayaAcilanTumPerler.some(p => p.length > 2);
        let isProcessing = isAlreadyOpened && runsOnTable;

        let sonuc = Validator.calculate101Score(gonderilenGruplar, room.globalOyun.okey, isProcessing);
        
        // YENİ: Eşli Sistem Katlama Sınırı (Sadece karşı takımın açtığı puan esas alınır)
        let reqSeri = 101;
        if (room.settings.isKatlamali) {
            if (room.settings.isEsli) {
                let oppTeam = (index + 1) % 2;
                reqSeri = (room.teamMaxSeri[oppTeam] || 100) + 1;
            } else { reqSeri = room.currentMaxSeri + 1; }
        }

        if (!isProcessing && sonuc.success && sonuc.score < reqSeri) {
            let msg = room.settings.isKatlamali ? `Katlamalı Mod aktif! Açmak için en az ${reqSeri} puan gerekiyor.` : `Açmak için en az 101 puana ulaşmalısınız.`;
            return socket.emit('hata', msg);
        }

        if (sonuc.success || pInfo.perAcmisMi) {
            let ilkKezAciliyor = !isAlreadyOpened; 
            let idler = []; gonderilenGruplar.forEach(grup => { 
                let sortedGrup = Validator.sortGroup(grup, room.globalOyun.okey);
                sortedGrup.forEach(t => { if (Validator.isOkey(t, room.globalOyun.okey)) t.ownerId = pInfo.playerId; });
                room.ortayaAcilanTumPerler.push(sortedGrup); 
                grup.forEach(t => idler.push(t.id)); 
            });

            if (ilkKezAciliyor && pInfo.turnState.elAcmadanYandanAldi && pInfo.turnState.yandanAlinanTas) {
                if (idler.includes(pInfo.turnState.yandanAlinanTas.id)) {
                    let solIdx = (index - 1 + 4) % 4; let atanOyuncu = room.players[solIdx];
                    let effYtas = Validator.getEffectiveTile(pInfo.turnState.yandanAlinanTas, room.globalOyun.okey);
                    let tasDegeri = effYtas.isSahte ? room.globalOyun.okey.value : effYtas.value;
                    let cezaPuani = tasDegeri * 10; atanOyuncu.cezalar += cezaPuani;
                    io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${atanOyuncu.isim}, ${pInfo.isim}'e seri açtıran taşı (${tasDegeri}) attığı için ${cezaPuani} ceza yedi!`, type: 'system' });
                }
            }

            if (ilkKezAciliyor) {
                pInfo.perAcmisMi = true; pInfo.turnState.elAcmadanYandanAldi = false; pInfo.acmaPuani = sonuc.score;
                if (room.settings.isKatlamali) {
                    room.currentMaxSeri = Math.max(room.currentMaxSeri, sonuc.score);
                    if (room.settings.isEsli) { let myTeam = index % 2; room.teamMaxSeri[myTeam] = Math.max(room.teamMaxSeri[myTeam], sonuc.score); }
                }
                io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sonuc.score} puanla seri el açtı.`, type: 'system' });
            }

            pInfo.el = pInfo.el.filter(t => !idler.includes(t.id)); checkYandanAlinanTas(pInfo, socket);
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            broadcastRoom(room); if (pInfo.el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('ciftAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];

        let pairsOnTable = room.ortayaAcilanTumPerler.some(p => p.length === 2);
        if (pInfo.perAcmisMi && !pInfo.ciftAcmisMi && !pairsOnTable) return socket.emit('hata', 'Masada çift açan kimse olmadığı için çift işleyemezsiniz!');

        let isAlreadyOpened = pInfo.perAcmisMi || pInfo.ciftAcmisMi;
        let isProcessing = isAlreadyOpened;

        // YENİ: Eşli Sistem Katlama Sınırı (Sadece karşı takımın açtığı çift esas alınır)
        let reqCift = 5;
        if (room.settings.isKatlamali) {
            if (room.settings.isEsli) {
                let oppTeam = (index + 1) % 2;
                reqCift = (room.teamMaxCift[oppTeam] || 4) + 1;
            } else { reqCift = room.currentMaxCift + 1; }
        }

        let sonuc = Validator.calculatePairs(gonderilenGruplar, room.globalOyun.okey, isProcessing);
        
        if (!isProcessing && sonuc.success && sonuc.pairCount < reqCift) {
            let msg = room.settings.isKatlamali ? `Katlamalı Mod aktif! Açmak için en az ${reqCift} çift gerekiyor.` : `Açmak için en az 5 çifte ulaşmalısınız.`;
            return socket.emit('hata', msg);
        }

        if (sonuc.success) {
            let ilkKezAciliyor = !isAlreadyOpened; 
            let idler = []; gonderilenGruplar.forEach(grup => { 
                let sortedGrup = Validator.sortGroup(grup, room.globalOyun.okey);
                sortedGrup.forEach(t => { if (Validator.isOkey(t, room.globalOyun.okey)) t.ownerId = pInfo.playerId; });
                room.ortayaAcilanTumPerler.push(sortedGrup); 
                grup.forEach(t => idler.push(t.id)); 
            });
            
            if (ilkKezAciliyor && pInfo.turnState.elAcmadanYandanAldi && pInfo.turnState.yandanAlinanTas) {
                if (idler.includes(pInfo.turnState.yandanAlinanTas.id)) {
                    let solIdx = (index - 1 + 4) % 4; let atanOyuncu = room.players[solIdx];
                    let effYtas = Validator.getEffectiveTile(pInfo.turnState.yandanAlinanTas, room.globalOyun.okey);
                    let tasDegeri = effYtas.isSahte ? room.globalOyun.okey.value : effYtas.value;
                    let cezaPuani = tasDegeri * 20; atanOyuncu.cezalar += cezaPuani;
                    io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${atanOyuncu.isim}, ${pInfo.isim}'e çift açtıran taşı (${tasDegeri}) attığı için ${cezaPuani} ceza yedi!`, type: 'system' });
                }
            }

            if (ilkKezAciliyor) {
                pInfo.ciftAcmisMi = true; pInfo.turnState.elAcmadanYandanAldi = false; pInfo.acmaCift = sonuc.pairCount;
                if (room.settings.isKatlamali) {
                    room.currentMaxCift = Math.max(room.currentMaxCift, sonuc.pairCount);
                    if (room.settings.isEsli) { let myTeam = index % 2; room.teamMaxCift[myTeam] = Math.max(room.teamMaxCift[myTeam], sonuc.pairCount); }
                }
                io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sonuc.pairCount} çift ile el açtı.`, type: 'system' });
            }
            
            pInfo.el = pInfo.el.filter(t => !idler.includes(t.id)); checkYandanAlinanTas(pInfo, socket);
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            broadcastRoom(room); if (pInfo.el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('yereIsleTalebi', ({ tasId, perIndex }) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p && p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];
        if (!pInfo.perAcmisMi && !pInfo.ciftAcmisMi) return socket.emit('hata', 'Önce elinizi açın!');
        
        let hedefPer = room.ortayaAcilanTumPerler[perIndex]; let islenecekTas = pInfo.el.find(t => t.id === parseInt(tasId)); 
        if (!islenecekTas || !hedefPer) return;

        let islemBasarili = false, okeyKazanildi = false, kazanilanOkeyTas = null; let gameOkey = room.globalOyun.okey;
        let okeyIndex = hedefPer.findIndex(t => Validator.isOkey(t, gameOkey));

        if (hedefPer.length === 2) {
            if (okeyIndex !== -1) {
                let norm = hedefPer.find(x => !Validator.isOkey(x, gameOkey)) || hedefPer[0];
                let eNew = Validator.getEffectiveTile(islenecekTas, gameOkey); let eNorm = Validator.getEffectiveTile(norm, gameOkey);
                if (eNew.color === eNorm.color && eNew.value === eNorm.value) {
                    let testGrup = [...hedefPer]; let okeyTas = testGrup.splice(okeyIndex, 1, islenecekTas)[0];
                    islemBasarili = true; okeyKazanildi = true; kazanilanOkeyTas = okeyTas; room.ortayaAcilanTumPerler[perIndex] = testGrup;
                } else { return socket.emit('hata', "Çiftlere sadece Okey'in yerine geçen taşı işleyebilirsiniz!"); }
            } else { return socket.emit('hata', "Tamamlanmış çiftlere dışarıdan taş işlenemez!"); }
        } 
        else {
            if (pInfo.ciftAcmisMi && !pInfo.perAcmisMi && hedefPer.length > 2) { if ((pInfo.turnState.toplamSeriIsleme || 0) >= 2) return socket.emit('hata', 'Çift açanlar bir turda serilere en fazla 2 taş işleyebilir!'); }
            
            if (okeyIndex !== -1) {
                let rep = getOkeyRepresentedTile(hedefPer, okeyIndex, gameOkey); let eNew = Validator.getEffectiveTile(islenecekTas, gameOkey); let canSteal = false;
                if (rep && rep.isSet) { if (eNew.value === rep.value && !rep.presentColors.includes(eNew.color)) { if (rep.presentColors.length === 3) canSteal = true; } } 
                else if (rep) { if (eNew.color === rep.color && eNew.value === rep.value) canSteal = true; }

                if (canSteal) {
                    let testGrup = [...hedefPer]; let okeyTas = testGrup.splice(okeyIndex, 1, islenecekTas)[0]; 
                    islemBasarili = true; okeyKazanildi = true; kazanilanOkeyTas = okeyTas; room.ortayaAcilanTumPerler[perIndex] = testGrup;
                }
            }

            if (!islemBasarili) { let newGrup = tryAttachTileStrict(hedefPer, islenecekTas, gameOkey); if (newGrup !== null) { islemBasarili = true; room.ortayaAcilanTumPerler[perIndex] = newGrup; } }
        }

        if (islemBasarili) {
            pInfo.el = pInfo.el.filter(t => t.id !== islenecekTas.id); 
            if (hedefPer.length > 2 && pInfo.ciftAcmisMi && !pInfo.perAcmisMi) { pInfo.turnState.toplamSeriIsleme = (pInfo.turnState.toplamSeriIsleme || 0) + 1; }

            if (okeyKazanildi && kazanilanOkeyTas.ownerId && kazanilanOkeyTas.ownerId !== pInfo.playerId) {
                let ownerIdx = room.players.findIndex(p => p && p.playerId === kazanilanOkeyTas.ownerId);
                if (ownerIdx !== -1) {
                    let isTeammate = room.settings.isEsli && (ownerIdx % 2 === index % 2);
                    if (!isTeammate) {
                        room.players[ownerIdx].cezalar += 101;
                        io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${room.players[ownerIdx].isim}, Okey'i çaldırdığı için 101 ceza yedi!`, type: 'system' });
                    }
                }
            }

            checkYandanAlinanTas(pInfo, socket);
            socket.emit('islemeBasarili', islenecekTas.id); if (okeyKazanildi) { pInfo.el.push(kazanilanOkeyTas); socket.emit('okeyKazanildi', kazanilanOkeyTas); } io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler);
            if (pInfo.el.length === 0) oyunuBitir(room, index, "İşleyerek Bitti");
        } else { socket.emit('hata', 'Taş bu gruba işlenemez!'); }
    });

    socket.on('sonrakiEl', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room && room.hostId === u.playerId && room.status === 'waiting') {
            startGame(room);
        }
    });

    socket.on('disconnect', () => { let room = getRoomBySocket(socket.id); if (room) { let player = room.players.find(p => p && p.socketId === socket.id); if (player) player.connected = false; } });
});

// YENİ: 22 TAŞ ALACAK KİŞİYİ AYARLAYAN BAŞLATMA FONKSİYONU
function startGame(room) {
    room.status = 'playing'; room.globalOyun = new Okey101(); room.ortayaAcilanTumPerler = []; room.yerdekiTaslar = { 0: null, 1: null, 2: null, 3: null };
    room.currentMaxSeri = 100; room.currentMaxCift = 4;
    room.teamMaxSeri = { 0: 100, 1: 100 }; room.teamMaxCift = { 0: 4, 1: 4 };
    
    // Oyun motorunun 22 taşı her zaman Player1'e verme mantığını kırıyoruz
    let hands = [ room.globalOyun.players[`player1`], room.globalOyun.players[`player2`], room.globalOyun.players[`player3`], room.globalOyun.players[`player4`] ];
    let maxLen = 0; let starterHandIdx = 0;
    for(let i=0; i<4; i++){ if(hands[i].length > maxLen){ maxLen = hands[i].length; starterHandIdx = i; } }
    let starterHand = hands.splice(starterHandIdx, 1)[0]; // 22'li taşı ayır
    
    for(let i=0; i<4; i++) { 
        room.players[i].el = (i === room.startingPlayerIndex) ? starterHand : hands.pop();
        room.players[i].perAcmisMi = false; room.players[i].ciftAcmisMi = false; room.players[i].cezalar = 0; room.players[i].acmaPuani = null; room.players[i].acmaCift = null; 
    }

    let isimListesi = room.players.map(o => o.isim);
    room.players.forEach((oyuncu, index) => { io.to(oyuncu.socketId).emit('oyunBasladi', { istaka: oyuncu.el, gosterge: room.globalOyun.gosterge, okey: room.globalOyun.okey, kalanTas: room.globalOyun.deck.length, benimIndex: index, isimler: isimListesi, maxSeri: room.currentMaxSeri, maxCift: room.currentMaxCift }); });
    io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); broadcastRoom(room);
    if(room.music.currentSong) io.to(room.id).emit('music_play', room.music.currentSong);
    
    room.oyunIlkTur = true; room.siraKimde = room.startingPlayerIndex; sirayiGecir(room, room.siraKimde); io.emit('hubGuncelle', getPublicRooms());
    
    // DÜZELTME: Bir dahaki ele yanındaki kişi başlayacak
    room.startingPlayerIndex = (room.startingPlayerIndex + 1) % 4; 
}

function forceAutoPlay(room, playerIndex) {
    if(room.status !== 'playing') return; let pInfo = room.players[playerIndex]; if (!pInfo) return;
    if (!pInfo.turnState.tasCektiMi) { if (room.globalOyun.deck.length > 0) { pInfo.el.push(room.globalOyun.deck.pop()); pInfo.turnState.tasCektiMi = true; io.to(room.id).emit('desteGuncellendi', room.globalOyun.deck.length); } }
    io.to(pInfo.socketId).emit('istakaGuncellendi', pInfo.el);
    if (pInfo.el.length > 0) {
        let randIdx = Math.floor(Math.random() * pInfo.el.length); let atilanTas = pInfo.el.splice(randIdx, 1)[0];
        if (pInfo.el.length === 0 && Validator.isOkey(atilanTas, room.globalOyun.okey)) return oyunuBitir(room, playerIndex, "Okey Atarak Bitti");
        let isOkeyTile = Validator.isOkey(atilanTas, room.globalOyun.okey); let isPlayable = room.ortayaAcilanTumPerler.length > 0 && isTilePlayable(atilanTas, room);
        if (isOkeyTile || isPlayable) { pInfo.cezalar += 101; let sebepMsj = isOkeyTile ? 'yere Okey' : 'işlek taş'; io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sebepMsj} attı ve 101 ceza yedi!`, type: 'system' }); io.to(room.id).emit('bilgi', `${pInfo.isim}, ${sebepMsj} attığı için ceza yedi.`); }
        room.yerdekiTaslar[playerIndex] = atilanTas; io.to(pInfo.socketId).emit('istakaGuncellendi', pInfo.el); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim} süresi dolduğu için otomatik oynadı.`, type: 'system' });
        if (room.siraKimde === (room.startingPlayerIndex === 0 ? 3 : room.startingPlayerIndex - 1) && room.oyunIlkTur) room.oyunIlkTur = false; // Tur tamamlandığında
        if (pInfo.el.length === 0) return oyunuBitir(room, playerIndex, "El Bitti"); if (room.globalOyun.deck.length === 0) return oyunuBitir(room, -1, "Deste Bitti"); 
        room.siraKimde = (room.siraKimde + 1) % 4; sirayiGecir(room, room.siraKimde);
    }
}

function sirayiGecir(room, yeniSiraIndex) {
    if (room.turnTimer) clearTimeout(room.turnTimer); let turnDuration = 60000; room.turnEndTime = Date.now() + turnDuration;
    room.players.forEach((oyuncu, idx) => {
        // Yeni ele başlayan kişinin turunda olup olmadığımızı kontrol ediyoruz
        let ilkElBasiMi = (room.oyunIlkTur && idx === ((room.startingPlayerIndex === 0) ? 3 : room.startingPlayerIndex - 1));
        if (oyuncu) {
            oyuncu.turnState = { tasCektiMi: ilkElBasiMi, elAcmadanYandanAldi: false, yandanAlinanTas: null, islenenPerler: {}, toplamSeriIsleme: 0 };
            if (ilkElBasiMi) takeSnapshot(room, oyuncu);
            if (oyuncu.connected) {
                if (idx === yeniSiraIndex) { let solIdx = (yeniSiraIndex - 1 + 4) % 4; io.to(oyuncu.socketId).emit('siraSende', { soldanGelenTas: room.yerdekiTaslar[solIdx], ilkTurMu: ilkElBasiMi, turnEndTime: room.turnEndTime }); } else { io.to(oyuncu.socketId).emit('siraBaskasinda', { idx: yeniSiraIndex, turnEndTime: room.turnEndTime }); }
            }
        }
    });
    room.turnTimer = setTimeout(() => { forceAutoPlay(room, yeniSiraIndex); }, turnDuration);
}

function oyunuBitir(room, bitirenIndex, sebep) {
    if (room.turnTimer) clearTimeout(room.turnTimer); room.status = 'waiting'; 
    let roundScores = [0, 0, 0, 0]; let playerStates = ["", "", "", ""];
    
    room.players.forEach((oyuncu, i) => {
        if (!oyuncu) return;
        let islekCezasi = oyuncu.cezalar || 0;
        if (i === bitirenIndex) { 
            roundScores[i] = (sebep === "Okey Atarak Bitti" ? -202 : -101) + islekCezasi; 
            playerStates[i] = "Bitirdi"; 
            if (sebep === "Okey Atarak Bitti") { room.players.forEach((diger, j) => { if(j !== bitirenIndex && diger) roundScores[j] += 808; }); }
        } else { 
            if (sebep === "Okey Atarak Bitti") {
                playerStates[i] = oyuncu.ciftAcmisMi ? "Çift Açtı" : (oyuncu.perAcmisMi ? "Seri Açtı" : "Açamadı");
                roundScores[i] += islekCezasi; 
            } else {
                if (!oyuncu.perAcmisMi && !oyuncu.ciftAcmisMi) { 
                    roundScores[i] += 202 + islekCezasi; playerStates[i] = "Açamadı"; 
                } else { 
                    let elCeza = 0; oyuncu.el.forEach(t => { elCeza += t.value; });
                    if (oyuncu.ciftAcmisMi && !oyuncu.perAcmisMi) { elCeza *= 2; playerStates[i] = "Çift Açtı"; } 
                    else { playerStates[i] = "Seri Açtı"; }
                    roundScores[i] += elCeza + islekCezasi; 
                }
            }
        }
    });

    let viewScores = []; let kazananIsim = "Bilinmiyor";

    if (bitirenIndex === -1) {
        if (room.settings.isEsli) {
            let teamA = roundScores[0] + roundScores[2]; let teamB = roundScores[1] + roundScores[3];
            kazananIsim = teamA < teamB ? "A Takımı" : (teamB < teamA ? "B Takımı" : "Berabere");
        } else {
            let minS = Math.min(...roundScores); let wIdx = roundScores.findIndex(s => s === minS);
            if (wIdx !== -1 && room.players[wIdx]) kazananIsim = room.players[wIdx].isim;
        }
        sebep = "Deste Bitti! En az cezayı yiyen kazandı.";
    } else { if(room.players[bitirenIndex]) kazananIsim = room.players[bitirenIndex].isim; }

    if (room.settings.isEsli) {
        let teamA = roundScores[0] + roundScores[2]; let teamB = roundScores[1] + roundScores[3];
        room.teamScores.A += teamA; room.teamScores.B += teamB;
        room.overallScores[0] += teamA; room.overallScores[2] += teamA; room.overallScores[1] += teamB; room.overallScores[3] += teamB;
        for(let i=0; i<4; i++) { if(room.players[i]) viewScores.push({ isim: room.players[i].isim, puan: roundScores[i], durum: playerStates[i], team: (i%2===0?"A Takımı":"B Takımı"), overall: room.overallScores[i] }); }
    } else {
        for(let i=0; i<4; i++) { if(room.players[i]) { room.overallScores[i] += roundScores[i]; viewScores.push({ isim: room.players[i].isim, puan: roundScores[i], durum: playerStates[i], team: null, overall: room.overallScores[i] }); } }
    }

    let isLastRound = room.currentRound >= room.settings.rounds;
    if (!isLastRound) room.currentRound++;
    viewScores.sort((a,b) => a.puan - b.puan);

    io.to(room.id).emit('oyunBitti', { kazananAdi: kazananIsim, kazanan: bitirenIndex, skorlar: viewScores, sebep: sebep, isLastRound: isLastRound, isEsli: room.settings.isEsli });
    broadcastRoom(room); io.emit('hubGuncelle', getPublicRooms());
}

const PORT = 3000; server.listen(PORT, () => console.log(`E-Spor Area51 Aktif: http://localhost:${PORT}`));