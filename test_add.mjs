import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env.local', 'utf8').split('\n').reduce((acc, line) => {
   const [k, ...v] = line.split('=');
   if(k && v) acc[k.trim()] = v.join('=').trim();
   return acc;
}, {});

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function testUpsert() {
  const payload = [{
     id: "999999",
     name: "Test Item",
     category: "Produce",
     itemtype: "Raw",
     baseunit: "kg",
     unit: "kg",
     instock: 0,
     parlevel: 0,
     cost: 0,
     supplierid: null,
     pricetrend: "steady",
     priceincrease: false,
     purchaseunits: []
  }];

  const { error } = await supabase.from('inventory_items').upsert(payload, { onConflict: 'id' });
  console.log("BASE ADD ITEM:", error?.message);

  const payload2 = [{
     id: "999999",
     name: "Test Item 2",
     category: "Produce",
     itemtype: "Raw",
     baseunit: "kg",
     unit: "kg",
     instock: 0,
     parlevel: 0,
     cost: 0,
     supplierid: null,
     pricetrend: "steady",
     priceincrease: false,
     purchaseunits: {} // Send object instead of array!
  }];

  const { error: e2 } = await supabase.from('inventory_items').upsert(payload2, { onConflict: 'id' });
  console.log("OBJECT PURCHASE UNITS ADD ITEM:", e2?.message);
}
testUpsert();
