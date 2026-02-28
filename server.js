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

function createRoom(roomId, roomName, hostId) {
    return {
        id: roomId, name: roomName, status: 'waiting', players: [], hostId: hostId,
        globalOyun: null, siraKimde: 0, ortayaAcilanTumPerler: [], 
        yerdekiTaslar: { 0: null, 1: null, 2: null, 3: null }, oyunIlkTur: true,
        turnTimer: null, turnEndTime: null,
        music: { queue: [], currentSong: null, skipVotes: [] }
    };
}

function getPublicRooms() { return Object.values(rooms).map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, status: r.status, playerIds: r.players.map(p => p.playerId) })); }

function getRoomBySocket(socketId) {
    for (let rId in rooms) { if (rooms[rId].players.find(p => p.socketId === socketId)) return rooms[rId]; }
    return null;
}

function takeSnapshot(room, pInfo) {
    pInfo.turnState.snapshot = {
        el: JSON.parse(JSON.stringify(pInfo.el)),
        perler: JSON.parse(JSON.stringify(room.ortayaAcilanTumPerler)),
        perAcmisMi: pInfo.perAcmisMi,
        ciftAcmisMi: pInfo.ciftAcmisMi,
        toplamSeriIsleme: pInfo.turnState.toplamSeriIsleme || 0
    };
}

function playNextSong(room) {
    room.music.skipVotes = [];
    room.music.currentSong = room.music.queue.shift() || null;
    if (room.music.currentSong) {
        room.music.currentSong.startedAt = Date.now(); 
        let payload = { ...room.music.currentSong, elapsedTime: 0 };
        io.to(room.id).emit('music_play', payload);
    } else {
        io.to(room.id).emit('music_play', null);
    }
}

function sendSyncedMusic(socket, room) {
    if (room && room.music && room.music.currentSong) {
        let elapsed = (Date.now() - room.music.currentSong.startedAt) / 1000; 
        let payload = { ...room.music.currentSong, elapsedTime: elapsed };
        socket.emit('music_play', payload); 
    }
}

function getOkeyRepresentedTile(group, okeyIndex, gameOkey) {
    let effTiles = group.map(t => Validator.getEffectiveTile(t, gameOkey));
    let normalTiles = effTiles.filter(t => !Validator.isOkey(t, gameOkey));
    if (normalTiles.length === 0) return null; 

    let isSet = normalTiles.every(t => t.value === normalTiles[0].value);
    if (isSet) {
        return { isSet: true, value: normalTiles[0].value, presentColors: normalTiles.map(t=>t.color) };
    } else {
        let color = normalTiles[0].color;
        let firstNormalIdx = effTiles.findIndex(t => !Validator.isOkey(t, gameOkey));
        let firstNormalVal = effTiles[firstNormalIdx].value;
        let targetVal = firstNormalVal + (okeyIndex - firstNormalIdx);
        return { isSet: false, color: color, value: targetVal };
    }
}

function tryAttachTileStrict(per, tile, gameOkey) {
    let isOkeyTile = Validator.isOkey(tile, gameOkey);
    let eTile = Validator.getEffectiveTile(tile, gameOkey);
    let normalTiles = per.filter(t => !Validator.isOkey(t, gameOkey));
    if (normalTiles.length === 0) return null;

    let isSet = true;
    let firstVal = Validator.getEffectiveTile(normalTiles[0], gameOkey).value;
    for (let t of normalTiles) {
        if (Validator.getEffectiveTile(t, gameOkey).value !== firstVal) { isSet = false; break; }
    }

    if (isSet) {
        if (per.length >= 4) return null;
        if (isOkeyTile) { return [...per, tile]; } 
        else {
            if (eTile.value === firstVal) {
                let presentColors = normalTiles.map(t => Validator.getEffectiveTile(t, gameOkey).color);
                if (!presentColors.includes(eTile.color)) return [...per, tile];
            }
        }
        return null;
    } else {
        if (per.length >= 13) return null;
        let runColor = Validator.getEffectiveTile(normalTiles[0], gameOkey).color;
        if (!isOkeyTile && eTile.color !== runColor) return null;

        let firstNormalIdx = per.findIndex(t => !Validator.isOkey(t, gameOkey));
        let firstNormalVal = Validator.getEffectiveTile(per[firstNormalIdx], gameOkey).value;

        let leftMostVal = firstNormalVal - firstNormalIdx;
        let rightMostVal = leftMostVal + per.length - 1;

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
        if (per.length === 2) continue; 
        
        let okeyIndex = per.findIndex(t => Validator.isOkey(t, gameOkey));
        if (okeyIndex !== -1) {
            let rep = getOkeyRepresentedTile(per, okeyIndex, gameOkey);
            let eNew = Validator.getEffectiveTile(tile, gameOkey);
            if (rep && rep.isSet) {
                if (eNew.value === rep.value && !rep.presentColors.includes(eNew.color) && rep.presentColors.length === 3) return true;
            } else if (rep) {
                if (eNew.color === rep.color && eNew.value === rep.value) return true;
            }
        }
        if (tryAttachTileStrict(per, tile, gameOkey) !== null) return true;
    }
    return false;
}

function checkYandanAlinanTas(pInfo, socket) {
    if (pInfo.turnState.yandanAlinanTas) {
        if (!pInfo.el.find(t => t.id === pInfo.turnState.yandanAlinanTas.id)) {
            pInfo.turnState.yandanAlinanTas = null;
            pInfo.turnState.elAcmadanYandanAldi = false;
            socket.emit('yandanIptalKaldir'); 
        }
    }
}

io.on('connection', (socket) => {
    
    socket.on('kimlikBildir', ({ playerId, isim }) => {
        users[socket.id] = { playerId, isim }; let activeRoom = null;
        for (let rId in rooms) { let player = rooms[rId].players.find(p => p.playerId === playerId); if (player) { player.socketId = socket.id; player.connected = true; player.isim = isim; activeRoom = rooms[rId]; break; } }
        if (activeRoom) {
            socket.join(activeRoom.id); let benimIndex = activeRoom.players.findIndex(p => p.playerId === playerId);
            if (activeRoom.status === 'playing') {
                socket.emit('reconnectData', { istaka: activeRoom.players[benimIndex].el, gosterge: activeRoom.globalOyun.gosterge, okey: activeRoom.globalOyun.okey, kalanTas: activeRoom.globalOyun.deck.length, benimIndex: benimIndex, isimler: activeRoom.players.map(p => p.isim), yerdekiTaslar: activeRoom.yerdekiTaslar, ortayaAcilanTumPerler: activeRoom.ortayaAcilanTumPerler, siraKimde: activeRoom.siraKimde, oyunIlkTur: activeRoom.oyunIlkTur });
                let solIdx = (activeRoom.siraKimde - 1 + 4) % 4;
                if (activeRoom.siraKimde === benimIndex) socket.emit('siraSende', { soldanGelenTas: activeRoom.yerdekiTaslar[solIdx], ilkTurMu: (activeRoom.oyunIlkTur && benimIndex === 0), turnEndTime: activeRoom.turnEndTime }); else socket.emit('siraBaskasinda', { idx: activeRoom.siraKimde, turnEndTime: activeRoom.turnEndTime });
            }
            io.to(activeRoom.id).emit('odaGuncellendi', { players: activeRoom.players.map(p => p.isim), hostId: activeRoom.hostId, status: activeRoom.status });
            sendSyncedMusic(socket, activeRoom); 
        } else { socket.emit('hubGoster', getPublicRooms()); }
    });

    socket.on('odaOlustur', (odaAdi) => {
        let u = users[socket.id]; if(!u) return; let roomId = 'room_' + Date.now();
        let newRoom = createRoom(roomId, odaAdi || `${u.isim}'in Masası`, u.playerId);
        newRoom.players.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim, connected: true, el: [], perAcmisMi: false, ciftAcmisMi: false, turnState: {}, cezalar: 0 });
        rooms[roomId] = newRoom; socket.join(roomId); io.to(roomId).emit('odaGuncellendi', { players: newRoom.players.map(p => p.isim), hostId: newRoom.hostId, status: newRoom.status }); io.emit('hubGuncelle', getPublicRooms());
    });

    socket.on('odayaKatil', (roomId) => {
        let room = rooms[roomId]; let u = users[socket.id]; if (!room || !u) return socket.emit('hata', 'Odaya katılamazsınız.');
        let existingPlayer = room.players.find(p => p.playerId === u.playerId);
        if (room.status === 'playing') {
            if (!existingPlayer) return socket.emit('hata', 'Oyun başlamış.'); existingPlayer.socketId = socket.id; existingPlayer.connected = true; socket.join(roomId);
            let benimIndex = room.players.findIndex(p => p.playerId === u.playerId);
            socket.emit('reconnectData', { istaka: room.players[benimIndex].el, gosterge: room.globalOyun.gosterge, okey: room.globalOyun.okey, kalanTas: room.globalOyun.deck.length, benimIndex: benimIndex, isimler: room.players.map(p => p.isim), yerdekiTaslar: room.yerdekiTaslar, ortayaAcilanTumPerler: room.ortayaAcilanTumPerler, siraKimde: room.siraKimde, oyunIlkTur: room.oyunIlkTur });
            let solIdx = (room.siraKimde - 1 + 4) % 4; if (room.siraKimde === benimIndex) socket.emit('siraSende', { soldanGelenTas: room.yerdekiTaslar[solIdx], ilkTurMu: (room.oyunIlkTur && benimIndex === 0), turnEndTime: room.turnEndTime }); else socket.emit('siraBaskasinda', { idx: room.siraKimde, turnEndTime: room.turnEndTime });
            io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
            sendSyncedMusic(socket, room); 
        } else {
            if (!existingPlayer && room.players.length >= 4) return socket.emit('hata', 'Oda dolu.');
            if (!existingPlayer) room.players.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim, connected: true, el: [], perAcmisMi: false, ciftAcmisMi: false, turnState: {}, cezalar: 0 }); else { existingPlayer.socketId = socket.id; existingPlayer.connected = true; }
            socket.join(roomId); io.to(roomId).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status }); io.emit('hubGuncelle', getPublicRooms());
            sendSyncedMusic(socket, room);
        }
    });

    socket.on('sarkiAraEkle', async (sarkiIsmi) => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (!room || !u || !sarkiIsmi.trim()) return;
        try {
            const results = await ytSearch(sarkiIsmi);
            const video = results.videos.length > 0 ? results.videos[0] : null;
            if (video) {
                let songObj = { id: video.videoId, title: video.title, duration: video.timestamp, ekleyen: u.isim };
                room.music.queue.push(songObj);
                io.to(room.id).emit('yeniChatMesaji', { isim: '🎵 DJ Area51', mesaj: `"${songObj.title}" sıraya eklendi!`, type: 'system' });
                if (!room.music.currentSong) playNextSong(room);
            } else { socket.emit('hata', 'Şarkı bulunamadı.'); }
        } catch(err) { socket.emit('hata', 'Şarkı aranırken bir sorun oluştu.'); }
    });

    socket.on('sarkiAtlaOy', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (!room || !u || !room.music.currentSong) return;
        if (!room.music.skipVotes.includes(u.playerId)) {
            room.music.skipVotes.push(u.playerId);
            let requiredVotes = Math.ceil(room.players.length / 2);
            if (room.music.skipVotes.length >= requiredVotes) {
                io.to(room.id).emit('yeniChatMesaji', { isim: '🎵 DJ Area51', mesaj: 'Çoğunluk sağlandı, şarkı atlanıyor ⏭️', type: 'system' });
                playNextSong(room);
            } else {
                io.to(room.id).emit('music_voteUpdate', { current: room.music.skipVotes.length, required: requiredVotes });
            }
        }
    });

    socket.on('sarkiBittiOtoGecis', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room && room.hostId === u.playerId) { playNextSong(room); }
    });

    socket.on('masadanAyril', () => {
        let room = getRoomBySocket(socket.id);
        if (room) {
            if (room.status === 'playing') { let player = room.players.find(p => p.socketId === socket.id); if (player) player.connected = false; socket.leave(room.id); } 
            else { room.players = room.players.filter(p => p.socketId !== socket.id); socket.leave(room.id); if (room.players.length === 0) delete rooms[room.id]; else { if(room.hostId === users[socket.id].playerId) room.hostId = room.players[0].playerId; io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status }); } }
            io.emit('hubGuncelle', getPublicRooms()); socket.emit('hubGoster', getPublicRooms());
        }
    });

    socket.on('chatMesaji', (mesaj) => { let room = getRoomBySocket(socket.id); let u = users[socket.id]; if (room && u && mesaj.trim() !== '') io.to(room.id).emit('yeniChatMesaji', { isim: u.isim, mesaj: mesaj.trim(), type: 'normal' }); });
    
    socket.on('oyunuBaslat', () => { 
        let room = getRoomBySocket(socket.id); let u = users[socket.id]; 
        if (room && u && room.hostId === u.playerId) {
            if (room.players.length === 4) {
                startGame(room); 
            } else {
                socket.emit('hata', 'Oyunu başlatmak için masada 4 kişi olmalısınız!');
            }
        }
    });

    socket.on('ortadanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && room.globalOyun.deck.length > 0) {
            let cekilenTas = room.globalOyun.deck.pop(); room.players[index].el.push(cekilenTas); room.players[index].turnState.tasCektiMi = true; takeSnapshot(room, room.players[index]);
            socket.emit('tasCekildi', cekilenTas); io.to(room.id).emit('desteGuncellendi', room.globalOyun.deck.length);
        }
    });

    socket.on('yandanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id); let solIdx = (index - 1 + 4) % 4; let yandakiTas = room.yerdekiTaslar[solIdx];
        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && yandakiTas) {
            room.players[index].el.push(yandakiTas); 
            room.players[index].turnState.tasCektiMi = true;
            room.players[index].turnState.yandanAlinanTas = yandakiTas; 
            if (!room.players[index].perAcmisMi && !room.players[index].ciftAcmisMi) { room.players[index].turnState.elAcmadanYandanAldi = true; }
            socket.emit('yandanAldinZorunluAc');
            takeSnapshot(room, room.players[index]); socket.emit('tasCekildi', yandakiTas); room.yerdekiTaslar[solIdx] = null; io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 
        }
    });

    socket.on('yandanAlmaIptal', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id); let pInfo = room.players[index];
        if (index === room.siraKimde && pInfo.turnState.yandanAlinanTas) {
            let solIdx = (index - 1 + 4) % 4; let tas = pInfo.turnState.yandanAlinanTas; 
            pInfo.el = pInfo.el.filter(t => t.id !== tas.id); room.yerdekiTaslar[solIdx] = tas;
            pInfo.turnState.tasCektiMi = false; pInfo.turnState.yandanAlinanTas = null; pInfo.turnState.elAcmadanYandanAldi = false; pInfo.turnState.snapshot = null; 
            socket.emit('yandanIptalEdildi', tas.id); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar);
        }
    });

    socket.on('tasAt', (atilanTas) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id); let pInfo = room.players[index];
        if (index === room.siraKimde) {
            if (!pInfo.turnState.tasCektiMi) return socket.emit('hata', 'Taş çekmeden atamazsınız!');
            let yTas = pInfo.turnState.yandanAlinanTas;
            if (yTas && pInfo.el.find(t => t.id === yTas.id)) return socket.emit('hata', 'Yandan aldığınız taşı kullanmadınız, iptal edin veya işleyin!');

            let isOkeyTile = Validator.isOkey(atilanTas, room.globalOyun.okey);
            let isPlayable = room.ortayaAcilanTumPerler.length > 0 && isTilePlayable(atilanTas, room);

            // OKEY ATMA VE İŞLEK TAŞ CEZASI (AYNEN KORUNDU)
            if (isOkeyTile || isPlayable) {
                pInfo.cezalar += 101; let sebepMsj = isOkeyTile ? 'yere Okey' : 'işlek taş';
                io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sebepMsj} attı ve 101 ceza yedi!`, type: 'system' });
                io.to(room.id).emit('bilgi', `${pInfo.isim}, ${sebepMsj} attığı için ceza yedi.`);
            }

            pInfo.el = pInfo.el.filter(t => t.id !== atilanTas.id); room.yerdekiTaslar[index] = atilanTas;
            socket.emit('tasAtildiOnay', atilanTas.id); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 
            if (room.siraKimde === 0 && room.oyunIlkTur) room.oyunIlkTur = false;

            if (pInfo.el.length === 0) return oyunuBitir(room, index, "El Bitti");
            if (room.globalOyun.deck.length === 0) return oyunuBitir(room, -1, "Deste Bitti"); 

            room.siraKimde = (room.siraKimde + 1) % 4; sirayiGecir(room, room.siraKimde);
        }
    });

    socket.on('geriToplaTalebi', () => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde) return socket.emit('hata', 'Sıra sizde değil!'); let pInfo = room.players[index];
        if (!pInfo.turnState.snapshot) return socket.emit('hata', 'Önce taş çekmelisiniz veya toplanacak hamle yok.');
        
        pInfo.el = JSON.parse(JSON.stringify(pInfo.turnState.snapshot.el)); room.ortayaAcilanTumPerler = JSON.parse(JSON.stringify(pInfo.turnState.snapshot.perler)); 
        pInfo.perAcmisMi = pInfo.turnState.snapshot.perAcmisMi; pInfo.ciftAcmisMi = pInfo.turnState.snapshot.ciftAcmisMi; 
        pInfo.turnState.toplamSeriIsleme = pInfo.turnState.snapshot.toplamSeriIsleme || 0; pInfo.turnState.islenenPerler = {}; 
        
        if (pInfo.turnState.yandanAlinanTas) socket.emit('yandanAldinZorunluAc');
        socket.emit('geriToplandi', { el: pInfo.el, perler: room.ortayaAcilanTumPerler });
        io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler);
    });

    socket.on('seriAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];
        
        if (pInfo.ciftAcmisMi && !pInfo.perAcmisMi) return socket.emit('hata', 'Çift açan oyuncu yeni seri açamaz, serilere sadece taş işleyebilir!');

        let isAlreadyOpened = pInfo.perAcmisMi || pInfo.ciftAcmisMi;
        let runsOnTable = room.ortayaAcilanTumPerler.some(p => p.length > 2);
        let isProcessing = isAlreadyOpened && runsOnTable;

        let sonuc = Validator.calculate101Score(gonderilenGruplar, room.globalOyun.okey, isProcessing);
        if (sonuc.success || pInfo.perAcmisMi) {
            let ilkKezAciliyor = !isAlreadyOpened; 

            let idler = []; gonderilenGruplar.forEach(grup => { room.ortayaAcilanTumPerler.push(Validator.sortGroup(grup, room.globalOyun.okey)); grup.forEach(t => idler.push(t.id)); });

            // YENİ: YANDAN ALINAN TAŞLA İLK DEFA SERİ AÇMA CEZASI (x10)
            if (ilkKezAciliyor && pInfo.turnState.elAcmadanYandanAldi && pInfo.turnState.yandanAlinanTas) {
                if (idler.includes(pInfo.turnState.yandanAlinanTas.id)) {
                    let solIdx = (index - 1 + 4) % 4; let atanOyuncu = room.players[solIdx];
                    let yTas = pInfo.turnState.yandanAlinanTas;
                    let tasDegeri = Validator.getEffectiveTile(yTas, room.globalOyun.okey).value;
                    let cezaPuani = tasDegeri * 10;
                    atanOyuncu.cezalar += cezaPuani;
                    io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${atanOyuncu.isim}, ${pInfo.isim}'e el açtıran taşı (${tasDegeri}) attığı için ${cezaPuani} ceza yedi!`, type: 'system' });
                }
            }

            pInfo.perAcmisMi = true; pInfo.turnState.elAcmadanYandanAldi = false; 
            if (ilkKezAciliyor) io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, seri el açtı.`, type: 'system' });

            pInfo.el = pInfo.el.filter(t => !idler.includes(t.id));
            checkYandanAlinanTas(pInfo, socket);
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            if (pInfo.el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('ciftAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];

        let isAlreadyOpened = pInfo.perAcmisMi || pInfo.ciftAcmisMi;
        let pairsOnTable = room.ortayaAcilanTumPerler.some(p => p.length === 2);
        let isProcessing = isAlreadyOpened && pairsOnTable;

        if (pInfo.perAcmisMi && !pairsOnTable) return socket.emit('hata', 'Masada çift açılmadığı için çift işleyemezsiniz!');

        let sonuc = Validator.calculatePairs(gonderilenGruplar, room.globalOyun.okey, isProcessing);
        if (sonuc.success) {
            let ilkKezAciliyor = !isAlreadyOpened; 

            let idler = []; gonderilenGruplar.forEach(grup => { room.ortayaAcilanTumPerler.push(Validator.sortGroup(grup, room.globalOyun.okey)); grup.forEach(t => idler.push(t.id)); });
            
            // YENİ: YANDAN ALINAN TAŞLA İLK DEFA ÇİFT AÇMA CEZASI (x20)
            if (ilkKezAciliyor && pInfo.turnState.elAcmadanYandanAldi && pInfo.turnState.yandanAlinanTas) {
                if (idler.includes(pInfo.turnState.yandanAlinanTas.id)) {
                    let solIdx = (index - 1 + 4) % 4; let atanOyuncu = room.players[solIdx];
                    let yTas = pInfo.turnState.yandanAlinanTas;
                    let tasDegeri = Validator.getEffectiveTile(yTas, room.globalOyun.okey).value;
                    let cezaPuani = tasDegeri * 20;
                    atanOyuncu.cezalar += cezaPuani;
                    io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${atanOyuncu.isim}, ${pInfo.isim}'e çift açtıran taşı (${tasDegeri}) attığı için ${cezaPuani} ceza yedi!`, type: 'system' });
                }
            }

            pInfo.ciftAcmisMi = true; pInfo.turnState.elAcmadanYandanAldi = false; 
            if (ilkKezAciliyor) io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, çift el açtı.`, type: 'system' });
            
            pInfo.el = pInfo.el.filter(t => !idler.includes(t.id));
            checkYandanAlinanTas(pInfo, socket);
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            if (pInfo.el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('yereIsleTalebi', ({ tasId, perIndex }) => {
        let room = getRoomBySocket(socket.id); if(!room) return; let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde) return; let pInfo = room.players[index];
        if (!pInfo.perAcmisMi && !pInfo.ciftAcmisMi) return socket.emit('hata', 'Önce elinizi açın!');
        
        let hedefPer = room.ortayaAcilanTumPerler[perIndex];
        let islenecekTas = pInfo.el.find(t => t.id === parseInt(tasId)); 
        if (!islenecekTas || !hedefPer) return;

        if (hedefPer.length === 2) return socket.emit('hata', "Çiftlere tek taş işlenemez! Çift işlemek için 'Çift Aç' kullanın.");

        if (pInfo.ciftAcmisMi && !pInfo.perAcmisMi && hedefPer.length > 2) {
            if ((pInfo.turnState.toplamSeriIsleme || 0) >= 2) return socket.emit('hata', 'Çift açanlar bir turda serilere en fazla 2 taş işleyebilir!');
        }

        let islemBasarili = false, okeyKazanildi = false, kazanilanOkeyTas = null;
        let gameOkey = room.globalOyun.okey;
        let okeyIndex = hedefPer.findIndex(t => Validator.isOkey(t, gameOkey));
        
        if (okeyIndex !== -1) {
            let rep = getOkeyRepresentedTile(hedefPer, okeyIndex, gameOkey);
            let eNew = Validator.getEffectiveTile(islenecekTas, gameOkey);
            let canSteal = false;
            if (rep && rep.isSet) { if (eNew.value === rep.value && !rep.presentColors.includes(eNew.color)) { if (rep.presentColors.length === 3) canSteal = true; } } 
            else if (rep) { if (eNew.color === rep.color && eNew.value === rep.value) canSteal = true; }

            if (canSteal) {
                let testGrup = [...hedefPer]; let okeyTas = testGrup.splice(okeyIndex, 1, islenecekTas)[0]; 
                islemBasarili = true; okeyKazanildi = true; kazanilanOkeyTas = okeyTas; room.ortayaAcilanTumPerler[perIndex] = testGrup;
            }
        }

        if (!islemBasarili) {
            let newGrup = tryAttachTileStrict(hedefPer, islenecekTas, gameOkey);
            if (newGrup !== null) { islemBasarili = true; room.ortayaAcilanTumPerler[perIndex] = newGrup; }
        }

        if (islemBasarili) {
            pInfo.el = pInfo.el.filter(t => t.id !== islenecekTas.id); 
            if (pInfo.ciftAcmisMi && !pInfo.perAcmisMi && hedefPer.length > 2) { pInfo.turnState.toplamSeriIsleme = (pInfo.turnState.toplamSeriIsleme || 0) + 1; }

            checkYandanAlinanTas(pInfo, socket);
            socket.emit('islemeBasarili', islenecekTas.id); if (okeyKazanildi) { pInfo.el.push(kazanilanOkeyTas); socket.emit('okeyKazanildi', kazanilanOkeyTas); } io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler);
            if (pInfo.el.length === 0) oyunuBitir(room, index, "İşleyerek Bitti");
        } else { socket.emit('hata', 'Taş bu gruba işlenemez (Okeyin yerine tam uymuyor veya seri dışı)!'); }
    });

    socket.on('disconnect', () => { let room = getRoomBySocket(socket.id); if (room) { let player = room.players.find(p => p.socketId === socket.id); if (player) player.connected = false; } });
});

function startGame(room) {
    room.status = 'playing'; room.globalOyun = new Okey101(); room.ortayaAcilanTumPerler = []; room.yerdekiTaslar = { 0: null, 1: null, 2: null, 3: null };
    for(let i=0; i<4; i++) { room.players[i].el = room.globalOyun.players[`player${i+1}`]; room.players[i].perAcmisMi = false; room.players[i].ciftAcmisMi = false; room.players[i].cezalar = 0; }
    let isimListesi = room.players.map(o => o.isim);
    room.players.forEach((oyuncu, index) => { io.to(oyuncu.socketId).emit('oyunBasladi', { istaka: oyuncu.el, gosterge: room.globalOyun.gosterge, okey: room.globalOyun.okey, kalanTas: room.globalOyun.deck.length, benimIndex: index, isimler: isimListesi }); });
    io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
    
    room.oyunIlkTur = true; room.siraKimde = 0; sirayiGecir(room, 0); io.emit('hubGuncelle', getPublicRooms());
}

function forceAutoPlay(room, playerIndex) {
    if(room.status !== 'playing') return; let pInfo = room.players[playerIndex]; if (!pInfo) return;
    if (!pInfo.turnState.tasCektiMi) { if (room.globalOyun.deck.length > 0) { pInfo.el.push(room.globalOyun.deck.pop()); pInfo.turnState.tasCektiMi = true; io.to(room.id).emit('desteGuncellendi', room.globalOyun.deck.length); } }
    io.to(pInfo.socketId).emit('istakaGuncellendi', pInfo.el);
    if (pInfo.el.length > 0) {
        let randIdx = Math.floor(Math.random() * pInfo.el.length); let atilanTas = pInfo.el.splice(randIdx, 1)[0];
        let isOkeyTile = Validator.isOkey(atilanTas, room.globalOyun.okey); let isPlayable = room.ortayaAcilanTumPerler.length > 0 && isTilePlayable(atilanTas, room);
        
        if (isOkeyTile || isPlayable) {
            pInfo.cezalar += 101; let sebepMsj = isOkeyTile ? 'yere Okey' : 'işlek taş'; 
            io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim}, ${sebepMsj} attı ve 101 ceza yedi!`, type: 'system' }); 
            io.to(room.id).emit('bilgi', `${pInfo.isim}, ${sebepMsj} attığı için ceza yedi.`);
        }
        
        room.yerdekiTaslar[playerIndex] = atilanTas; io.to(pInfo.socketId).emit('istakaGuncellendi', pInfo.el); io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); io.to(room.id).emit('yeniChatMesaji', { isim: 'SİSTEM', mesaj: `${pInfo.isim} süresi dolduğu için otomatik oynadı.`, type: 'system' });
        if (room.siraKimde === 0 && room.oyunIlkTur) room.oyunIlkTur = false;
        if (pInfo.el.length === 0) return oyunuBitir(room, playerIndex, "El Bitti"); if (room.globalOyun.deck.length === 0) return oyunuBitir(room, -1, "Deste Bitti"); 
        room.siraKimde = (room.siraKimde + 1) % 4; sirayiGecir(room, room.siraKimde);
    }
}

function sirayiGecir(room, yeniSiraIndex) {
    if (room.turnTimer) clearTimeout(room.turnTimer); let turnDuration = 60000; room.turnEndTime = Date.now() + turnDuration;
    room.players.forEach((oyuncu, idx) => {
        let ilkElBasiMi = (room.oyunIlkTur && idx === 0); oyuncu.turnState = { tasCektiMi: ilkElBasiMi, elAcmadanYandanAldi: false, yandanAlinanTas: null, islenenPerler: {}, toplamSeriIsleme: 0 };
        if (ilkElBasiMi) takeSnapshot(room, oyuncu);
        if (oyuncu.connected) {
            if (idx === yeniSiraIndex) { let solIdx = (yeniSiraIndex - 1 + 4) % 4; io.to(oyuncu.socketId).emit('siraSende', { soldanGelenTas: room.yerdekiTaslar[solIdx], ilkTurMu: ilkElBasiMi, turnEndTime: room.turnEndTime }); } else { io.to(oyuncu.socketId).emit('siraBaskasinda', { idx: yeniSiraIndex, turnEndTime: room.turnEndTime }); }
        }
    });
    room.turnTimer = setTimeout(() => { forceAutoPlay(room, yeniSiraIndex); }, turnDuration);
}

function oyunuBitir(room, bitirenIndex, sebep) {
    if (room.turnTimer) clearTimeout(room.turnTimer); room.status = 'waiting'; 
    let skorTablosu = room.players.map((oyuncu, i) => {
        let sonuc = { isim: oyuncu.isim, puan: 0, durum: "" }; let islekCezasi = oyuncu.cezalar || 0;
        if (i === bitirenIndex) { sonuc.puan = -101 + islekCezasi; sonuc.durum = "Bitirdi"; } 
        else if (!oyuncu.perAcmisMi && !oyuncu.ciftAcmisMi) { sonuc.puan = 202 + islekCezasi; sonuc.durum = "Açamadı"; } 
        else { 
            let elCeza = 0; oyuncu.el.forEach(t => { elCeza += t.value; });
            if (oyuncu.ciftAcmisMi && !oyuncu.perAcmisMi) { elCeza *= 2; sonuc.durum = "Çift Açtı"; } else { sonuc.durum = "Seri Açtı"; }
            sonuc.puan = elCeza + islekCezasi; 
        }
        return sonuc;
    });

    let kazananIndex = bitirenIndex;
    if (bitirenIndex === -1) {
        let minScore = Math.min(...skorTablosu.map(s => s.puan)); let kazananlar = skorTablosu.filter(s => s.puan === minScore);
        kazananIndex = (minScore === 202 && kazananlar.length === 4) ? -1 : skorTablosu.findIndex(s => s.puan === minScore);
    }
    skorTablosu.sort((a,b) => a.puan - b.puan);
    io.to(room.id).emit('oyunBitti', { kazanan: kazananIndex, skorlar: skorTablosu, sebep: sebep });
    io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status }); io.emit('hubGuncelle', getPublicRooms());
}

const PORT = 3000; server.listen(PORT, () => console.log(`E-Spor Area51 Aktif: http://localhost:${PORT}`));