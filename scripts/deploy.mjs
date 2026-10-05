import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function wrangler(args) {
  return execFileSync(
    "npx",
    ["wrangler", ...args],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"]
    }
  );
}

function json(output) {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");

  if (first === -1 || last === -1) {
    throw new Error("Output Wrangler bukan JSON.");
  }

  return JSON.parse(output.slice(first, last + 1));
}

function getId(data) {
  return (
    data?.uuid ||
    data?.database_id ||
    data?.id ||
    data?.result?.uuid ||
    data?.result?.database_id ||
    data?.result?.id ||
    null
  );
}

console.log("Mencari database D1 velora...");

let databases;

try {
  databases = json(
    wrangler(["d1", "list", "--json"])
  );
} catch (error) {
  console.error("Gagal mengambil daftar D1.");
  process.exit(1);
}

const list = Array.isArray(databases)
  ? databases
  : databases.result || databases.results || [];

let database = list.find(
  item =>
    item.name === "velora" ||
    item.database_name === "velora"
);

let d1Id = getId(database);

if (!d1Id) {
  console.log("D1 velora belum ditemukan.");
  console.log("Membuat D1 velora...");

  let created;

  try {
    created = json(
      wrangler(["d1", "create", "velora", "--json"])
    );
  } catch (error) {
    console.error("Gagal membuat D1 velora.");
    process.exit(1);
  }

  d1Id = getId(created);
}

if (!d1Id) {
  console.error("D1 ID tidak ditemukan.");
  process.exit(1);
}

console.log("D1 ID ditemukan:");
console.log(d1Id);

const config = `name = "backendbuildapk"
main = "index.js"
compatibility_date = "2026-09-30"

[[d1_databases]]
binding = "DB"
database_name = "velora"
database_id = "${d1Id}"
`;

writeFileSync(
  "worker/.wrangler.deploy.toml",
  config
);

console.log("Deploy Worker...");

const result = spawnSync(
  "npx",
  [
    "wrangler",
    "deploy",
    "--config",
    ".wrangler.deploy.toml"
  ],
  {
    cwd: "worker",
    stdio: "inherit"
  }
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}
