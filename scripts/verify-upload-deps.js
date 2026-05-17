/**
 * Fails the build if legacy multer-storage-cloudinary is still in the dependency tree.
 * Render runs this via npm run build — prevents ERESOLVE from reaching production.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const lockRaw = fs.readFileSync(lockPath, "utf8");

const forbidden = "multer-storage-cloudinary";
const errors = [];

if (pkg.dependencies?.[forbidden] || pkg.devDependencies?.[forbidden]) {
  errors.push(`${forbidden} is listed in package.json`);
}
if (lockRaw.includes(forbidden)) {
  errors.push(`${forbidden} is referenced in package-lock.json`);
}

const cloudVer = pkg.dependencies?.cloudinary;
if (!cloudVer || !String(cloudVer).includes("2.")) {
  errors.push(`expected cloudinary@^2.x, got ${cloudVer}`);
}

if (errors.length) {
  // eslint-disable-next-line no-console
  console.error("[verify-upload-deps] FAILED:\n", errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log("[verify-upload-deps] OK — cloudinary@2 only, no multer-storage-cloudinary");
