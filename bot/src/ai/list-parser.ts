import { generate, parseJsonAnswer } from './gemini';

export interface ParsedItem {
    /** The line exactly as the guest wrote it. */
    raw: string;
    /** Normalized catalogue query: singular, no quantity, 1–4 words. */
    query: string;
    /** null when the list did not say how much. */
    quantity: number | null;
    unit: string;
    /** Qualifiers that matter when picking: "2,5%", "без цукру", a brand. */
    note: string;
    /** Handwriting the model could not read with confidence. */
    uncertainReading: boolean;
    /** A question worth asking before searching, or an empty string. */
    question: string;
    /** Tappable answers for `question`. */
    options: string[];
}

const ITEM_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            raw: { type: 'STRING' },
            query: { type: 'STRING' },
            quantity: { type: 'NUMBER', nullable: true },
            unit: { type: 'STRING' },
            note: { type: 'STRING' },
            uncertainReading: { type: 'BOOLEAN' },
            question: { type: 'STRING' },
            options: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['raw', 'query', 'quantity', 'unit', 'note', 'uncertainReading', 'question', 'options'],
    },
} as const;

const SYSTEM_INSTRUCTION = `Ти — асистент українського супермаркету «Сільпо». Розбираєш списки покупок і повертаєш строгий JSON.

ЗАВДАННЯ
Перетвори список покупок (рукописне фото, скріншот або текст) на масив позицій.

ПРАВИЛА
1. Одна позиція = один товар. Рядок «молоко, хліб, яйця» — це ТРИ позиції.
2. "raw" — рядок точно як його написав гість, без виправлень.
3. "query" — короткий пошуковий запит українською для каталогу супермаркету: називний відмінок однини, без кількості й без відсотків. Приклади: «сир твердий», «молоко», «олія соняшникова», «пральний порошок». Скорочення та сленг розшифровуй: «мін вода» → «вода мінеральна», «майонез» → «майонез», «тп» → «туалетний папір».
4. "quantity" — число, якщо кількість написана. Якщо кількості немає — рівно null. Не вигадуй 1.
5. "unit" — одне з: "шт", "кг", "г", "л", "мл", "пач", "упак", "пляш". Порожній рядок, якщо не зрозуміло.
6. "note" — уточнення, що впливають на вибір: жирність, смак, бренд, «без цукру», «безлактозне». Інакше порожній рядок.
7. "uncertainReading" — true, якщо почерк нерозбірливий і ти вгадуєш слово.
8. "question" — постав питання, ТІЛЬКИ якщо без відповіді неможливо обрати правильний товар:
   • нерозбірливий почерк → «Тут написано "сир"?»
   • кількість не вказана для товару, де це важливо → «Скільки молока брати?»
   • назва надто загальна і варіанти суттєво різні → «Яку каву — зернову, мелену чи розчинну?»
   Якщо питання не потрібне — порожній рядок. НЕ питай про очевидне. Максимум одне питання на позицію.
9. "options" — 2–4 короткі варіанти відповіді (до 20 символів). Для кількості: «1», «2», «3». Порожній масив, якщо питання немає.
10. Ігноруй заголовки («Список», «Купити»), закреслені рядки, дати й підсумки.
11. Нічого не додавай від себе: у відповіді лише те, що є у списку.

Відповідай лише JSON-масивом.`;

function sanitizeItem(value: any): ParsedItem | null {
    const raw = String(value?.raw ?? '').trim();
    const query = String(value?.query ?? '').trim();
    if (!query) return null;

    const quantity = Number(value?.quantity);
    const options = Array.isArray(value?.options)
        ? value.options.map((option: any) => String(option).trim()).filter(Boolean).slice(0, 4)
        : [];
    const question = String(value?.question ?? '').trim();

    return {
        raw: raw || query,
        query: query.slice(0, 120),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        unit: String(value?.unit ?? '').trim().slice(0, 12),
        note: String(value?.note ?? '').trim().slice(0, 120),
        uncertainReading: Boolean(value?.uncertainReading),
        question: question.slice(0, 200),
        // A question the guest cannot answer with a tap is worse than no
        // question, so an option-less question is dropped unless it is a
        // yes/no reading check.
        options: options.length ? options : (question ? ['Так', 'Ні'] : []),
    };
}

function dedupeItems(items: ParsedItem[]): ParsedItem[] {
    const seen = new Map<string, ParsedItem>();
    for (const item of items) {
        const key = `${item.query.toLocaleLowerCase('uk-UA')}|${item.note.toLocaleLowerCase('uk-UA')}`;
        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, item);
            continue;
        }
        // The same product written twice means the guest wants more of it.
        if (existing.quantity !== null && item.quantity !== null) existing.quantity += item.quantity;
        else if (item.quantity !== null) existing.quantity = item.quantity;
    }
    return [...seen.values()];
}

export async function parseListFromText(text: string): Promise<ParsedItem[]> {
    const answer = await generate({
        systemInstruction: SYSTEM_INSTRUCTION,
        schema: ITEM_SCHEMA as any,
        parts: [{ text: `Список покупок:\n\n${text}` }],
    });
    const parsed = parseJsonAnswer<any[]>(answer);
    if (!Array.isArray(parsed)) return [];
    return dedupeItems(parsed.map(sanitizeItem).filter(Boolean) as ParsedItem[]).slice(0, 40);
}

export async function parseListFromImage(imageBase64: string, mimeType: string): Promise<ParsedItem[]> {
    const answer = await generate({
        systemInstruction: SYSTEM_INSTRUCTION,
        schema: ITEM_SCHEMA as any,
        parts: [
            { text: 'Розбери цей список покупок із фотографії. Читай уважно, включно з рукописним текстом.' },
            { inlineData: { mimeType, data: imageBase64 } },
        ],
    });
    const parsed = parseJsonAnswer<any[]>(answer);
    if (!Array.isArray(parsed)) return [];
    return dedupeItems(parsed.map(sanitizeItem).filter(Boolean) as ParsedItem[]).slice(0, 40);
}

export interface RefinedItem {
    query: string;
    quantity: number | null;
    unit: string;
    note: string;
    /** The guest said this line is not a product they want. */
    drop: boolean;
}

const REFINE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        query: { type: 'STRING' },
        quantity: { type: 'NUMBER', nullable: true },
        unit: { type: 'STRING' },
        note: { type: 'STRING' },
        drop: { type: 'BOOLEAN' },
    },
    required: ['query', 'quantity', 'unit', 'note', 'drop'],
} as const;

/**
 * Folds the guest's answer back into a list item. Handles taps on suggested
 * options and free-form replies alike ("та ні, візьми безлактозне, дві штуки").
 */
export async function refineItemWithAnswer(
    item: { query: string; quantity: number | null; unit: string; note: string },
    question: string,
    answer: string
): Promise<RefinedItem> {
    const response = await generate({
        systemInstruction: `Ти уточнюєш позицію списку покупок для супермаркету «Сільпо».
Онови поля відповідно до відповіді гостя й поверни лише JSON.
"query" — короткий пошуковий запит українською, називний відмінок однини, без кількості.
"quantity" — число або null, якщо гість так і не сказав кількість.
"note" — уточнення, що впливають на вибір (жирність, смак, бренд).
"drop" — true, лише якщо гість відмовився від цієї позиції («не треба», «прибери», «ні, цього немає в списку»).
Не втрачай уточнень, які вже були.`,
        schema: REFINE_SCHEMA as any,
        temperature: 0.1,
        parts: [{
            text: `Поточна позиція: ${JSON.stringify(item)}
Питання: ${question}
Відповідь гостя: ${answer}`,
        }],
    });

    const parsed = parseJsonAnswer<any>(response);
    const quantity = Number(parsed?.quantity);
    return {
        query: String(parsed?.query || item.query).trim() || item.query,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        unit: String(parsed?.unit ?? item.unit).trim().slice(0, 12),
        note: String(parsed?.note ?? item.note).trim().slice(0, 120),
        drop: Boolean(parsed?.drop),
    };
}
