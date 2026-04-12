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

async function dumpRemoteSchemaDef() {
  const { data, error } = await supabase.rpc('get_schema_cache').catch(()=>({data:null, error:null})); // attempt if valid
  
  const payload = {
      bogusIntVal: 1, 
      id: "TEST-01"
  };

  const { error: e3 } = await supabase.from('inventory_items').insert(payload);
  console.log("INTENTIONAL ERROR TO VIEW COLUMNS:", e3?.message);
}
dumpRemoteSchemaDef();
