"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { loadRecipes, saveRecipes, loadInventory, saveInventory } from "@/lib/storage";
import { normalizeUnit } from "@/lib/units";
import { Plus, Search, SplitSquareVertical, Calculator, Trash2 } from "lucide-react";

export default function Recipes() {
  const [recipes, setRecipes] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  
  // Builder State
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<any>(null);
  
  const [recipeName, setRecipeName] = useState("");
  const [recipeCategory, setRecipeCategory] = useState("Mains");
  const [yieldQty, setYieldQty] = useState<number>(1);
  const [yieldUnit, setYieldUnit] = useState("kg");
  const [targetMargin, setTargetMargin] = useState<number>(80);
  const [outputItemId, setOutputItemId] = useState<string>("");
  
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [selectedInvId, setSelectedInvId] = useState<string>("");

  useEffect(() => {
    setRecipes(loadRecipes());
    setInventory(loadInventory());
  }, []);

  const openBuilder = (recipe: any = null) => {
    if (recipe) {
      setEditingRecipe(recipe);
      setRecipeName(recipe.name);
      setRecipeCategory(recipe.category || "Mains");
      setYieldQty(recipe.yieldQty || 1);
      setYieldUnit(recipe.yieldUnit || "kg");
      setTargetMargin(recipe.margin || 80);
      setOutputItemId(recipe.outputItemId || "");
      setIngredients(recipe.ingredients ? [...recipe.ingredients] : []);
    } else {
      setEditingRecipe(null);
      setRecipeName("");
      setRecipeCategory("Mains");
      setYieldQty(1);
      setYieldUnit("kg");
      setTargetMargin(80);
      setOutputItemId("");
      setIngredients([]);
    }
    setSelectedInvId("");
    setIsBuilderOpen(true);
  };

  const addIngredient = () => {
    if (!selectedInvId) return;
    
    const invItem = inventory.find(i => i.id.toString() === selectedInvId);
    if (!invItem) return;
    
    // Prevent duplicates
    if (ingredients.some(ing => ing.inventoryId?.toString() === selectedInvId)) {
      alert("Ingredient is already in the recipe.");
      return;
    }

    const newIng = {
      type: 'inventory',
      inventoryId: invItem.id,
      name: invItem.name, 
      qty: 1,
      unit: invItem.baseUnit || invItem.unit 
    };

    setIngredients([...ingredients, newIng]);
    setSelectedInvId("");
  };

  const updateIngredient = (index: number, field: string, value: any) => {
    const updated = [...ingredients];
    updated[index][field] = value;
    setIngredients(updated);
  };

  const removeIngredient = (index: number) => {
    const updated = [...ingredients];
    updated.splice(index, 1);
    setIngredients(updated);
  };

  const calculateCost = () => {
    let total = 0;
    let errors = 0;

    ingredients.forEach(ing => {
      try {
        const targetId = ing.inventoryId || ing.fgId;
        if (targetId) {
          const invItem = inventory.find(i => i.id.toString() === targetId.toString());
          if (invItem) {
            const baseTargetUnit = invItem.baseUnit || invItem.unit;
            const normQty = normalizeUnit(ing.qty, ing.unit, baseTargetUnit);
            
            let effectiveBaseCost = invItem.cost;
            if (invItem.purchaseUnits && invItem.purchaseUnits.length > 0) {
                const primary = invItem.purchaseUnits.find((u: any) => u.isPrimary) || invItem.purchaseUnits[0];
                const explicitPurchaseTarget = (invItem.purchaseCost !== undefined && invItem.purchaseCost !== null) ? invItem.purchaseCost : invItem.cost;
                effectiveBaseCost = explicitPurchaseTarget / primary.conversion;
            }
            total += (normQty * effectiveBaseCost);
          }
        }
      } catch (e) {
        errors++;
      }
    });

    return { total, errors };
  };

  const saveRecipeData = () => {
    if (!recipeName.trim()) {
      alert("Recipe name is required.");
      return;
    }
    if (ingredients.length === 0) {
      alert("Recipes require at least one ingredient mapped from active inventory.");
      return;
    }

    const costData = calculateCost();
    if (costData.errors > 0) {
      alert("Cannot save recipe. Some ingredients have incompatible unit mappings that cannot be resolved computationally (e.g., liters to kilograms without a density metric).");
      return;
    }

    const cost = costData.total;
    // Price = Cost / (1 - Margin) => e.g. Margin 80% => Price = Cost / 0.20
    const marginDec = targetMargin / 100;
    const price = (marginDec >= 1) ? 0 : cost / (1 - marginDec);

    const recipeData = {
      id: editingRecipe ? editingRecipe.id : `REC-${Math.floor(1000 + Math.random() * 9000)}`,
      name: recipeName,
      category: recipeCategory,
      yieldQty: yieldQty,
      yieldUnit: yieldUnit,
      theoreticalCost: cost,
      margin: targetMargin,
      price: price,
      outputItemId: outputItemId,
      ingredients: ingredients
    };

    let updatedRecipes = [...recipes];
    if (editingRecipe) {
      const idx = updatedRecipes.findIndex(r => r.id === editingRecipe.id);
      if (idx > -1) updatedRecipes[idx] = recipeData;
    } else {
      updatedRecipes.push(recipeData);
    }

    // Dynamic Central Kitchen Option B Mapping
    if (outputItemId) {
       const _inv = [...inventory];
       const matchKey = _inv.findIndex(i => i.id.toString() === outputItemId);
       if (matchKey !== -1) {
          _inv[matchKey].cost = cost / yieldQty;
          setInventory(_inv);
          saveInventory(_inv);
       }
    }

    setRecipes(updatedRecipes);
    saveRecipes(updatedRecipes);
    setIsBuilderOpen(false);
  };

  const filteredRecipes = recipes.filter(r => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const currentCalc = calculateCost();
  const currentPrice = (targetMargin / 100 >= 1) ? 0 : currentCalc.total / (1 - (targetMargin / 100));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight">Recipes & Costing</h2>
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">HQ Only</Badge>
          </div>
          <p className="text-neutral-500">Construct BOM outputs mathematically linking units natively to raw inventory tracking.</p>
        </div>
        <button 
          onClick={() => openBuilder()}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          Create Recipe Wrapper
        </button>
      </div>

      <Card className="shadow-sm border-neutral-200">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100">
          <div className="relative w-full sm:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search recipes..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50">
              <TableRow>
                <TableHead className="pl-6">Recipe Sequence</TableHead>
                <TableHead>Yield Rules</TableHead>
                <TableHead>Raw Items Mapped</TableHead>
                <TableHead className="text-right">Theoretical Output Cost</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRecipes.map((recipe) => (
                <TableRow key={recipe.id} className="hover:bg-neutral-50/50 group">
                  <TableCell className="pl-6 py-4">
                    <p className="font-semibold text-brand-900">{recipe.name}</p>
                    <p className="text-xs text-neutral-500 mt-0.5">{recipe.category} • {recipe.id}</p>
                  </TableCell>
                  <TableCell className="py-4">
                    <Badge variant="neutral" className="bg-white border-neutral-200 text-neutral-700">
                      Output: {recipe.yieldQty} {recipe.yieldUnit}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-4 text-sm text-neutral-600">
                    <span className="font-semibold text-neutral-900">{recipe.ingredients ? recipe.ingredients.length : 0}</span> linked nodes
                  </TableCell>
                  <TableCell className="py-4 text-right">
                    <p className="font-bold text-neutral-900">${(recipe.theoreticalCost || 0).toFixed(2)}</p>
                    <p className="text-[10px] uppercase text-neutral-400 font-semibold tracking-wider mt-1">{recipe.margin}% target margin</p>
                  </TableCell>
                  <TableCell className="pr-6 py-4 text-right">
                    <button 
                      onClick={() => openBuilder(recipe)}
                      className="px-3 py-1.5 bg-white border border-neutral-200 text-neutral-700 rounded-md text-xs font-semibold hover:bg-neutral-50 transition-colors shadow-sm inline-flex items-center gap-1.5"
                    >
                      <SplitSquareVertical className="h-3.5 w-3.5" /> Open Matrix
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Drawer
        isOpen={isBuilderOpen}
        onClose={() => setIsBuilderOpen(false)}
        title={editingRecipe ? "Edit Recipe Map" : "Compile Recipe Map"}
        description="Bind abstract ingredients firmly exclusively to existing HQ raw tier items."
        footer={
          <div className="w-full flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
               <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">Calculation Output</span>
               {currentCalc.errors > 0 ? (
                 <span className="text-sm font-bold text-danger-600">Unresolvable Unit Constraints</span>
               ) : (
                 <span className="text-sm font-bold text-brand-700">${currentCalc.total.toFixed(2)} Target Cost</span>
               )}
            </div>
            <div className="flex gap-2">
              <button 
                className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm"
                onClick={() => setIsBuilderOpen(false)}
              >
                Discard
              </button>
              <button 
                className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm"
                onClick={saveRecipeData}
              >
                Compile Sequence
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          <div className="bg-white p-4 rounded-xl border border-neutral-200 shadow-sm space-y-4">
            <div>
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Recipe Identity</label>
              <input 
                type="text" 
                value={recipeName}
                onChange={e => setRecipeName(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded font-medium focus:ring-1 focus:ring-brand-500 focus:outline-none"
                placeholder="e.g. Garlic Emulsion Base"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Category</label>
                <select 
                  value={recipeCategory}
                  onChange={e => setRecipeCategory(e.target.value)}
                  className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none bg-white"
                >
                  <option>Mains</option>
                  <option>Prep</option>
                  <option>Sauces</option>
                  <option>Starters</option>
                  <option>Desserts</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Target Margin (%)</label>
                <input 
                  type="number" 
                  value={targetMargin}
                  onChange={e => setTargetMargin(Number(e.target.value))}
                  className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-4">
             <div className="flex-1 bg-white p-4 rounded-xl border border-neutral-200 shadow-sm">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block flex items-center justify-between">
                  Expected Physical Yield
                  <Calculator className="h-3.5 w-3.5 text-neutral-400" />
                </label>
                <div className="flex gap-2">
                  <input 
                    type="number" 
                    value={yieldQty}
                    onChange={e => setYieldQty(Number(e.target.value))}
                    className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    placeholder="Qty"
                  />
                  <input 
                    type="text" 
                    value={yieldUnit}
                    onChange={e => setYieldUnit(e.target.value)}
                    className="w-24 p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    placeholder="kg/L"
                  />
                </div>
                
                <div className="pt-4 mt-4 border-t border-neutral-100">
                   <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Linked Physical Output Item (Optional)</label>
                   <select
                     value={outputItemId}
                     onChange={e => setOutputItemId(e.target.value)}
                     className="w-full p-2 border border-neutral-300 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                   >
                     <option value="">No Link (Abstract Recipe)</option>
                     <optgroup label="Physical Preparations / FGs">
                       {inventory.filter((i: any) => i.itemType === 'Preparation' || i.itemType === 'Finished Good').map((item: any) => (
                         <option key={item.id} value={item.id.toString()}>
                           {item.name} ({item.unit})
                         </option>
                       ))}
                     </optgroup>
                   </select>
                   <p className="text-[10px] text-neutral-400 mt-1">If linked, generating production blocks updates this item's native stock quantity.</p>
                </div>
             </div>
             
             <div className="w-48 bg-neutral-800 text-white p-4 rounded-xl shadow-inner flex flex-col justify-center">
                <p className="text-[10px] uppercase font-bold text-neutral-400 tracking-wider">Suggested Menu Price</p>
                <p className="text-2xl font-bold mt-1">${currentPrice.toFixed(2)}</p>
             </div>
          </div>

          <div>
             <div className="flex items-center justify-between mb-3">
               <h3 className="font-bold text-neutral-900 border-b-2 border-brand-500 pb-1 w-fit">Raw Hardware Requirements</h3>
             </div>
             
             <div className="space-y-3">
               {ingredients.map((ing, idx) => {
                  let lineCost = 0;
                  let hasError = false;
                  
                  const targetId = ing.inventoryId || ing.fgId;
                  const invItem = inventory.find(i => i.id.toString() === targetId?.toString());
                  
                  if (invItem) {
                     try {
                        const baseTargetUnit = invItem.baseUnit || invItem.unit;
                        const normQty = normalizeUnit(ing.qty, ing.unit, baseTargetUnit);
                        
                        let effectiveBaseCost = invItem.cost;
                        if (invItem.purchaseUnits && invItem.purchaseUnits.length > 0) {
                            const primary = invItem.purchaseUnits.find((u: any) => u.isPrimary) || invItem.purchaseUnits[0];
                            const explicitPurchaseTarget = (invItem.purchaseCost !== undefined && invItem.purchaseCost !== null) ? invItem.purchaseCost : invItem.cost;
                            effectiveBaseCost = explicitPurchaseTarget / primary.conversion;
                        }
                        lineCost = normQty * effectiveBaseCost;
                     } catch (e) {
                        hasError = true;
                     }
                  }

                  const mappedName = invItem ? invItem.name : "Unknown Item";
                  const mappedUnit = invItem?.unit || 'N/A';
                  
                  // Extract visual type indicator if properly tagged in the native inventory ledger
                  const isPrepNode = invItem && (invItem.itemType === 'Preparation' || invItem.itemType === 'Finished Good');

                  return (
                    <div key={idx} className={`p-3 rounded-lg border flex items-center gap-4 shadow-sm bg-white ${hasError ? 'border-danger-300' : 'border-neutral-200'}`}>
                      <div className="w-1/3">
                        <div className="flex items-center gap-2 mb-0.5">
                           <p className="text-sm font-bold text-neutral-900 truncate">{mappedName}</p>
                           {isPrepNode ? (
                              <Badge variant="warning" className="text-[9px] px-1.5 py-0 border-none bg-orange-100 text-orange-700">PREP</Badge>
                           ) : (
                              <Badge variant="neutral" className="text-[9px] px-1.5 py-0 border-none bg-neutral-100 text-neutral-600">INV</Badge>
                           )}
                        </div>
                        <p className="text-[10px] text-neutral-400 uppercase tracking-wider font-semibold mt-0.5">
                          Native Constraint: <span className="text-brand-600">{mappedUnit}</span>
                        </p>
                      </div>
                      
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <input 
                          type="number"
                          value={ing.qty}
                          onChange={e => updateIngredient(idx, 'qty', Number(e.target.value))}
                          className="w-full p-1.5 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                        <select
                          value={ing.unit}
                          onChange={e => updateIngredient(idx, 'unit', e.target.value)}
                          className="w-full p-1.5 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                        >
                           <option value="g">Grams (g)</option>
                           <option value="kg">Kilograms (kg)</option>
                           <option value="oz">Ounces (oz)</option>
                           <option value="lb">Pounds (lb)</option>
                           <option value="ml">Milliliters (ml)</option>
                           <option value="litre">Liters (L)</option>
                           <option value="piece">Pieces</option>
                           <option value="box">Boxes</option>
                        </select>
                      </div>
                      
                      <div className="w-20 text-right shrink-0">
                         {hasError ? (
                           <Badge variant="danger" className="text-[10px] px-1.5 py-0 border-none">Math Error</Badge>
                         ) : (
                           <span className="text-sm font-semibold text-neutral-600">${lineCost.toFixed(2)}</span>
                         )}
                      </div>

                      <button 
                        onClick={() => removeIngredient(idx)}
                        className="text-neutral-400 hover:text-danger-600 p-1.5 rounded hover:bg-danger-50 transition-colors"
                      >
                         <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
               })}

               <div className="p-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 flex items-center gap-3">
                 <select 
                   value={selectedInvId}
                   onChange={e => setSelectedInvId(e.target.value)}
                   className="flex-1 p-2 border border-neutral-300 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                 >
                   <option value="">Select inventory item or preparation to append...</option>
                   <optgroup label="Raw Inventory Nodes">
                     {inventory.filter((i: any) => i.itemType === 'Raw' || !i.itemType).map((item: any) => (
                       <option key={`inv-${item.id}`} value={item.id.toString()}>
                         {item.name} ({item.unit}) — ${(item.cost || 0).toFixed(2)}/{item.unit}
                       </option>
                     ))}
                   </optgroup>
                   <optgroup label="Finished Goods & Preparations">
                     {inventory.filter((i: any) => i.itemType === 'Preparation' || i.itemType === 'Finished Good').map((item: any) => (
                       <option key={`prep-${item.id}`} value={item.id.toString()}>
                         {item.name} ({item.unit}) — ${(item.cost || 0).toFixed(2)}/{item.unit}
                       </option>
                     ))}
                   </optgroup>
                 </select>
                 <button 
                   onClick={addIngredient}
                   disabled={!selectedInvId}
                   className="px-4 py-2 bg-neutral-900 text-white text-sm font-medium rounded-md hover:bg-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                   Append
                 </button>
               </div>
             </div>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
