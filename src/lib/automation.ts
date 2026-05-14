import {
   loadRequisitions,
   loadFinishedGoods,
   loadProductionPlans,
   saveProductionPlans,
   loadRecipes,
   loadInventory,
   loadOrders,
   saveOrders,
   generateOrderId,
} from "./storage";
 import { normalizeUnit, resolveEffectiveBaseUom } from "./units";
 
 export async function runAutomationEngine() {
  if (typeof window === "undefined") return;

  const rawRequisitions = await loadRequisitions();
  const rawFinishedGoods = await loadFinishedGoods();
  const rawProductionPlans = await loadProductionPlans();
  const rawRecipes = await loadRecipes();
  const rawInventory = await loadInventory();
  const rawOrders = await loadOrders();

  // Explicit safety limits globally guarding null states directly
  const requisitions = Array.isArray(rawRequisitions) ? rawRequisitions : [];
  const finishedGoods = Array.isArray(rawFinishedGoods) ? rawFinishedGoods : [];
  const productionPlans = Array.isArray(rawProductionPlans) ? rawProductionPlans : [];
  const recipes = Array.isArray(rawRecipes) ? rawRecipes : [];
  const inventory = Array.isArray(rawInventory) ? rawInventory : [];
  const orders = Array.isArray(rawOrders) ? rawOrders : [];
 
   let plansChanged = false;
   let ordersChanged = false;
 
   const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
 
   // Step 1: Auto Production Planner
   // Read total required quantity from HQ Production View for selected date (today)
   const relevantReqs = requisitions.filter((r: any) =>
     r.date === today &&
     (r.status === "Approved" || r.status === "Submitted" || r.status === "Draft" || r.status === "Partial" || r.status === "Backordered")
   );
 
   // Aggregate demand
   const fgDemand: Record<string, { totalQty: number, unit: string }> = {};
   relevantReqs.forEach((req: any) => {
     req.lineItems.forEach((li: any) => {
       const remainingQty = li.requestedQty - (li.fulfilledQty || 0);
       if (remainingQty > 0) {
         if (!fgDemand[li.id]) {
           fgDemand[li.id] = { totalQty: 0, unit: li.unit };
         }
         fgDemand[li.id].totalQty += remainingQty;
       }
     });
   });
 
   // Compare against FG stock & Generate Production Plans
   Object.entries(fgDemand).forEach(([fgId, demandData]: [string, any]) => {
     const fg = finishedGoods.find((f: any) => f.id === fgId);
     if (!fg) return;
 
     if (demandData.totalQty > fg.inStock) {
       const shortage = demandData.totalQty - fg.inStock;
 
       // Check if there is already an active (non-completed/rejected) plan for this FG today
       const existingPlan = productionPlans.find((p: any) => p.fgId === fgId && p.date === today && p.status !== "Completed" && p.status !== "Rejected");
 
       if (!existingPlan) {
         const newPlan = {
           id: `PP-${2000 + productionPlans.length + 1}`,
           date: today,
           fgId: fg.id,
           fgName: fg.name,
           quantity: shortage,
           unit: fg.unit,
           status: 'Draft (Auto)',
           priority: 'Normal',
           location: 'System Generated',
           assignedTo: '',
           notes: '',
           ingredients: [],
           // Extension DOM limits:
           requiredQty: demandData.totalQty,
           availableFgStock: fg.inStock,
           shortageQty: shortage,
           suggestedProductionQty: shortage
         };
         productionPlans.push(newPlan as any);
         plansChanged = true;
       } else if (existingPlan.status === "Draft (Auto)" && (existingPlan as any).requiredQty !== demandData.totalQty) {
         // Update existing auto-draft if the math changed and it hasn't been touched yet
         (existingPlan as any).requiredQty = demandData.totalQty;
         (existingPlan as any).availableFgStock = fg.inStock;
         (existingPlan as any).shortageQty = shortage;
         (existingPlan as any).suggestedProductionQty = shortage;
         plansChanged = true;
       }
     }
   });
 
   // Step 2: Auto PO Draft Engine for Raw Material Shortages based on Production Plans
   // For each Production Plan that is Draft (Auto) or Pending Approval
   const rawMaterialDeficits: Record<string, number> = {};
 
   productionPlans.forEach((plan: any) => {
     if (plan.status !== "Draft (Auto)" && plan.status !== "Pending Approval") return;
 
     const recipe = recipes.find((r: any) => r.id === fgIdToRecipeId(plan.fgId, finishedGoods));
     if (!recipe) return;
 
     // How many batches of the recipe do we need to hit suggestedProductionQty?
     // e.g. plan needs 10kg, recipe yields 10kg => 1 batch.
     const batchesNeeded = plan.suggestedProductionQty / recipe.yieldQty;
 
     recipe.ingredients.forEach((ing: any) => {
       // Match by shared itemId first (new rows), fall back to row id (legacy)
       const item = inventory.find((i: any) =>
         (i.itemId && i.itemId.toString() === ing.inventoryId.toString()) ||
         i.id.toString() === ing.inventoryId.toString()
       );
       if (item) {
          try {
            const normalizedQty = normalizeUnit(ing.qty, ing.unit, resolveEffectiveBaseUom(item));
            const requiredIngQty = batchesNeeded * normalizedQty;
            rawMaterialDeficits[ing.inventoryId] = (rawMaterialDeficits[ing.inventoryId] || 0) + requiredIngQty;
          } catch (e) {
            console.error(`Automation Engine blocked PO draft for ${item.name} due to unit incompatibility.`);
          }
       }
     });
   });
 
   // Compare required sub-ingredients against inventory
   Object.entries(rawMaterialDeficits).forEach(([invId, requiredQty]: [string, any]) => {
     // Match by shared itemId first, fall back to row id for legacy rows
     const item = inventory.find((i: any) =>
       (i.itemId && i.itemId.toString() === invId.toString()) ||
       i.id.toString() === invId.toString()
     );
     if (!item) return;
 
     if (requiredQty > item.inStock) {
       const rawShortage = requiredQty - item.inStock;

       // Does a pending PO already cover this? Match by itemId or row id.
       const hasOpenPO = orders.some((o: any) =>
          (o.status === "Draft" || o.status === "Draft (Auto)" || o.status === "Pending Approval" || o.status === "Sent") &&
          o.lineItems?.some((li: any) =>
            (item.itemId && li.itemId === item.itemId) || li.id === item.id
          )
       );
 
       if (!hasOpenPO) {
          // Generate a Draft (Auto) PO for this supplier
          let targetPO = orders.find((o: any) => o.supplierId === item.supplierId && o.status === "Draft (Auto)" && o.date === today);
          
          if (!targetPO) {
             const { id, poNumber } = generateOrderId();
             const newOrder = {
              id,
              poNumber,
              supplierId: item.supplierId,
              supplierName: "System Automation",
              date: today,
              deliveryDate: "Pending",
              items: 0,
              total: 0,
              status: "Draft (Auto)",
              location: "Main HQ",
              locationId: "LOC-HQ",
              createdBy: "System Automation",
              receivedBy: "",
              receivedAt: "",
              notes: "Generated by Demand Automation rules.",
              lineItems: []
          };
          orders.push(newOrder as any);
          targetPO = newOrder;
             ordersChanged = true;
          }
 
          // add line item using primary purchase unit fallback
          const existingItem = (targetPO as any).lineItems.find((li: any) =>
            (item.itemId && li.itemId === item.itemId) || li.id === item.id
          );
          if (existingItem) {
             // Update math logic bounds structurally preserving JSONB blocks organically
             const oldQty = existingItem.qty || 0;
             const newQty = oldQty + rawShortage;
             existingItem.qty = newQty;
             existingItem.subtotal = newQty * (item.cost || 0);
          } else {
             (targetPO as any).lineItems.push({
                id:        item.id,
                itemId:    item.itemId || item.id,   // carry shared identity forward
                name:      item.name,
                qty:       rawShortage,
                unit:      item.unit,
                unitPrice: item.cost || 0,
                subtotal:  rawShortage * (item.cost || 0)
             });
          }
          (targetPO as any).items = (targetPO as any).lineItems.length;
          (targetPO as any).total = (targetPO as any).lineItems.reduce((sum: number, i: any) => sum + (i.subtotal || 0), 0);
          ordersChanged = true;
       }
     }
   });
 
   if (plansChanged) await saveProductionPlans(productionPlans);
   if (ordersChanged) await saveOrders(orders);
 }
 
 function fgIdToRecipeId(fgId: string, finishedGoods: any[]) {
   const fg = finishedGoods.find((f: any) => f.id === fgId);
   return fg ? fg.recipeId : null;
 }
