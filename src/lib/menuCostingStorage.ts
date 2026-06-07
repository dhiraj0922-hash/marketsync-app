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

function mapMenuCostingToFrontend(db: any): MenuCosting {
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

function mapMenuCostingComponentToFrontend(db: any): MenuCostingComponent {
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

export async function loadMenuCostings(locationId?: string): Promise<MenuCosting[]> {
  let query = supabase.from('outlet_menu_costings').select('*');
  if (locationId) {
    query = query.eq('location_id', locationId);
  }
  const { data, error } = await query.order('item_name', { ascending: true });
  if (error) {
    console.error('[loadMenuCostings] error:', error);
    return [];
  }
  return (data ?? []).map(mapMenuCostingToFrontend);
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

  const result = mapMenuCostingToFrontend(costing);
  result.components = (comps ?? []).map(mapMenuCostingComponentToFrontend);
  return result;
}

export async function saveMenuCosting(
  costing: Omit<MenuCosting, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  components: Omit<MenuCostingComponent, 'id' | 'costingId' | 'createdAt'>[]
): Promise<{ success: boolean; id?: string; error?: string }> {
  const { data: newCosting, error: err1 } = await supabase
    .from('outlet_menu_costings')
    .insert({
      location_id: costing.locationId,
      item_name: costing.itemName,
      category: costing.category,
      selling_price: costing.sellingPrice,
      target_food_cost_percent: costing.targetFoodCostPercent,
      status: costing.status,
      notes: costing.notes,
    })
    .select('id')
    .single();

  if (err1 || !newCosting) {
    console.error('[saveMenuCosting] parent insert error:', err1);
    return { success: false, error: err1?.message || 'Failed to insert costing parent.' };
  }

  const costingId = newCosting.id;

  if (components.length > 0) {
    const childRows = components.map((c, index) => ({
      costing_id: costingId,
      source_type: c.sourceType,
      source_item_id: c.sourceItemId,
      item_name_snapshot: c.itemNameSnapshot,
      component_type: c.componentType,
      qty_used: c.qtyUsed,
      unit: c.unit,
      unit_cost_snapshot: c.unitCostSnapshot,
      line_cost: c.lineCost,
      sort_order: c.sortOrder || index,
    }));

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
  const { error: err1 } = await supabase
    .from('outlet_menu_costings')
    .update({
      ...costing,
      updated_at: new Date().toISOString(),
    })
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
    const childRows = components.map((c, index) => ({
      costing_id: id,
      source_type: c.sourceType,
      source_item_id: c.sourceItemId,
      item_name_snapshot: c.itemNameSnapshot,
      component_type: c.componentType,
      qty_used: c.qtyUsed,
      unit: c.unit,
      unit_cost_snapshot: c.unitCostSnapshot,
      line_cost: c.lineCost,
      sort_order: c.sortOrder || index,
    }));

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
