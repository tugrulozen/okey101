const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Okey101 = require('./game');
const Validator = require('./validator');

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
        yerdekiTaslar: { 0: null, 1: null, 2: null, 3: null }, oyunIlkTur: true
    };
}

function getPublicRooms() {
    return Object.values(rooms).map(r => ({ 
        id: r.id, name: r.name, playerCount: r.players.length, status: r.status,
        playerIds: r.players.map(p => p.playerId)
    }));
}

function getRoomBySocket(socketId) {
    for (let rId in rooms) {
        if (rooms[rId].players.find(p => p.socketId === socketId)) return rooms[rId];
    }
    return null;
}

io.on('connection', (socket) => {
    
    socket.on('kimlikBildir', ({ playerId, isim }) => {
        users[socket.id] = { playerId, isim };
        let activeRoom = null;
        for (let rId in rooms) {
            let player = rooms[rId].players.find(p => p.playerId === playerId);
            if (player) {
                player.socketId = socket.id; player.connected = true; player.isim = isim;
                activeRoom = rooms[rId]; break;
            }
        }

        if (activeRoom) {
            socket.join(activeRoom.id);
            let benimIndex = activeRoom.players.findIndex(p => p.playerId === playerId);
            
            if (activeRoom.status === 'playing') {
                socket.emit('reconnectData', {
                    istaka: activeRoom.players[benimIndex].el,
                    gosterge: activeRoom.globalOyun.gosterge, okey: activeRoom.globalOyun.okey,
                    kalanTas: activeRoom.globalOyun.deck.length, benimIndex: benimIndex,
                    isimler: activeRoom.players.map(p => p.isim),
                    yerdekiTaslar: activeRoom.yerdekiTaslar,
                    ortayaAcilanTumPerler: activeRoom.ortayaAcilanTumPerler,
                    siraKimde: activeRoom.siraKimde, oyunIlkTur: activeRoom.oyunIlkTur
                });

                let solIdx = (activeRoom.siraKimde - 1 + 4) % 4;
                if (activeRoom.siraKimde === benimIndex) socket.emit('siraSende', { soldanGelenTas: activeRoom.yerdekiTaslar[solIdx], ilkTurMu: (activeRoom.oyunIlkTur && benimIndex === 0) });
                else socket.emit('siraBaskasinda', activeRoom.siraKimde);
            }
            io.to(activeRoom.id).emit('odaGuncellendi', { players: activeRoom.players.map(p => p.isim), hostId: activeRoom.hostId, status: activeRoom.status });
        } else {
            socket.emit('hubGoster', getPublicRooms());
        }
    });

    socket.on('odaOlustur', (odaAdi) => {
        let u = users[socket.id]; if(!u) return;
        let roomId = 'room_' + Date.now();
        let newRoom = createRoom(roomId, odaAdi || `${u.isim}'in Masası`, u.playerId);
        newRoom.players.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim, connected: true, el: [], perAcmisMi: false, ciftAcmisMi: false, turnState: {} });
        rooms[roomId] = newRoom;
        
        socket.join(roomId);
        io.to(roomId).emit('odaGuncellendi', { players: newRoom.players.map(p => p.isim), hostId: newRoom.hostId, status: newRoom.status });
        io.emit('hubGuncelle', getPublicRooms());
    });

    socket.on('odayaKatil', (roomId) => {
        let room = rooms[roomId]; let u = users[socket.id];
        if (!room || !u) return socket.emit('hata', 'Odaya katılamazsınız.');
        
        let existingPlayer = room.players.find(p => p.playerId === u.playerId);

        if (room.status === 'playing') {
            if (!existingPlayer) return socket.emit('hata', 'Oyun başlamış, bu odaya katılamazsınız.');
            
            existingPlayer.socketId = socket.id;
            existingPlayer.connected = true;
            socket.join(roomId);
            
            let benimIndex = room.players.findIndex(p => p.playerId === u.playerId);
            socket.emit('reconnectData', {
                istaka: room.players[benimIndex].el,
                gosterge: room.globalOyun.gosterge, okey: room.globalOyun.okey,
                kalanTas: room.globalOyun.deck.length, benimIndex: benimIndex,
                isimler: room.players.map(p => p.isim),
                yerdekiTaslar: room.yerdekiTaslar,
                ortayaAcilanTumPerler: room.ortayaAcilanTumPerler,
                siraKimde: room.siraKimde, oyunIlkTur: room.oyunIlkTur
            });

            let solIdx = (room.siraKimde - 1 + 4) % 4;
            if (room.siraKimde === benimIndex) socket.emit('siraSende', { soldanGelenTas: room.yerdekiTaslar[solIdx], ilkTurMu: (room.oyunIlkTur && benimIndex === 0) });
            else socket.emit('siraBaskasinda', room.siraKimde);
            
            io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
        } else {
            if (!existingPlayer && room.players.length >= 4) return socket.emit('hata', 'Oda dolu.');
            
            if (!existingPlayer) {
                room.players.push({ playerId: u.playerId, socketId: socket.id, isim: u.isim, connected: true, el: [], perAcmisMi: false, ciftAcmisMi: false, turnState: {} });
            } else {
                existingPlayer.socketId = socket.id;
                existingPlayer.connected = true;
            }
            socket.join(roomId);
            io.to(roomId).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
            io.emit('hubGuncelle', getPublicRooms());
        }
    });

    socket.on('masadanAyril', () => {
        let room = getRoomBySocket(socket.id);
        if (room) {
            if (room.status === 'playing') {
                let player = room.players.find(p => p.socketId === socket.id);
                if (player) player.connected = false; 
                socket.leave(room.id);
            } else {
                room.players = room.players.filter(p => p.socketId !== socket.id);
                socket.leave(room.id);
                if (room.players.length === 0) {
                    delete rooms[room.id];
                } else {
                    if(room.hostId === users[socket.id].playerId) room.hostId = room.players[0].playerId;
                    io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
                }
            }
            io.emit('hubGuncelle', getPublicRooms());
            socket.emit('hubGoster', getPublicRooms());
        }
    });

    socket.on('chatMesaji', (mesaj) => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room && u && mesaj.trim() !== '') {
            io.to(room.id).emit('yeniChatMesaji', { isim: u.isim, mesaj: mesaj.trim() });
        }
    });

    socket.on('oyunuBaslat', () => {
        let room = getRoomBySocket(socket.id); let u = users[socket.id];
        if (room && u && room.hostId === u.playerId && room.players.length === 4) startGame(room);
    });

    socket.on('ortadanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && room.globalOyun.deck.length > 0) {
            let cekilenTas = room.globalOyun.deck.pop(); 
            room.players[index].el.push(cekilenTas);
            room.players[index].turnState.tasCektiMi = true;
            socket.emit('tasCekildi', cekilenTas);
            io.to(room.id).emit('desteGuncellendi', room.globalOyun.deck.length);
            
            // DİKKAT: Ortadan taş çekildiğinde sol tarafın taşı SİLİNMEZ! 
            // Sadece tüm odaya son çöpler güncel olarak gönderilir.
            io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar);
        }
    });

    socket.on('yandanCek', () => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        let solIdx = (index - 1 + 4) % 4; let yandakiTas = room.yerdekiTaslar[solIdx];

        if (index === room.siraKimde && !room.players[index].turnState.tasCektiMi && yandakiTas) {
            room.players[index].el.push(yandakiTas);
            room.players[index].turnState.tasCektiMi = true;
            if (!room.players[index].perAcmisMi && !room.players[index].ciftAcmisMi) {
                room.players[index].turnState.elAcmadanYandanAldi = true;
                room.players[index].turnState.sonAlinanYandanTas = yandakiTas;
                socket.emit('yandanAldinZorunluAc');
            }
            socket.emit('tasCekildi', yandakiTas);
            
            // Taşı aldığı için yerden silinir
            room.yerdekiTaslar[solIdx] = null; 
            io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 
        }
    });

    socket.on('yandanAlmaIptal', () => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index === room.siraKimde && room.players[index].turnState.elAcmadanYandanAldi) {
            let solIdx = (index - 1 + 4) % 4; let tas = room.players[index].turnState.sonAlinanYandanTas;
            room.players[index].el = room.players[index].el.filter(t => t.id !== tas.id);
            room.yerdekiTaslar[solIdx] = tas;
            room.players[index].turnState.tasCektiMi = false; room.players[index].turnState.elAcmadanYandanAldi = false;
            socket.emit('yandanIptalEdildi', tas.id);
            io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar);
        }
    });

    socket.on('tasAt', (atilanTas) => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index === room.siraKimde) {
            if (!room.players[index].turnState.tasCektiMi) return socket.emit('hata', 'Taş çekmeden atamazsınız!');
            if (room.players[index].turnState.elAcmadanYandanAldi) return socket.emit('hata', 'Yandan aldığınız için açmak zorundasınız!');

            room.players[index].el = room.players[index].el.filter(t => t.id !== atilanTas.id);
            
            // Attığı taş çöpe kaydedilir ve diğerlerinin ekranında görünür olmaya devam eder
            room.yerdekiTaslar[index] = atilanTas;
            socket.emit('tasAtildiOnay', atilanTas.id);
            io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar); 

            if (room.siraKimde === 0 && room.oyunIlkTur) room.oyunIlkTur = false;

            if (room.players[index].el.length === 0) return oyunuBitir(room, index, "El Bitti");
            if (room.globalOyun.deck.length === 0) return oyunuBitir(room, -1, "Deste Bitti"); 

            room.siraKimde = (room.siraKimde + 1) % 4; sirayiGecir(room, room.siraKimde);
        }
    });

    socket.on('seriAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde || room.players[index].ciftAcmisMi) return socket.emit('hata', 'Seri açamazsınız!');

        let sonuc = Validator.calculate101Score(gonderilenGruplar, room.globalOyun.okey);
        if (sonuc.success || room.players[index].perAcmisMi) {
            room.players[index].perAcmisMi = true; room.players[index].turnState.elAcmadanYandanAldi = false; 
            
            let idler = [];
            gonderilenGruplar.forEach(grup => { 
                room.ortayaAcilanTumPerler.push(Validator.sortGroup(grup, room.globalOyun.okey)); 
                grup.forEach(t => idler.push(t.id)); 
            });
            room.players[index].el = room.players[index].el.filter(t => !idler.includes(t.id));
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            if (room.players[index].el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('ciftAcmaTalebi', (gonderilenGruplar) => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde || room.players[index].perAcmisMi) return socket.emit('hata', 'Çifte dönemezsiniz!');

        let sonuc = Validator.calculatePairs(gonderilenGruplar, room.globalOyun.okey);
        if (sonuc.success || room.players[index].ciftAcmisMi) {
            room.players[index].ciftAcmisMi = true; room.players[index].turnState.elAcmadanYandanAldi = false; 
            let idler = [];
            gonderilenGruplar.forEach(grup => { room.ortayaAcilanTumPerler.push(Validator.sortGroup(grup, room.globalOyun.okey)); grup.forEach(t => idler.push(t.id)); });
            room.players[index].el = room.players[index].el.filter(t => !idler.includes(t.id));
            socket.emit('perAcildiOnay', idler); io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler); 
            if (room.players[index].el.length === 0) oyunuBitir(room, index, "El Bitti");
        } else { socket.emit('hata', sonuc.message); }
    });

    socket.on('yereIsleTalebi', ({ tasId, perIndex }) => {
        let room = getRoomBySocket(socket.id); if(!room) return;
        let index = room.players.findIndex(p => p.socketId === socket.id);
        if (index !== room.siraKimde) return;
        
        let pInfo = room.players[index];
        if (!pInfo.perAcmisMi && !pInfo.ciftAcmisMi) return socket.emit('hata', 'Önce elinizi açın!');
        
        let islenenSayi = pInfo.turnState.islenenPerler[perIndex] || 0;
        if (islenenSayi >= 2) return socket.emit('hata', 'Bu pere bu elde maks 2 taş!');

        let islenecekTas = pInfo.el.find(t => t.id === parseInt(tasId));
        let hedefPer = room.ortayaAcilanTumPerler[perIndex];
        if (!islenecekTas || !hedefPer) return;

        let islemBasarili = false, okeyKazanildi = false, kazanilanOkeyTas = null;
        let isTargetPair = hedefPer.length >= 2 && hedefPer.every(t => {
            let e1 = Validator.getEffectiveTile(t, room.globalOyun.okey);
            let norm = hedefPer.find(x => !Validator.isOkey(x, room.globalOyun.okey)) || hedefPer[0];
            let eNorm = Validator.getEffectiveTile(norm, room.globalOyun.okey);
            return e1.color === eNorm.color && e1.value === eNorm.value;
        });

        let okeyIndex = hedefPer.findIndex(t => Validator.isOkey(t, room.globalOyun.okey));
        if (okeyIndex !== -1) {
            let testGrup = [...hedefPer];
            let okeyTas = testGrup.splice(okeyIndex, 1)[0]; 
            testGrup.push(islenecekTas); 
            
            if (isTargetPair) {
                let norm = testGrup.find(x => !Validator.isOkey(x, room.globalOyun.okey));
                let eNew = Validator.getEffectiveTile(islenecekTas, room.globalOyun.okey);
                let eNorm = Validator.getEffectiveTile(norm, room.globalOyun.okey);
                if (eNew.color === eNorm.color && eNew.value === eNorm.value) {
                    islemBasarili = true; okeyKazanildi = true; kazanilanOkeyTas = okeyTas;
                    room.ortayaAcilanTumPerler[perIndex] = testGrup;
                }
            } else if (Validator.isGroupValid(testGrup, room.globalOyun.okey)) {
                islemBasarili = true; okeyKazanildi = true; kazanilanOkeyTas = okeyTas;
                room.ortayaAcilanTumPerler[perIndex] = Validator.sortGroup(testGrup, room.globalOyun.okey);
            }
        }

        if (!islemBasarili) {
            let testGrup = [...hedefPer, islenecekTas];
            if (isTargetPair) {
                 let norm = hedefPer.find(x => !Validator.isOkey(x, room.globalOyun.okey)) || hedefPer[0];
                 let eNew = Validator.getEffectiveTile(islenecekTas, room.globalOyun.okey);
                 let eNorm = Validator.getEffectiveTile(norm, room.globalOyun.okey);
                 if ((eNew.color === eNorm.color && eNew.value === eNorm.value) || Validator.isOkey(islenecekTas, room.globalOyun.okey)) {
                     islemBasarili = true;
                     room.ortayaAcilanTumPerler[perIndex] = testGrup; 
                 }
            } else if (Validator.isGroupValid(testGrup, room.globalOyun.okey)) {
                islemBasarili = true; 
                room.ortayaAcilanTumPerler[perIndex] = Validator.sortGroup(testGrup, room.globalOyun.okey);
            }
        }

        if (islemBasarili) {
            pInfo.el = pInfo.el.filter(t => t.id !== islenecekTas.id);
            pInfo.turnState.islenenPerler[perIndex] = islenenSayi + 1; 
            socket.emit('islemeBasarili', islenecekTas.id);
            if (okeyKazanildi) { pInfo.el.push(kazanilanOkeyTas); socket.emit('okeyKazanildi', kazanilanOkeyTas); }
            io.to(room.id).emit('masaGuncellendi', room.ortayaAcilanTumPerler);
            if (pInfo.el.length === 0) oyunuBitir(room, index, "İşleyerek Bitti");
        } else { socket.emit('hata', 'Taş bu gruba işlenemez!'); }
    });

    socket.on('disconnect', () => {
        let room = getRoomBySocket(socket.id);
        if (room) { let player = room.players.find(p => p.socketId === socket.id); if (player) player.connected = false; }
    });
});

function startGame(room) {
    room.status = 'playing'; room.globalOyun = new Okey101();
    room.ortayaAcilanTumPerler = []; room.yerdekiTaslar = { 0: null, 1: null, 2: null, 3: null };
    for(let i=0; i<4; i++) {
        room.players[i].el = room.globalOyun.players[`player${i+1}`];
        room.players[i].perAcmisMi = false; room.players[i].ciftAcmisMi = false;
    }
    
    let isimListesi = room.players.map(o => o.isim);
    room.players.forEach((oyuncu, index) => {
        io.to(oyuncu.socketId).emit('oyunBasladi', {
            istaka: oyuncu.el, gosterge: room.globalOyun.gosterge, okey: room.globalOyun.okey,
            kalanTas: room.globalOyun.deck.length, benimIndex: index, isimler: isimListesi
        });
    });
    
    io.to(room.id).emit('coplerGuncellendi', room.yerdekiTaslar);
    io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
    
    room.oyunIlkTur = true; room.siraKimde = 0; sirayiGecir(room, 0);
    io.emit('hubGuncelle', getPublicRooms());
}

function sirayiGecir(room, yeniSiraIndex) {
    room.players.forEach((oyuncu, idx) => {
        let ilkElBasiMi = (room.oyunIlkTur && idx === 0);
        oyuncu.turnState = { tasCektiMi: ilkElBasiMi, elAcmadanYandanAldi: false, sonAlinanYandanTas: null, islenenPerler: {} };
        if (oyuncu.connected) {
            if (idx === yeniSiraIndex) {
                let solIdx = (yeniSiraIndex - 1 + 4) % 4;
                io.to(oyuncu.socketId).emit('siraSende', { soldanGelenTas: room.yerdekiTaslar[solIdx], ilkTurMu: ilkElBasiMi });
            } else { io.to(oyuncu.socketId).emit('siraBaskasinda', yeniSiraIndex); }
        }
    });
}

function oyunuBitir(room, bitirenIndex, sebep) {
    room.status = 'waiting'; 
    let skorTablosu = room.players.map((oyuncu, i) => {
        let sonuc = { isim: oyuncu.isim, puan: 0, durum: "" };
        if (i === bitirenIndex) { sonuc.puan = -101; sonuc.durum = "Bitirdi"; } 
        else if (!oyuncu.perAcmisMi && !oyuncu.ciftAcmisMi) { sonuc.puan = 202; sonuc.durum = "Açamadı"; } 
        else { let ceza = 0; oyuncu.el.forEach(t => ceza += t.value); sonuc.puan = ceza; sonuc.durum = "Açtı"; }
        return sonuc;
    });

    let kazananIndex = bitirenIndex;
    
    if (bitirenIndex === -1) {
        let minScore = Math.min(...skorTablosu.map(s => s.puan));
        let kazananlar = skorTablosu.filter(s => s.puan === minScore);
        
        if (minScore === 202 && kazananlar.length === 4) {
            kazananIndex = -1; 
        } else {
            kazananIndex = skorTablosu.findIndex(s => s.puan === minScore);
        }
    }
    io.to(room.id).emit('oyunBitti', { kazanan: kazananIndex, skorlar: skorTablosu, sebep: sebep });
    io.to(room.id).emit('odaGuncellendi', { players: room.players.map(p => p.isim), hostId: room.hostId, status: room.status });
    io.emit('hubGuncelle', getPublicRooms());
}

const PORT = 3000; server.listen(PORT, () => console.log(`Profesyonel 101 HUB Aktif: http://localhost:${PORT}`));