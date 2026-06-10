import { initDb } from "../src/db.ts";
import { addDependency } from "../src/models/dependency.ts";

initDb(process.env.KDI_DB || "/tmp/kdi-demo.db");
addDependency(1, 2);
console.log("Dependency added: parent=1, child=2");
