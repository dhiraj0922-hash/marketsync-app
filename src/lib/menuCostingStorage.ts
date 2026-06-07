import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// MENU COSTING TYPES & HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuCosting {
  id: string;
  locationId: string;
  itemName: string;
  category: string | null;
  sellingPrice: number;
  targetFoodCostPercent: number;
  status: 'draft' | 'active';
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  components?: MenuCostingComponent[];
}

export interface MenuCostingComponent {
  id: string;
  costingId: string;
  sourceType: 'finished_good' | 'inventory_item';
  sourceItemId: string;
  itemNameSnapshot: string | null;
  componentType: 'main' | 'packaging' | 'garnish' | 'finishing' | 'other';
  qtyUsed: number;
  unit: string | null;
  unitCostSnapshot: number;
  lineCost: number;
  sortOrder: number;
  createdAt: string | null;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

export function fromDbMenuCosting(db: any): MenuCosting {
  return {
    id: db.id,
    locationId: db.location_id,
    itemName: db.item_name,
    category: db.category ?? null,
    sellingPrice: parseFloat(db.selling_price) || 0,
    targetFoodCostPercent: parseFloat(db.target_food_cost_percent) || 30,
    status: db.status || 'draft',
    notes: db.notes ?? null,
    createdAt: db.created_at ?? null,
    updatedAt: db.updated_at ?? null,
    createdBy: db.created_by ?? null,
  };
}

export function toDbMenuCosting(fe: Partial<MenuCosting>): any {
  const db: any = {};
  if (fe.id !== undefined) db.id = fe.id;
  if (fe.locationId !== undefined) db.location_id = fe.locationId;
  if (fe.itemName !== undefined) db.item_name = fe.itemName;
  if (fe.category !== undefined) db.category = fe.category;
  if (fe.sellingPrice !== undefined) db.selling_price = fe.sellingPrice;
  if (fe.targetFoodCostPercent !== undefined) db.target_food_cost_percent = fe.targetFoodCostPercent;
  if (fe.status !== undefined) db.status = fe.status;
  if (fe.notes !== undefined) db.notes = fe.notes;
  if (fe.createdAt !== undefined) db.created_at = fe.createdAt;
  if (fe.updatedAt !== undefined) db.updated_at = fe.updatedAt;
  if (fe.createdBy !== undefined) db.created_by = fe.createdBy;
  return db;
}

export function fromDbMenuCostingComponent(db: any): MenuCostingComponent {
  return {
    id: db.id,
    costingId: db.costing_id,
    sourceType: db.source_type,
    sourceItemId: db.source_item_id,
    itemNameSnapshot: db.item_name_snapshot ?? null,
    componentType: db.component_type || 'main',
    qtyUsed: parseFloat(db.qty_used) || 0,
    unit: db.unit ?? null,
    unitCostSnapshot: parseFloat(db.unit_cost_snapshot) || 0,
    lineCost: parseFloat(db.line_cost) || 0,
    sortOrder: parseInt(db.sort_order) || 0,
    createdAt: db.created_at ?? null,
  };
}

export function toDbMenuCostingComponent(fe: Partial<MenuCostingComponent>): any {
  const db: any = {};
  if (fe.id !== undefined) db.id = fe.id;
  if (fe.costingId !== undefined) db.costing_id = fe.costingId;
  if (fe.sourceType !== undefined) db.source_type = fe.sourceType;
  if (fe.sourceItemId !== undefined) db.source_item_id = fe.sourceItemId;
  if (fe.itemNameSnapshot !== undefined) db.item_name_snapshot = fe.itemNameSnapshot;
  if (fe.componentType !== undefined) db.component_type = fe.componentType;
  if (fe.qtyUsed !== undefined) db.qty_used = fe.qtyUsed;
  if (fe.unit !== undefined) db.unit = fe.unit;
  if (fe.unitCostSnapshot !== undefined) db.unit_cost_snapshot = fe.unitCostSnapshot;
  if (fe.lineCost !== undefined) db.line_cost = fe.lineCost;
  if (fe.sortOrder !== undefined) db.sort_order = fe.sortOrder;
  if (fe.createdAt !== undefined) db.created_at = fe.createdAt;
  return db;
}

// ── Database Queries ─────────────────────────────────────────────────────────

export async function loadMenuCostings(locationId?: string): Promise<MenuCosting[]> {
  let query = supabase.from('outlet_menu_costings').select(`
    *,
    components:outlet_menu_costing_components(*)
  `);
  if (locationId) {
    query = query.eq('location_id', locationId);
  }
  const { data, error } = await query.order('item_name', { ascending: true });
  if (error) {
    console.error('[loadMenuCostings] error:', error);
    return [];
  }
  return (data ?? []).map(row => {
    const costing = fromDbMenuCosting(row);
    costing.components = (row.components ?? []).map(fromDbMenuCostingComponent);
    return costing;
  });
}

export async function loadMenuCostingById(id: string): Promise<MenuCosting | null> {
  const { data: costing, error: err1 } = await supabase
    .from('outlet_menu_costings')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (err1 || !costing) {
    console.error('[loadMenuCostingById] error fetching costing:', err1);
    return null;
  }

  const { data: comps, error: err2 } = await supabase
    .from('outlet_menu_costing_components')
    .select('*')
    .eq('costing_id', id)
    .order('sort_order', { ascending: true });

  if (err2) {
    console.error('[loadMenuCostingById] error fetching components:', err2);
  }

  const result = fromDbMenuCosting(costing);
  result.components = (comps ?? []).map(fromDbMenuCostingComponent);
  return result;
}

export async function saveMenuCosting(
  costing: Omit<MenuCosting, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  components: Omit<MenuCostingComponent, 'id' | 'costingId' | 'createdAt'>[]
): Promise<{ success: boolean; id?: string; error?: string }> {
  const dbCosting = toDbMenuCosting(costing);
  
  const { data: newCosting, error: err1 } = await supabase
    .from('outlet_menu_costings')
    .insert(dbCosting)
    .select('id')
    .single();

  if (err1 || !newCosting) {
    console.error('[saveMenuCosting] parent insert error:', err1);
    return { success: false, error: err1?.message || 'Failed to insert costing parent.' };
  }

  const costingId = newCosting.id;

  if (components.length > 0) {
    const childRows = components.map((c, index) => {
      const dbComp = toDbMenuCostingComponent(c);
      dbComp.costing_id = costingId;
      if (dbComp.sort_order === undefined) {
        dbComp.sort_order = index;
      }
      return dbComp;
    });

    const { error: err2 } = await supabase
      .from('outlet_menu_costing_components')
      .insert(childRows);

    if (err2) {
      console.error('[saveMenuCosting] components insert error:', err2);
      await supabase.from('outlet_menu_costings').delete().eq('id', costingId);
      return { success: false, error: err2.message };
    }
  }

  return { success: true, id: costingId };
}

export async function updateMenuCosting(
  id: string,
  costing: Partial<Omit<MenuCosting, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>>,
  components: Omit<MenuCostingComponent, 'id' | 'costingId' | 'createdAt'>[]
): Promise<{ success: boolean; error?: string }> {
  const dbCosting = toDbMenuCosting(costing);
  dbCosting.updated_at = new Date().toISOString();

  const { error: err1 } = await supabase
    .from('outlet_menu_costings')
    .update(dbCosting)
    .eq('id', id);

  if (err1) {
    console.error('[updateMenuCosting] parent update error:', err1);
    return { success: false, error: err1.message };
  }

  const { error: err2 } = await supabase
    .from('outlet_menu_costing_components')
    .delete()
    .eq('costing_id', id);

  if (err2) {
    console.error('[updateMenuCosting] components delete error:', err2);
    return { success: false, error: err2.message };
  }

  if (components.length > 0) {
    const childRows = components.map((c, index) => {
      const dbComp = toDbMenuCostingComponent(c);
      dbComp.costing_id = id;
      if (dbComp.sort_order === undefined) {
        dbComp.sort_order = index;
      }
      return dbComp;
    });

    const { error: err3 } = await supabase
      .from('outlet_menu_costing_components')
      .insert(childRows);

    if (err3) {
      console.error('[updateMenuCosting] components insert error:', err3);
      return { success: false, error: err3.message };
    }
  }

  return { success: true };
}

export async function deleteMenuCosting(id: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('outlet_menu_costings')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[deleteMenuCosting] error:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function duplicateMenuCosting(
  id: string,
  newName: string
): Promise<{ success: boolean; newId?: string; error?: string }> {
  const original = await loadMenuCostingById(id);
  if (!original) {
    return { success: false, error: 'Original costing sheet not found.' };
  }

  const costingData = {
    locationId: original.locationId,
    itemName: newName,
    category: original.category,
    sellingPrice: original.sellingPrice,
    targetFoodCostPercent: original.targetFoodCostPercent,
    status: 'draft' as const,
    notes: original.notes,
  };

  const compsData = (original.components ?? []).map(c => ({
    sourceType: c.sourceType,
    sourceItemId: c.sourceItemId,
    itemNameSnapshot: c.itemNameSnapshot,
    componentType: c.componentType,
    qtyUsed: c.qtyUsed,
    unit: c.unit,
    unitCostSnapshot: c.unitCostSnapshot,
    lineCost: c.lineCost,
    sortOrder: c.sortOrder,
  }));

  return saveMenuCosting(costingData, compsData);
}
