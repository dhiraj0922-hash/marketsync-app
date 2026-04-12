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

async function scan() {
  // Let's deliberately push a fake "1" to every column that exists to see if one triggers the `{}` error when passed an object.
  const payload = {
      id: "999999",
      name: "Test"
  };

  const keys = [
     "category", "itemtype", "baseunit", "unit", "instock", "parlevel", "cost", "supplierid", "pricetrend", "priceincrease", "purchaseunits"
  ];

  for (const k of keys) {
     const pl = { ...payload, [k]: {} }; // Send empty object!
     const { error } = await supabase.from('inventory_items').insert(pl);
     if (error && error.message.includes("invalid input syntax for type integer")) {
         console.log(`BINGO! Column responding as integer: ${k}`);
     } else if (error && error.message.includes("row-level security")) {
         // If it's pure RLS, that means the type mapping succeeded but auth failed!
         // Wait, type casting happens BEFORE RLS constraint! 
         // So if it hits RLS, it means `{}` was ACCEPTED.
         console.log(`Column ${k} accepted {} before RLS check!`);
     } else {
         console.log(`Column ${k} error: ${error?.message}`);
     }
  }
}
scan();
