"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, FileText, Download, Filter, Settings2, Clock } from "lucide-react";
import { Drawer } from "@/components/ui/drawer";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";

export default function Reports() {
  return (
    <HQOnlyGuard>
      <ReportsPageContent />
    </HQOnlyGuard>
  );
}

function ReportsPageContent() {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<any>(null);
  const [dateRange, setDateRange] = useState("Last 7 Days");

  const reportsList = [
    { id: "cogs", title: "Cost of Goods Sold (CoGS)", description: "Weekly & Monthly cost analysis broken down by category.", metrics: ["Total Spending", "Category Breakdown", "Variance vs Budget"] },
    { id: "actualvstheo", title: "Actual vs Theoretical", description: "Variance reports highlighting waste, over-portioning, and spillage.", metrics: ["Total Waste Value", "Item-Level Missing Stock", "Production Yield Loss"] },
    { id: "supplier", title: "Supplier Spend & Latency", description: "Purchase history and price fluctuation tracking across vendors.", metrics: ["Total Spend per Vendor", "Average Lead Time", "Price Volatility Index"] },
    { id: "valuation", title: "Inventory Valuation", description: "Current value of stock on hand for accounting and auditing.", metrics: ["Total SOH Value", "Value by Location", "Value by Category"] }
  ];

  const handleOpenReport = (report: any) => {
     setSelectedReport(report);
     setIsDrawerOpen(true);
  };

  const handleExport = () => {
     alert(`Export sequence initialized for ${selectedReport.title}. Generating CSV format...`);
     setIsDrawerOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Reports Library</h2>
          <p className="text-neutral-500 text-sm">Generate and export detailed enterprise performance reports.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {reportsList.map((report) => (
          <Card key={report.id} onClick={() => handleOpenReport(report)} className="hover:border-brand-300 transition-all cursor-pointer group shadow-sm hover:shadow-md">
            <CardHeader className="pb-2">
              <div className="p-2.5 bg-brand-50 w-fit rounded-lg text-brand-600 mb-2 group-hover:bg-brand-100 transition-colors">
                <BarChart className="h-5 w-5" />
              </div>
              <CardTitle className="text-base text-neutral-800">{report.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500 mb-4">{report.description}</p>
              <div className="flex items-center text-brand-600 text-sm font-medium gap-1 group-hover:text-brand-700 transition-colors">
                Configure Report
                <Settings2 className="h-3.5 w-3.5 ml-1" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title={`Configure: ${selectedReport?.title}`}
        description="Filter parameters before executing enterprise data compilation."
        footer={
           <div className="flex justify-end gap-3 w-full">
               <button onClick={() => setIsDrawerOpen(false)} className="px-4 py-2 border rounded-lg text-sm text-neutral-600 bg-white shadow-sm">Cancel</button>
               <button onClick={handleExport} className="px-5 py-2 rounded-lg text-sm text-white bg-brand-600 hover:bg-brand-700 font-medium shadow-sm flex items-center gap-2">
                  <Download className="h-4 w-4" /> Export CSV
               </button>
           </div>
        }
      >
        {selectedReport && (
           <div className="space-y-6 py-4">
              <div className="space-y-2">
                 <label className="text-xs font-bold text-neutral-600 uppercase tracking-wider">Date Boundary Vector</label>
                 <select value={dateRange} onChange={e => setDateRange(e.target.value)} className="w-full p-2 border rounded-md text-sm">
                    <option value="Today">Today</option>
                    <option value="Last 7 Days">Last 7 Days</option>
                    <option value="Last 30 Days">Last 30 Days</option>
                    <option value="Year to Date">Year to Date</option>
                 </select>
              </div>

              <div className="space-y-3 pt-4 border-t border-neutral-100">
                 <h4 className="text-xs font-bold text-neutral-600 uppercase tracking-wider">Included Analytics Vectors</h4>
                 <div className="grid gap-2">
                    {selectedReport.metrics.map((m: string) => (
                       <div key={m} className="p-3 bg-neutral-50 border border-neutral-100 rounded flex justify-between items-center text-sm font-medium text-neutral-700">
                         {m}
                         <input type="checkbox" defaultChecked className="accent-brand-600 h-4 w-4" />
                       </div>
                    ))}
                 </div>
              </div>
           </div>
        )}
      </Drawer>
    </div>
  );
}
