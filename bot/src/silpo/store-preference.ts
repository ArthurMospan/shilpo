import db from '../db/index';
import type { StorePreference } from './store';

// Where the guest chose to shop, remembered per guest rather than per list.
// A guest who switched to "delivery to the office" means it for the next list
// too, and re-asking on every photo would be the kind of question this bot
// exists to avoid.

export async function getStorePreference(tgId: number): Promise<StorePreference | null> {
    const row = await db.prepare(
        'SELECT store_branch_id, store_delivery_type, store_label FROM users WHERE tg_id = ?'
    ).get(tgId);
    const branchId = String(row?.store_branch_id || '');
    if (!branchId) return null;
    return {
        branchId,
        deliveryType: String(row?.store_delivery_type || 'DeliveryHome'),
        label: String(row?.store_label || ''),
    };
}

/** Passing null hands the guest back to whatever their Silpo cart uses. */
export async function setStorePreference(tgId: number, preference: StorePreference | null): Promise<void> {
    await db.prepare(`
        UPDATE users SET store_branch_id = ?, store_delivery_type = ?, store_label = ? WHERE tg_id = ?
    `).run(
        preference?.branchId || null,
        preference?.deliveryType || null,
        preference?.label || null,
        tgId
    );
}
