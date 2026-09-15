// Compiles src/app.jsx and inlines it (plus React) into app/index.html,
// so the desktop app works fully offline.
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const { code } = esbuild.transformSync(read("src/app.jsx"), {
  loader: "jsx", jsx: "transform", target: "es2019", minify: true,
});
const react = read("node_modules/react/umd/react.production.min.js");
const reactDom = read("node_modules/react-dom/umd/react-dom.production.min.js");

for (const [name, js] of [["app", code], ["react", react], ["react-dom", reactDom]]) {
  if (js.includes("</script")) throw new Error(`${name} contains a closing script tag`);
}

let html = read("src/shell.html")
  .replace(/<script src="[^"]*\/react@[^"]*"><\/script>/, () => `<script>${react}</script>`)
  .replace(/<script src="[^"]*\/react-dom@[^"]*"><\/script>/, () => `<script>${reactDom}</script>`)
  .replace("/*__APP__*/", () => code);

if (html.includes("cdn.jsdelivr.net")) throw new Error("A CDN script tag was not replaced");

fs.mkdirSync(path.join(root, "app"), { recursive: true });
fs.writeFileSync(path.join(root, "app", "index.html"), html);
console.log(`Built app/index.html (${Math.round(html.length / 1024)} KB)`);
