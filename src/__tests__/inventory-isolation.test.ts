type InventoryRow = {
  id: string;
  itemId: string;
  locationId: string;
  name: string;
  inStock: number;
  cost?: number;
};

const cloneRows = (rows: InventoryRow[]) => rows.map(row => ({ ...row }));

const snapshot = (rows: InventoryRow[]) =>
  Object.fromEntries(rows.map(row => [row.id, row.inStock]));

const expectOnlyRowsChanged = (
  before: Record<string, number>,
  afterRows: InventoryRow[],
  changed: Record<string, number>,
) => {
  for (const row of afterRows) {
    const expected = changed[row.id] ?? before[row.id];
    expect(row.inStock).toBe(expected);
  }
};

const updateScoped = (
  rows: InventoryRow[],
  rowId: string,
  locationId: string,
  nextStock: number,
) => {
  const matches = rows.filter(row => row.id === rowId && row.locationId === locationId);
  if (matches.length !== 1) throw new Error(`Scoped update matched ${matches.length} rows`);
  matches[0].inStock = nextStock;
};

const receivePurchaseOrder = (
  rows: InventoryRow[],
  sharedItemId: string,
  locationId: string,
  receivedQty: number,
) => {
  const row = rows.find(item => item.itemId === sharedItemId && item.locationId === locationId);
  if (!row) throw new Error(`No row for ${sharedItemId} at ${locationId}`);
  updateScoped(rows, row.id, locationId, row.inStock + receivedQty);
};

const approveCount = (
  rows: InventoryRow[],
  rowId: string,
  locationId: string,
  physicalQty: number,
) => updateScoped(rows, rowId, locationId, physicalQty);

const runProductionBatch = (
  rows: InventoryRow[],
  params: {
    locationId: string;
    ingredientItemId: string;
    ingredientQty: number;
    finishedGoodItemId: string;
    producedQty: number;
  },
) => {
  const ingredient = rows.find(row => row.itemId === params.ingredientItemId && row.locationId === params.locationId);
  const finishedGood = rows.find(row => row.itemId === params.finishedGoodItemId && row.locationId === params.locationId);
  if (!ingredient || !finishedGood) throw new Error("Production rows missing for selected location");
  updateScoped(rows, ingredient.id, params.locationId, ingredient.inStock - params.ingredientQty);
  updateScoped(rows, finishedGood.id, params.locationId, finishedGood.inStock + params.producedQty);
};

describe("Inventory location isolation", () => {
  const baseRows: InventoryRow[] = [
    { id: "hq-oil-row", itemId: "shared-oil", locationId: "LOC-HQ", name: "DUMMY TEST OIL", inStock: 100 },
    { id: "ajax-oil-row", itemId: "shared-oil", locationId: "LOC-AJAX", name: "DUMMY TEST OIL", inStock: 10 },
    { id: "london-oil-row", itemId: "shared-oil", locationId: "LOC-1091", name: "DUMMY TEST OIL", inStock: 20 },
    { id: "brampton-oil-row", itemId: "shared-oil", locationId: "LOC-BRAMPTON", name: "DUMMY TEST OIL", inStock: 30 },
    { id: "hq-fg-row", itemId: "shared-fg", locationId: "LOC-HQ", name: "DUMMY TEST FG", inStock: 50 },
    { id: "ajax-fg-row", itemId: "shared-fg", locationId: "LOC-AJAX", name: "DUMMY TEST FG", inStock: 5 },
    { id: "brampton-fg-row", itemId: "shared-fg", locationId: "LOC-BRAMPTON", name: "DUMMY TEST FG", inStock: 8 },
  ];

  test("HQ, location, London copy, PO receive, count approval, and production update only selected location rows", () => {
    const rows = cloneRows(baseRows);

    let before = snapshot(rows);
    updateScoped(rows, "hq-oil-row", "LOC-HQ", 777);
    expectOnlyRowsChanged(before, rows, { "hq-oil-row": 777 });

    before = snapshot(rows);
    updateScoped(rows, "ajax-oil-row", "LOC-AJAX", 222);
    expectOnlyRowsChanged(before, rows, { "ajax-oil-row": 222 });

    before = snapshot(rows);
    updateScoped(rows, "london-oil-row", "LOC-1091", 333);
    expectOnlyRowsChanged(before, rows, { "london-oil-row": 333 });
    expect(rows.find(row => row.id === "brampton-oil-row")?.inStock).toBe(30);

    before = snapshot(rows);
    receivePurchaseOrder(rows, "shared-oil", "LOC-AJAX", 12);
    expectOnlyRowsChanged(before, rows, { "ajax-oil-row": 234 });
    expect(rows.find(row => row.id === "hq-oil-row")?.inStock).toBe(777);

    before = snapshot(rows);
    approveCount(rows, "brampton-oil-row", "LOC-BRAMPTON", 44);
    expectOnlyRowsChanged(before, rows, { "brampton-oil-row": 44 });
    expect(rows.find(row => row.id === "hq-oil-row")?.inStock).toBe(777);

    before = snapshot(rows);
    runProductionBatch(rows, {
      locationId: "LOC-AJAX",
      ingredientItemId: "shared-oil",
      ingredientQty: 4,
      finishedGoodItemId: "shared-fg",
      producedQty: 6,
    });
    expectOnlyRowsChanged(before, rows, {
      "ajax-oil-row": 230,
      "ajax-fg-row": 11,
    });
    expect(rows.find(row => row.id === "hq-oil-row")?.inStock).toBe(777);
    expect(rows.find(row => row.id === "hq-fg-row")?.inStock).toBe(50);
    expect(rows.find(row => row.id === "brampton-fg-row")?.inStock).toBe(8);
  });
});
