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
  const payload = {
      id: "999999",
      name: "Test",
      supplierid: null
  };

  const { error } = await supabase.from('inventory_items').insert(payload);
  console.log("NULL supplierid error:", error?.message);
}
scan();
