import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const LONDON_TEMPLATE_LOCATION_ID = "LOC-1091";
const CHUNK_INVENTORY_ROWS = 50;
const CHUNK_PURCHASE_OPTIONS = 100;

type CopyResult = {
  created: number;
  updated: number;
  skipped: number;
  purchaseOptionsCopied: number;
  failed: number;
  errors: string[];
  insertedRows: any[];
  updatedRows: any[];
};

const emptyResult = (): CopyResult => ({
  created: 0,
  updated: 0,
  skipped: 0,
  purchaseOptionsCopied: 0,
  failed: 0,
  errors: [],
  insertedRows: [],
  updatedRows: [],
});

const jsonError = (error: string, status = 400, data?: Partial<CopyResult>) =>
  NextResponse.json({ success: false, error, data }, { status });

const norm = (value: any) =>
  String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const inventoryDuplicateKey = (row: any) => [
  norm(row.name),
  norm(row.baseunit ?? row.baseUnit ?? row.unit),
  norm(row.supplierid ?? row.supplierId ?? ""),
].join("|");

const purchaseOptionDuplicateKey = (row: any) => [
  norm(row.supplier_name ?? row.supplierName),
  norm(row.purchase_uom ?? row.purchaseUom),
  norm(row.pack_qty ?? row.packQty ?? ""),
  norm(row.unit_price ?? row.unitPrice ?? 0),
].join("|");

const isValidTargetLocation = (loc: any) => {
  const id = String(loc?.id ?? "").trim();
  const name = String(loc?.name ?? "").trim();
  const status = String(loc?.status ?? "").trim().toLowerCase();
  return Boolean(
    id &&
    name &&
    id !== LONDON_TEMPLATE_LOCATION_ID &&
    id !== "LOC-HQ" &&
    id !== "LOC-NULL" &&
    name.toLowerCase() !== "null" &&
    !["inactive", "disabled", "archived", "closed"].includes(status)
  );
};

const mapInventoryToFrontend = (db: any) => ({
  id: db.id,
  itemId: db.item_id ?? db.id,
  locationId: db.location_id,
  name: db.name,
  category: db.category,
  itemType: db.itemtype,
  baseUnit: db.baseunit,
  unit: db.unit,
  inStock: db.instock,
  parLevel: db.parlevel,
  cost: db.cost,
  purchaseCost: db.purchasecost ?? null,
  supplierId: db.supplierid,
  priceTrend: db.pricetrend,
  priceIncrease: db.priceincrease,
  purchaseUnits: db.purchaseunits || [],
  purchaseUom: db.purchase_uom ?? null,
  packQty: db.pack_qty != null ? Number(db.pack_qty) : null,
  innerUnitType: db.inner_unit_type ?? null,
  innerUnitSize: db.inner_unit_size != null ? Number(db.inner_unit_size) : null,
  innerUnitUom: db.inner_unit_uom ?? null,
  baseUomNew: db.base_uom ?? null,
  allowedRecipeUoms: Array.isArray(db.allowed_recipe_uoms) ? db.allowed_recipe_uoms : null,
  linkedRecipeId: db.linked_recipe_id ?? null,
});

const chunkArray = <T,>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    return jsonError("Supabase server environment variables are not configured.", 500);
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) return jsonError("Missing auth token.", 401);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser(token);
  if (userError || !user) return jsonError("Invalid auth token.", 401);

  const { data: profile, error: profileError } = await adminClient
    .from("user_profiles")
    .select("user_id, role, location_id, is_active")
    .eq("user_id", user.id)
    .single();

  if (profileError || !profile?.is_active) return jsonError("Active user profile not found.", 403);

  const role = String(profile.role ?? "").trim().toLowerCase();
  const locationId = String(profile.location_id ?? "").trim();
  const body = await req.json().catch(() => ({}));
  const sourceLocationId = String(body.sourceLocationId ?? "").trim();

  if (sourceLocationId !== LONDON_TEMPLATE_LOCATION_ID) {
    return jsonError(`This copy workflow only supports London / ${LONDON_TEMPLATE_LOCATION_ID} as the source location.`, 403);
  }

  const authorized =
    (role === "hq_admin" && sourceLocationId === LONDON_TEMPLATE_LOCATION_ID) ||
    ((role === "location_manager" || role === "location manager") && locationId === LONDON_TEMPLATE_LOCATION_ID);
  if (!authorized) {
    return jsonError("Only HQ admins or London / LOC-1091 location managers can copy London template inventory.", 403);
  }

  const selectedItemIds = Array.from(new Set((body.selectedItemIds ?? body.sourceRowIds ?? []).map(String).filter(Boolean)));
  const requestedTargetIds = Array.from(new Set((body.targetLocationIds ?? []).map(String).filter(Boolean)));
  const copyPar = body.copyPar !== false;
  const copySupplierSettings = body.copySupplierSettings !== false;
  const copyPurchaseOptions = body.copyPurchaseOptions !== false;
  const copyStock = body.copyStock === true;
  const updateExistingSetupFields = body.updateExistingSetupFields === true;

  if (selectedItemIds.length === 0) return jsonError("selectedItemIds is required.");
  if (requestedTargetIds.length === 0) return jsonError("targetLocationIds is required.");

  const result = emptyResult();

  const { data: locations, error: locationsError } = await adminClient
    .from("locations")
    .select("id, name, status");
  if (locationsError) return jsonError(`Location validation failed: ${locationsError.message}`, 500);

  const validTargetIds = new Set((locations ?? []).filter(isValidTargetLocation).map((loc: any) => String(loc.id)));
  const targetLocationIds = (requestedTargetIds as string[]).filter((id) => validTargetIds.has(id));
  if (targetLocationIds.length === 0) return jsonError("No valid target locations selected.");

  const { data: sourceRows, error: sourceError } = await adminClient
    .from("inventory_items")
    .select("*")
    .eq("location_id", LONDON_TEMPLATE_LOCATION_ID)
    .in("id", selectedItemIds);
  if (sourceError) return jsonError(`Source fetch error: ${sourceError.message}`, 500);

  const sourceById = new Map((sourceRows ?? []).map((row: any) => [String(row.id), row]));
  const sources = (selectedItemIds as string[]).map((id) => sourceById.get(id)).filter(Boolean);
  for (const id of selectedItemIds as string[]) {
    if (!sourceById.has(id)) {
      result.failed += targetLocationIds.length;
      result.errors.push(`${id}: source row not found in London / ${LONDON_TEMPLATE_LOCATION_ID}`);
    }
  }
  if (sources.length === 0) {
    return NextResponse.json({ success: true, data: result });
  }

  const { data: targetRows, error: targetError } = await adminClient
    .from("inventory_items")
    .select("*")
    .in("location_id", targetLocationIds);
  if (targetError) return jsonError(`Target fetch error: ${targetError.message}`, 500);

  const existingByLocationAndItemId = new Map<string, any>();
  const existingByLocationAndFallback = new Map<string, any>();
  for (const row of targetRows ?? []) {
    const targetLoc = String(row.location_id ?? "");
    const targetItem = String(row.item_id ?? row.id ?? "");
    if (targetLoc && targetItem) existingByLocationAndItemId.set(`${targetLoc}|${targetItem}`, row);
    if (targetLoc) existingByLocationAndFallback.set(`${targetLoc}|${inventoryDuplicateKey(row)}`, row);
  }

  const sourcePurchaseOptionsByItemId = new Map<string, any[]>();
  if (copyPurchaseOptions) {
    const { data: sourceOptions, error: optionError } = await adminClient
      .from("purchase_options")
      .select("*")
      .in("inventory_item_id", selectedItemIds);
    if (optionError) {
      result.errors.push(`Purchase options fetch error: ${optionError.message}`);
    } else {
      for (const row of sourceOptions ?? []) {
        const key = String(row.inventory_item_id ?? "");
        if (!sourcePurchaseOptionsByItemId.has(key)) sourcePurchaseOptionsByItemId.set(key, []);
        sourcePurchaseOptionsByItemId.get(key)!.push(row);
      }
    }
  }

  const buildSetupPayload = (source: any) => ({
    name: source.name || "",
    category: source.category || "",
    itemtype: source.itemtype || "",
    baseunit: source.baseunit || source.unit || "",
    unit: source.unit || "",
    parlevel: copyPar ? Number(source.parlevel ?? 0) : 0,
    cost: copySupplierSettings ? Number(source.cost ?? 0) : 0,
    purchasecost: copySupplierSettings && source.purchasecost != null ? Number(source.purchasecost) : null,
    supplierid: copySupplierSettings && source.supplierid != null ? Number(source.supplierid) : null,
    purchaseunits: copySupplierSettings && Array.isArray(source.purchaseunits) ? source.purchaseunits : [],
    purchase_uom: copySupplierSettings ? source.purchase_uom ?? null : null,
    pack_qty: copySupplierSettings && source.pack_qty != null ? Number(source.pack_qty) : null,
    inner_unit_type: copySupplierSettings ? source.inner_unit_type ?? null : null,
    inner_unit_size: copySupplierSettings && source.inner_unit_size != null ? Number(source.inner_unit_size) : null,
    inner_unit_uom: copySupplierSettings ? source.inner_unit_uom ?? null : null,
    base_uom: copySupplierSettings ? source.base_uom ?? null : null,
    allowed_recipe_uoms: copySupplierSettings && Array.isArray(source.allowed_recipe_uoms) ? source.allowed_recipe_uoms : null,
    pricetrend: source.pricetrend || "steady",
    priceincrease: Boolean(source.priceincrease),
  });

  const purchaseOptionInsertRows: any[] = [];
  const copyPurchaseOptionsForTarget = async (source: any, targetRowId: string) => {
    if (!copyPurchaseOptions) return;
    const sourceOptions = sourcePurchaseOptionsByItemId.get(String(source.id)) ?? [];
    if (sourceOptions.length === 0) return;

    const { data: existingOptions, error: existingOptionsError } = await adminClient
      .from("purchase_options")
      .select("*")
      .eq("inventory_item_id", targetRowId);
    if (existingOptionsError) {
      result.errors.push(`${source.name}@${targetRowId}: purchase option check failed: ${existingOptionsError.message}`);
      return;
    }

    const existingKeys = new Set((existingOptions ?? []).map(purchaseOptionDuplicateKey));
    for (const option of sourceOptions) {
      if (existingKeys.has(purchaseOptionDuplicateKey(option))) continue;
      purchaseOptionInsertRows.push({
        inventory_item_id: targetRowId,
        supplier_name: option.supplier_name ?? "",
        supplier_product_name: option.supplier_product_name ?? null,
        purchase_uom: option.purchase_uom ?? "",
        pack_qty: option.pack_qty != null ? Number(option.pack_qty) : null,
        pack_uom: option.pack_uom ?? null,
        unit_price: option.unit_price != null ? Number(option.unit_price) : 0,
        is_preferred: Boolean(option.is_preferred),
      });
      existingKeys.add(purchaseOptionDuplicateKey(option));
    }
  };

  const inventoryInsertRows: any[] = [];
  const sourceByNewRowId = new Map<string, any>();

  for (const source of sources) {
    const sourceItemId = String(source.item_id ?? source.id);
    for (const targetLocationId of targetLocationIds) {
      const existing =
        existingByLocationAndItemId.get(`${targetLocationId}|${sourceItemId}`) ??
        existingByLocationAndFallback.get(`${targetLocationId}|${inventoryDuplicateKey(source)}`) ??
        null;

      if (existing && !updateExistingSetupFields) {
        result.skipped++;
        continue;
      }

      if (existing && updateExistingSetupFields) {
        const updatePayload: Record<string, any> = {
          ...buildSetupPayload(source),
          ...(copyStock ? { instock: Number(source.instock ?? 0) } : {}),
        };
        delete updatePayload.name;

        const { data: updated, error: updateError } = await adminClient
          .from("inventory_items")
          .update(updatePayload)
          .eq("id", existing.id)
          .select()
          .maybeSingle();
        if (updateError) {
          result.failed++;
          result.errors.push(`${source.name}@${targetLocationId}: update failed: ${updateError.message}`);
          continue;
        }
        result.updated++;
        if (updated) result.updatedRows.push(mapInventoryToFrontend(updated));
        await copyPurchaseOptionsForTarget(source, String(existing.id));
        continue;
      }

      const newRowId = crypto.randomUUID();
      inventoryInsertRows.push({
        id: newRowId,
        item_id: sourceItemId,
        location_id: targetLocationId,
        ...buildSetupPayload(source),
        instock: copyStock ? Number(source.instock ?? 0) : 0,
        linked_recipe_id: null,
      });
      sourceByNewRowId.set(newRowId, source);
    }
  }

  for (const chunk of chunkArray(inventoryInsertRows, CHUNK_INVENTORY_ROWS)) {
    const { data: inserted, error: insertError } = await adminClient
      .from("inventory_items")
      .insert(chunk)
      .select();
    if (insertError) {
      result.failed += chunk.length;
      result.errors.push(`Inventory insert batch failed: ${insertError.message}`);
      continue;
    }

    const insertedRows = inserted ?? [];
    result.created += insertedRows.length;
    result.insertedRows.push(...insertedRows.map(mapInventoryToFrontend));
    for (const insertedRow of insertedRows) {
      const source = sourceByNewRowId.get(String(insertedRow.id));
      if (source) await copyPurchaseOptionsForTarget(source, String(insertedRow.id));
    }
  }

  for (const chunk of chunkArray(purchaseOptionInsertRows, CHUNK_PURCHASE_OPTIONS)) {
    const { error: optionInsertError } = await adminClient
      .from("purchase_options")
      .insert(chunk);
    if (optionInsertError) {
      result.errors.push(`Purchase option insert batch failed: ${optionInsertError.message}`);
    } else {
      result.purchaseOptionsCopied += chunk.length;
    }
  }

  return NextResponse.json({ success: true, data: result });
}
