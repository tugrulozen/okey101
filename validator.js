class Validator {
    static isSahteOkey(tile) { return tile.color === 'sahte'; }

    // DÜZELTME: Taşın efektifi alınsa bile Sahte Okey ise joker yetkisi verilmez!
    static isOkey(tile, gameOkey) { 
        if (!tile || !gameOkey) return false;
        return tile.color === gameOkey.color && tile.value === gameOkey.value && tile.color !== 'sahte' && !tile.isSahte; 
    }

    static getEffectiveTile(tile, gameOkey) {
        if (this.isSahteOkey(tile)) return { id: tile.id, color: gameOkey.color, value: gameOkey.value, isSahte: true };
        return tile;
    }

    static isPairValid(group, gameOkey) {
        if (group.length !== 2) return false;
        let t1 = this.getEffectiveTile(group[0], gameOkey), t2 = this.getEffectiveTile(group[1], gameOkey);
        let okeyCount = (this.isOkey(t1, gameOkey) ? 1 : 0) + (this.isOkey(t2, gameOkey) ? 1 : 0);
        if (okeyCount > 0) return true;
        return t1.color === t2.color && t1.value === t2.value;
    }

    static isSetValid(group, gameOkey) {
        if (group.length < 3 || group.length > 4) return false;
        let effTiles = group.map(t => this.getEffectiveTile(t, gameOkey));
        let normalTiles = effTiles.filter(t => !this.isOkey(t, gameOkey));
        
        if (normalTiles.length === 0) return true;
        const targetValue = normalTiles[0].value;
        const colors = new Set();
        
        for (let tile of normalTiles) {
            if (tile.value !== targetValue) return false;
            if (colors.has(tile.color)) return false; 
            colors.add(tile.color);
        }
        return true;
    }

    static isRunValid(group, gameOkey) {
        if (group.length < 3 || group.length > 13) return false;
        let effTiles = group.map(t => this.getEffectiveTile(t, gameOkey));
        let normalTiles = effTiles.filter(t => !this.isOkey(t, gameOkey));
        
        if (normalTiles.length === 0) return true;
        const targetColor = normalTiles[0].color;
        if (normalTiles.some(t => t.color !== targetColor)) return false;

        let values = normalTiles.map(t => t.value).sort((a, b) => a - b);
        let okeyCount = group.length - normalTiles.length;

        let needed = 0;
        for (let i = 0; i < values.length - 1; i++) {
            let gap = values[i+1] - values[i] - 1;
            if (gap < 0) return false; 
            needed += gap;
        }
        
        return needed <= okeyCount;
    }

    static isGroupValid(group, gameOkey) { return this.isSetValid(group, gameOkey) || this.isRunValid(group, gameOkey); }

    static calculate101Score(groups, gameOkey) {
        let totalScore = 0;
        for (let group of groups) {
            if (!this.isGroupValid(group, gameOkey)) return { success: false, message: "Geçersiz dizilim!" };
            let effTiles = group.map(t => this.getEffectiveTile(t, gameOkey));
            let normalTiles = effTiles.filter(t => !this.isOkey(t, gameOkey));
            if (normalTiles.length === 0) continue; 

            let isSet = normalTiles.every(t => t.value === normalTiles[0].value);
            if (isSet) {
                totalScore += normalTiles[0].value * group.length;
            } else {
                let sortedNormals = [...normalTiles].sort((a,b) => a.value - b.value);
                let startVal = sortedNormals[0].value;
                let expectedVal = startVal;
                let okeysCount = group.length - normalTiles.length;
                let resultVals = [];

                for (let i = 0; i < sortedNormals.length; i++) {
                    let currentVal = sortedNormals[i].value;
                    while (expectedVal < currentVal && okeysCount > 0) {
                        resultVals.push(expectedVal); expectedVal++; okeysCount--;
                    }
                    resultVals.push(currentVal); expectedVal++;
                }
                while (okeysCount > 0) {
                    if (expectedVal > 13) { startVal--; resultVals.unshift(startVal); } 
                    else { resultVals.push(expectedVal); expectedVal++; }
                    okeysCount--;
                }
                totalScore += resultVals.reduce((a, b) => a + b, 0);
            }
        }
        return totalScore >= 101 ? { success: true, score: totalScore } : { success: false, message: `Yetersiz Puan: ${totalScore}/101` };
    }

    static calculatePairs(groups, gameOkey) {
        if (groups.length < 5) return { success: false, message: `En az 5 çift açmalısınız!` };
        for (let group of groups) {
            if (!this.isPairValid(group, gameOkey)) return { success: false, message: "Geçersiz çift!" };
        }
        return { success: true };
    }

    static sortGroup(group, gameOkey) {
        if (group.length === 0) return group;
        let effTiles = group.map(t => this.getEffectiveTile(t, gameOkey));
        let normalTiles = effTiles.filter(t => !this.isOkey(t, gameOkey));
        let rawNormalTiles = group.filter(t => !this.isOkey(this.getEffectiveTile(t, gameOkey), gameOkey));

        if (normalTiles.length === 0) return group;
        let isSet = normalTiles.every(t => t.value === normalTiles[0].value);
        if (isSet) {
            return [...group].sort((a, b) => {
                let cA = this.isOkey(this.getEffectiveTile(a, gameOkey), gameOkey) ? 'zz' : a.color;
                let cB = this.isOkey(this.getEffectiveTile(b, gameOkey), gameOkey) ? 'zz' : b.color;
                return cA.localeCompare(cB);
            });
        }

        let sortedRawNormals = [...rawNormalTiles].sort((a, b) => this.getEffectiveTile(a, gameOkey).value - this.getEffectiveTile(b, gameOkey).value);
        let okeys = group.filter(t => this.isOkey(this.getEffectiveTile(t, gameOkey), gameOkey));

        let result = []; let expectedVal = this.getEffectiveTile(sortedRawNormals[0], gameOkey).value;
        for (let i = 0; i < sortedRawNormals.length; i++) {
            let currentVal = this.getEffectiveTile(sortedRawNormals[i], gameOkey).value;
            while (expectedVal < currentVal && okeys.length > 0) { result.push(okeys.pop()); expectedVal++; }
            result.push(sortedRawNormals[i]); expectedVal++;
        }
        
        while (okeys.length > 0) {
            if (expectedVal > 13) { result.unshift(okeys.pop()); } 
            else { result.push(okeys.pop()); expectedVal++; }
        }
        return result;
    }
}
module.exports = Validator;