// Generates the @solana/kit client from the Anchor IDL: target/idl/unspent.json → src/generated.
import { readFileSync } from "node:fs";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const idl = JSON.parse(readFileSync(new URL("../../../target/idl/unspent.json", import.meta.url), "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(new URL("..", import.meta.url).pathname, {
    generatedFolder: "src/generated",
    deleteFolderBeforeRendering: true,
    syncPackageJson: false,
    formatCode: false,
  }),
);
console.log("generated src/generated");
