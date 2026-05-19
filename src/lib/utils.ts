import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Inventory Identity Utilities ────────────────────────────────────────────
//
// These helpers encapsulate the dual-path inventory item lookup pattern so that
// every caller is consistent regardless of whether `targetId` holds the row PK
// (inventory_items.id) or the shared product identity (inventory_items.item_id).
//
// Both values are TEXT UUIDs in the DB; the only safe way to resolve them is to
// try both paths and prefer the row-PK match (more specific) over item_id.
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryIdentityItem {
  id: string | number;
  itemId?: string | null;
  [key: string]: unknown;
}

/**
 * Find an inventory item by either its row PK (`id`) or shared product identity
 * (`itemId`). Row PK is checked first because it is always unique; `itemId` is
 * the fallback for legacy recipes that stored the shared identity instead.
 *
 * Returns `undefined` (not null) so callers can use the optional-chaining pattern
 * `findInventoryItem(inv, id)?.name` without extra null-checks.
 */
export function findInventoryItem<T extends InventoryIdentityItem>(
  inventory: T[],
  targetId?: string | null
): T | undefined {
  if (targetId == null || targetId === "") return undefined;
  const target = String(targetId);
  return inventory.find(
    (i) =>
      String(i.id) === target ||
      (i.itemId != null && String(i.itemId) !== "" && String(i.itemId) === target)
  );
}

// ─── Dev-mode per-item identity warning ──────────────────────────────────────

/**
 * Emit a console warning in development if an inventory item has a missing or
 * self-assigned itemId. Does nothing in production. Never throws.
 *
 * Call this after loading inventory to surface data quality issues early without
 * blocking any user-facing functionality.
 */
export function warnInventoryIdentity(item: InventoryIdentityItem): void {
  if (process.env.NODE_ENV !== "development") return;
  const id     = String(item.id);
  const itemId = item.itemId != null ? String(item.itemId) : null;

  if (!itemId) {
    console.warn(
      `[Inventory Identity Warning] item.id=${id} has NULL itemId (shared product identity not set). ` +
      `Run the item_id backfill migration before building allocation.`
    );
  } else if (itemId === id) {
    console.warn(
      `[Inventory Identity Warning] item.id=${id} has self-assigned itemId (itemId === id). ` +
      `This row was likely saved before the resolveSharedItemId logic existed. ` +
      `Cross-location lookups may silently fail for this item.`
    );
  }
}

// ─── Bulk audit utility ───────────────────────────────────────────────────────

export interface InventoryIdentityAuditResult {
  nullItemIds:                    InventoryIdentityItem[];
  selfAssignedItemIds:            InventoryIdentityItem[];
  duplicateNamesWithDifferentItemIds: { normalizedName: string; itemIds: string[]; items: InventoryIdentityItem[] }[];
}

/**
 * Static analysis of an in-memory inventory array.
 *
 * Returns three categories of identity problems:
 *   nullItemIds                    — items with itemId = null / undefined / ""
 *   selfAssignedItemIds            — items where itemId === id (legacy self-assignment)
 *   duplicateNamesWithDifferentItemIds — same product name, different shared identities
 *
 * In development, results are automatically printed via console.table.
 * In production, the function is a no-op and returns empty arrays.
 */
export function auditInventoryIdentity(
  inventory: InventoryIdentityItem[]
): InventoryIdentityAuditResult {
  const empty: InventoryIdentityAuditResult = {
    nullItemIds: [],
    selfAssignedItemIds: [],
    duplicateNamesWithDifferentItemIds: [],
  };

  if (process.env.NODE_ENV !== "development") return empty;

  const nullItemIds: InventoryIdentityItem[] = [];
  const selfAssignedItemIds: InventoryIdentityItem[] = [];
  const nameToItemIds = new Map<string, { itemIds: Set<string>; items: InventoryIdentityItem[] }>();

  for (const item of inventory) {
    const id     = String(item.id);
    const itemId = item.itemId != null && item.itemId !== "" ? String(item.itemId) : null;

    if (!itemId) {
      nullItemIds.push(item);
    } else if (itemId === id) {
      selfAssignedItemIds.push(item);
    }

    // Name-based grouping for fragmented identity detection
    const normName = (String((item as any).name ?? "")).trim().toLowerCase();
    if (normName && itemId) {
      if (!nameToItemIds.has(normName)) {
        nameToItemIds.set(normName, { itemIds: new Set(), items: [] });
      }
      const group = nameToItemIds.get(normName)!;
      group.itemIds.add(itemId);
      group.items.push(item);
    }
  }

  const duplicateNamesWithDifferentItemIds = Array.from(nameToItemIds.entries())
    .filter(([, g]) => g.itemIds.size > 1)
    .map(([normalizedName, g]) => ({
      normalizedName,
      itemIds: Array.from(g.itemIds),
      items: g.items,
    }));

  // ── Console output ──────────────────────────────────────────────────────────
  console.group("[auditInventoryIdentity] Results");

  if (nullItemIds.length > 0) {
    console.warn(`${nullItemIds.length} item(s) with NULL itemId:`);
    console.table(nullItemIds.map((i) => ({ id: i.id, name: (i as any).name, locationId: (i as any).locationId })));
  } else {
    console.log("✅ No NULL itemId values found.");
  }

  if (selfAssignedItemIds.length > 0) {
    console.warn(`${selfAssignedItemIds.length} item(s) with self-assigned itemId (itemId === id):`);
    console.table(selfAssignedItemIds.map((i) => ({ id: i.id, itemId: i.itemId, name: (i as any).name, locationId: (i as any).locationId })));
  } else {
    console.log("✅ No self-assigned itemId values found.");
  }

  if (duplicateNamesWithDifferentItemIds.length > 0) {
    console.warn(`${duplicateNamesWithDifferentItemIds.length} product name(s) with multiple different itemIds (fragmented identity):`);
    console.table(duplicateNamesWithDifferentItemIds.map((g) => ({
      name: g.normalizedName,
      distinctItemIds: g.itemIds.length,
      itemIds: g.itemIds.join(" | "),
    })));
  } else {
    console.log("✅ No duplicate names with different itemIds found.");
  }

  console.groupEnd();

  return { nullItemIds, selfAssignedItemIds, duplicateNamesWithDifferentItemIds };
}
