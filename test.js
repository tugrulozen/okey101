const Okey101 = require('./game');
const Validator = require('./validator');

// Oyunun Okey'i Siyah 5 olsun
const gameOkey = { color: 'siyah', value: 5 };

console.log("--- 1. TEST: Okey ile Seri ---");
// Kırmızı 3, Kırmızı 4, Siyah 5 (Okey - Kırmızı 5 yerine geçiyor)
const seriGrup = [
    { id: 1, color: 'kirmizi', value: 3 },
    { id: 2, color: 'kirmizi', value: 4 },
    { id: 3, color: 'siyah', value: 5 } // Okey
];
console.log("Seri geçerli mi?:", Validator.isRunValid(seriGrup, gameOkey)); // true dönmeli

console.log("\n--- 2. TEST: 12-13-1 Kuralı ---");
// Sarı 12, Sarı 13, Sarı 1
const seri13 = [
    { id: 4, color: 'sari', value: 12 },
    { id: 5, color: 'sari', value: 13 },
    { id: 6, color: 'sari', value: 1 } 
];
console.log("12-13-1 Geçerli mi?:", Validator.isRunValid(seri13, gameOkey)); // true dönmeli

console.log("\n--- 3. TEST: Çift Açma ---");
const ciftler = [
    [{ color: 'mavi', value: 8 }, { color: 'mavi', value: 8 }],
    [{ color: 'sari', value: 2 }, { color: 'sari', value: 2 }],
    [{ color: 'kirmizi', value: 10 }, { color: 'siyah', value: 5 }], // Biri Okey, geçerli çift
    [{ color: 'siyah', value: 11 }, { color: 'siyah', value: 11 }],
    [{ color: 'mavi', value: 1 }, { color: 'mavi', value: 1 }]
];
console.log("Çifte gidilebilir mi?:", Validator.calculatePairs(ciftler, gameOkey)); // success: true dönmeli