class Okey101 {
    constructor() {
        this.colors = ['sari', 'kirmizi', 'siyah', 'mavi'];
        this.deck = [];
        this.players = { player1: [], player2: [], player3: [], player4: [] };
        this.gosterge = null;
        this.okey = { color: null, value: null };
        this.initGame();
    }

    createDeck() {
        let idCounter = 1;
        for (let i = 0; i < 2; i++) {
            for (let color of this.colors) {
                for (let value = 1; value <= 13; value++) {
                    this.deck.push({ id: idCounter++, color: color, value: value });
                }
            }
        }
        this.deck.push({ id: idCounter++, color: 'sahte', value: 0 });
        this.deck.push({ id: idCounter++, color: 'sahte', value: 0 });
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    determineOkey() {
        let randomIndex;
        do { randomIndex = Math.floor(Math.random() * this.deck.length); } while (this.deck[randomIndex].color === 'sahte');
        this.gosterge = this.deck.splice(randomIndex, 1)[0];
        this.okey.color = this.gosterge.color;
        this.okey.value = this.gosterge.value === 13 ? 1 : this.gosterge.value + 1;
    }

    // YENİ: 22 / 21 Kuralı
    dealTiles() {
        for (let i = 0; i < 22; i++) this.players.player1.push(this.deck.pop());
        for (let i = 0; i < 21; i++) this.players.player2.push(this.deck.pop());
        for (let i = 0; i < 21; i++) this.players.player3.push(this.deck.pop());
        for (let i = 0; i < 21; i++) this.players.player4.push(this.deck.pop());
    }

    initGame() {
        this.createDeck(); this.shuffleDeck(); this.determineOkey(); this.dealTiles();
    }
}
module.exports = Okey101;