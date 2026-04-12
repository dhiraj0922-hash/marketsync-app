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

async function check() {
  const { error: e3 } = await supabase.from('inventory_items').insert({ bogusColumn123: 1 });
  console.log("INTENTIONAL ERROR TRACE:", e3);
}
check();
