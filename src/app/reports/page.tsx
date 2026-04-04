"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, FileText, Download, Filter } from "lucide-react";

export default function Reports() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Reports Library</h2>
          <p className="text-neutral-500 text-sm">Generate and export detailed enterprise performance reports.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[
          { title: "Cost of Goods Sold (CoGS)", description: "Weekly & Monthly cost analysis broken down by category." },
          { title: "Actual vs Theoretical", description: "Variance reports highlighting waste, over-portioning, and spillage." },
          { title: "Supplier Spend", description: "Purchase history and price fluctuation tracking across vendors." },
          { title: "Inventory Valuation", description: "Current value of stock on hand for accounting and auditing." }
        ].map((report, i) => (
          <Card key={i} className="hover:border-brand-300 transition-colors cursor-pointer group shadow-sm">
            <CardHeader className="pb-2">
              <div className="p-2.5 bg-brand-50 w-fit rounded-lg text-brand-600 mb-2 group-hover:bg-brand-100 transition-colors">
                <BarChart className="h-5 w-5" />
              </div>
              <CardTitle className="text-base">{report.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500 mb-4">{report.description}</p>
              <div className="flex items-center text-brand-600 text-sm font-medium gap-1 group-hover:text-brand-700 transition-colors">
                Configure Report
                <Filter className="h-3.5 w-3.5 ml-1" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
