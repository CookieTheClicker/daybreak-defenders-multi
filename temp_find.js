const fs = require("fs");
const text = fs.readFileSync("src/main.js", "utf8");
let balance = 0;
for (const ch of text) {
  if (ch === "{") balance++;
  else if (ch === "}") balance--;
}
console.log('balance', balance);
