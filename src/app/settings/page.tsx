"use client";

import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, ServerCrash, ShieldAlert } from "lucide-react";
import { 
  saveOrders, 
  saveRequisitions, 
  saveCounts, 
  saveProductionPlans, 
  saveProductionHistory, 
  saveInventoryActivity, 
  saveImportBatches,
  loadInventory,
  saveInventory
} from "@/lib/storage";

export default function SettingsPage() {
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  const expectedPhrase = "RESET ALL DATA";
  const isValid = confirmText === expectedPhrase;

  const handleSystemReset = () => {
    if (!isValid) return;
    setIsResetting(true);

    try {
      // 1. Wipe all operational queues
      saveOrders([]);
      saveRequisitions([]);
      saveCounts([]);
      saveProductionPlans([]);
      saveProductionHistory([]);
      saveImportBatches([]);
      saveInventoryActivity({});

      // 2. Map inventory master ledger strictly to exactly 0 stock
      const inventory = loadInventory();
      const wipedInventory = inventory.map((item: any) => ({
        ...item,
        inStock: 0
      }));
      saveInventory(wipedInventory);

      // Force a hard reload to drop any cached memory arrays in React State
      window.location.href = "/";
    } catch (e) {
      console.error("Critical failure during reset routine:", e);
      alert("Failed to execute complete wipe sequence. Check console.");
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">System Controls</h2>
          <p className="text-neutral-500 text-sm">Administrative global logic routing and framework architecture limits.</p>
        </div>
      </div>

      <div className="space-y-8">
        {/* Placeholder for standard settings future expansion */}
        <Card className="shadow-sm border-neutral-200">
           <CardHeader>
              <CardTitle className="text-lg">General Settings</CardTitle>
              <CardDescription>Configure localization frameworks and system preferences.</CardDescription>
           </CardHeader>
           <CardContent>
              <div className="text-sm text-neutral-500 italic p-4 bg-neutral-50 rounded border border-dashed text-center">
                 System configurations will map here structurally in the future...
              </div>
           </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="shadow-sm border-danger-200 overflow-hidden">
           <CardHeader className="bg-danger-50/50 border-b border-danger-100">
              <CardTitle className="text-lg text-danger-800 flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription className="text-danger-600/80">
                Highly destructive administrative controls. Restricted to HQ System Owners natively.
              </CardDescription>
           </CardHeader>
           <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                 <div>
                    <h4 className="font-bold text-neutral-900 text-sm">Purge Operational Framework</h4>
                    <p className="text-sm text-neutral-500 mt-1 max-w-xl">
                      Permanently wipes all active transactions (Counts, Requisitions, POs, Recipes, Alerts) whilst rigidly preserving master structure records. Good for migrating from demo logic strictly into production-ready live rollouts.
                    </p>
                 </div>
                 <button 
                   onClick={() => setResetModalOpen(true)}
                   className="shrink-0 px-4 py-2 bg-danger-600 hover:bg-danger-700 text-white text-sm font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
                 >
                   <ServerCrash className="h-4 w-4" />
                   System Reset
                 </button>
              </div>
           </CardContent>
        </Card>
      </div>

      {resetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-neutral-100 bg-danger-50">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 flex-shrink-0 rounded-full bg-danger-100 text-danger-600 flex items-center justify-center">
                   <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-danger-900">Execute System Reset</h3>
                  <p className="text-xs text-danger-700 mt-0.5">This action operates irreversibly.</p>
                </div>
              </div>
            </div>
            
            <div className="p-5 space-y-4">
              <ul className="text-sm text-neutral-600 space-y-2 list-disc pl-4 bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                 <li><strong className="text-neutral-900">Removed Permanently:</strong> Orders, Approvals, Requisitions, Plans, Sessions, Batch Logs.</li>
                 <li><strong className="text-neutral-900">Zeroed Instantly:</strong> All active Inventory / Finished Good Stock.</li>
                 <li><strong className="text-brand-700">Preserved Master Arrays:</strong> Location mapping, Role bounds, Recipes, Supplier Matrix, Structural Item Definitions.</li>
              </ul>

              <div className="pt-2">
                 <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-2">
                   To safely execute, please type <span className="bg-neutral-100 text-danger-600 px-1 py-0.5 rounded select-none font-mono tracking-normal">{expectedPhrase}</span> precisely below.
                 </label>
                 <input 
                   type="text" 
                   autoFocus
                   value={confirmText}
                   onChange={(e) => setConfirmText(e.target.value)}
                   className={`w-full font-mono text-sm p-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-1 transition-colors ${isValid ? 'border-success-500 focus:ring-success-500 text-success-700' : 'border-neutral-300 focus:ring-danger-500'}`}
                   placeholder={expectedPhrase}
                 />
              </div>
            </div>

            <div className="p-4 bg-neutral-50 border-t border-neutral-100 flex justify-end gap-3">
               <button 
                 disabled={isResetting}
                 onClick={() => { setResetModalOpen(false); setConfirmText(""); }}
                 className="px-4 py-2 text-sm font-semibold text-neutral-600 hover:text-neutral-900 bg-white border border-neutral-200 rounded-lg shadow-sm hover:bg-neutral-50 transition-colors"
               >
                 Abort Command
               </button>
               <button 
                 disabled={!isValid || isResetting}
                 onClick={handleSystemReset}
                 className={`px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition-all flex items-center justify-center min-w-[140px]
                    ${isValid ? 'bg-danger-600 hover:bg-danger-700' : 'bg-neutral-300 cursor-not-allowed'}
                 `}
               >
                 {isResetting ? "WIPING..." : "Verify & Destruct"}
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
