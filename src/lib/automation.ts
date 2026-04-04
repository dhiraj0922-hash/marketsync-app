import {
   loadRequisitions,
   loadFinishedGoods,
   loadProductionPlans,
   saveProductionPlans,
   loadRecipes,
   loadInventory,
   loadOrders,
   saveOrders
 } from "./storage";
 import { normalizeUnit } from "./units";
 
 export function runAutomationEngine() {
   if (typeof window === "undefined") return;
 
   const requisitions = loadRequisitions();
   const finishedGoods = loadFinishedGoods();
   const productionPlans = loadProductionPlans();
   const recipes = loadRecipes();
   const inventory = loadInventory();
   const orders = loadOrders();
 
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
 
     if (demandData.totalQty > fg.currentStock) {
       const shortage = demandData.totalQty - fg.currentStock;
 
       // Check if there is already an active (non-completed/rejected) plan for this FG today
       const existingPlan = productionPlans.find((p: any) => p.fgId === fgId && p.date === today && p.status !== "Completed" && p.status !== "Rejected");
 
       if (!existingPlan) {
         const newPlan = {
           id: `PP-${2000 + productionPlans.length + 1}`,
           date: today,
           fgId: fg.id,
           fgName: fg.name,
           requiredQty: demandData.totalQty,
           availableFgStock: fg.currentStock,
           shortageQty: shortage,
           suggestedProductionQty: shortage,
           status: 'Draft (Auto)',
           unit: fg.unit
         };
         productionPlans.push(newPlan);
         plansChanged = true;
       } else if (existingPlan.status === "Draft (Auto)" && existingPlan.requiredQty !== demandData.totalQty) {
         // Update existing auto-draft if the math changed and it hasn't been touched yet
         existingPlan.requiredQty = demandData.totalQty;
         existingPlan.availableFgStock = fg.currentStock;
         existingPlan.shortageQty = shortage;
         existingPlan.suggestedProductionQty = shortage;
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
       const item = inventory.find((i: any) => i.id.toString() === ing.inventoryId.toString());
       if (item) {
          try {
            const normalizedQty = normalizeUnit(ing.qty, ing.unit, item.baseUnit || item.unit);
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
     const item = inventory.find((i: any) => i.id.toString() === invId.toString());
     if (!item) return;
 
     if (requiredQty > item.inStock) {
       const rawShortage = requiredQty - item.inStock;
       
       // Does a pending PO already cover this?
       const hasOpenPO = orders.some((o: any) => 
          (o.status === "Draft" || o.status === "Draft (Auto)" || o.status === "Pending Approval" || o.status === "Sent") &&
          o.lineItems?.some((li: any) => li.id === item.id)
       );
 
       if (!hasOpenPO) {
          // Generate a Draft (Auto) PO for this supplier
          let targetPO = orders.find((o: any) => o.supplierId === item.supplierId && o.status === "Draft (Auto)" && o.date === today);
          
          if (!targetPO) {
             targetPO = {
               id: `PO-AUTO-${1000 + orders.length + 1}`,
               supplierId: item.supplierId,
               date: today,
               deliveryDate: "Pending",
               items: 0,
               total: 0,
               status: "Draft (Auto)",
               location: "HQ (All Locations)",
               createdBy: "Auto Engine",
               receivedBy: null,
               receivedAt: null,
               notes: "Auto-generated to cover Production Plan raw material shortages.",
               lineItems: []
             };
             orders.push(targetPO);
             ordersChanged = true;
          }
 
          // add line item using primary purchase unit fallback
          if (!targetPO.lineItems.some((li: any) => li.id === item.id)) {
             let pUnit = { name: item.baseUnit || item.unit, conversion: 1 };
             if (item.purchaseUnits && item.purchaseUnits.length > 0) {
                 pUnit = item.purchaseUnits.find((u: any) => u.isPrimary) || item.purchaseUnits[0];
             }
             
             const draftQty = Math.ceil(rawShortage / pUnit.conversion);

             targetPO.lineItems.push({
               id: item.id,
               name: item.name,
               qty: draftQty,
               unit: pUnit.name,
               baseEquivalent: draftQty * pUnit.conversion,
               baseUnit: item.baseUnit || item.unit,
               cost: item.cost
             });
             targetPO.items = targetPO.lineItems.length;
             targetPO.total = targetPO.lineItems.reduce((sum: number, li: any) => sum + (li.qty * li.cost), 0);
             ordersChanged = true;
          }
       }
     }
   });
 
   if (plansChanged) saveProductionPlans(productionPlans);
   if (ordersChanged) saveOrders(orders);
 }
 
 function fgIdToRecipeId(fgId: string, finishedGoods: any[]) {
   const fg = finishedGoods.find((f: any) => f.id === fgId);
   return fg ? fg.recipeId : null;
 }
