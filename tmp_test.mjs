import { STRUCTURE_TYPES } from "./src/constants.js";
import { Inventory } from "./src/inventory.js";
const inv = new Inventory();
console.log(inv.getResources());
const barricade = STRUCTURE_TYPES.barricade.cost;
console.log(barricade);
console.log(inv.canAfford(barricade));
console.log(inv.spendResources(barricade));
console.log(inv.getResources());
