// Pure interpretation of what the guest typed or tapped. Kept free of any
// database or model dependency so the rules stay cheap and testable.

const WORD_NUMBERS: Record<string, number> = {
    'одну': 1, 'один': 1, 'одна': 1, 'одне': 1,
    'дві': 2, 'два': 2, 'двi': 2,
    'три': 3, 'чотири': 4, 'п\'ять': 5, 'пять': 5, 'шість': 6, 'сім': 7,
};

/** "2", "2 шт", "1,5 кг", "дві" — the cheap cases handled without an LLM call. */
export function quantityFromAnswer(answer: string): { quantity: number; unit: string } | null {
    const normalized = answer.toLocaleLowerCase('uk-UA').trim().replace(',', '.');

    const direct = normalized.match(/^(\d+(?:\.\d+)?)\s*(шт|кг|г|л|мл|пач|упак|пляш)?\.?$/);
    if (direct) {
        const quantity = Number(direct[1]);
        if (Number.isFinite(quantity) && quantity > 0 && quantity <= 99) {
            return { quantity, unit: direct[2] || '' };
        }
    }

    const word = WORD_NUMBERS[normalized];
    return word ? { quantity: word, unit: '' } : null;
}

export function isAffirmative(answer: string): boolean {
    return /^(так|ага|угу|вірно|правильно|саме так|yes|y|\+|✅)\.?$/i.test(answer.trim());
}

export function isNegative(answer: string): boolean {
    return /^(ні|нє|не|no|n|-)\.?$/i.test(answer.trim());
}

export function isRefusal(answer: string): boolean {
    return /^(не треба|не потрібно|прибери|видали|пропусти|скасуй)\.?$/i
        .test(answer.trim().toLocaleLowerCase('uk-UA'));
}

export function itemLabel(item: { query: string; note: string }): string {
    return [item.query, item.note].filter(Boolean).join(', ');
}
