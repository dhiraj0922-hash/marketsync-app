import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error("Supabase URL or Anon Key is missing from process.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runAudit() {
  console.log("Starting Requisition Items Pack Snapshot Audit...");
  console.log("-----------------------------------------------");

  const { data: items, error } = await supabase
    .from('requisition_items')
    .select('id, requisition_id, item_name_snapshot, pack_qty_snapshot, finished_good_id, hq_sale_items(name, pack_qty)')
    .not('finished_good_id', 'is', null);

  if (error) {
    console.error("Error fetching requisition items:", error);
    process.exit(1);
  }

  let totalAudited = 0;
  let totalMismatched = 0;

  for (const item of items) {
    totalAudited++;
    const snapQty = item.pack_qty_snapshot != null ? Number(item.pack_qty_snapshot) : 1;
    const hqSaleItem = item.hq_sale_items;
    
    if (hqSaleItem) {
      const hqQty = hqSaleItem.pack_qty != null ? Number(hqSaleItem.pack_qty) : 1;
      
      if ((item.pack_qty_snapshot === null || snapQty === 1) && hqQty > 1) {
        totalMismatched++;
        console.log(`[MISMATCH] Requisition: ${item.requisition_id} | Item ID: ${item.id}`);
        console.log(`  Name Snapshot : "${item.item_name_snapshot}"`);
        console.log(`  HQ SKU        : ${item.finished_good_id} ("${hqSaleItem.name}")`);
        console.log(`  Snapshot Qty  : ${item.pack_qty_snapshot} (defaulted to 1)`);
        console.log(`  HQ Catalog Qty: ${hqQty}`);
        console.log("-----------------------------------------------");
      }
    }
  }

  console.log("Audit Summary:");
  console.log(`  Total Finished Goods Requisition Items Audited: ${totalAudited}`);
  console.log(`  Total Mismatched Pack Snapshots Found         : ${totalMismatched}`);
  if (totalMismatched === 0) {
    console.log("  SUCCESS: No incorrect snapshots found.");
  } else {
    console.log("  WARNING: Incorrect snapshots found! These should be noted.");
  }
}

runAudit();
