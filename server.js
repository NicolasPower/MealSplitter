const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const sqlite3 = require("sqlite3").verbose();

const root = __dirname;
const port = Number(process.env.PORT || 3000);

function loadEnvironment() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvironment();

const db = new sqlite3.Database(path.join(root, "meals.db"));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

const dbReady = run(`
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ingredients TEXT NOT NULL,
    servings INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

dbReady.catch((error) => {
  console.error("Unable to initialize the meal database:", error);
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { status: 400 });
  }
}

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2 || c === 88)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (version !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    if (net.isIP(mapped) === 4) return isPublicAddress(mapped);
  }

  const pieces = lower.split("::");
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const groups = pieces.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return false;
  const first = parseInt(groups[0], 16);
  const second = parseInt(groups[1], 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !(first === 0x2001 && second === 0x0db8);
}

async function validateRecipeUrl(url) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error("Enter a public HTTP or HTTPS recipe URL."), { status: 400 });
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw Object.assign(new Error("Only public recipe websites can be imported."), { status: 400 });
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("The recipe website could not be reached."), { status: 400 });
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw Object.assign(new Error("Only public recipe websites can be imported."), { status: 400 });
  }
}

async function readLimitedResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > maxBytes) {
    throw Object.assign(new Error("The recipe page is too large to import."), { status: 413 });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error("The recipe page is too large to import."), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (code[0] === "#") {
      const number = code[1].toLowerCase() === "x"
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " }[code.toLowerCase()];
  });
}

function getRecipeFromHtml(html) {
  const candidates = [];
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);

  function collectRecipes(value) {
    if (Array.isArray(value)) {
      value.forEach(collectRecipes);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some((type) => typeof type === "string" && type.toLowerCase().split(/[\/#]/).pop() === "recipe")) {
      candidates.push(value);
    }
    if (value["@graph"]) collectRecipes(value["@graph"]);
    if (value.mainEntity) collectRecipes(value.mainEntity);
    if (value.itemListElement) collectRecipes(value.itemListElement);
  }

  for (const match of scripts) {
    try {
      collectRecipes(JSON.parse(match[1].replace(/^\s*<!--|-->\s*$/g, "").trim()));
    } catch {
      continue;
    }
  }

  const recipe = candidates.find((candidate) =>
    Array.isArray(candidate.recipeIngredient) && candidate.recipeIngredient.some((item) => typeof item === "string" && item.trim())
  );
  if (!recipe) return null;

  const ingredients = recipe.recipeIngredient
    .filter((ingredient) => typeof ingredient === "string" && ingredient.trim())
    .map((ingredient) => decodeHtmlEntities(ingredient).trim());
  const yieldText = Array.isArray(recipe.recipeYield) ? recipe.recipeYield.join(" ") : String(recipe.recipeYield || "");
  const servingsMatch = yieldText.match(/\d+/);
  return {
    name: decodeHtmlEntities(typeof recipe.name === "string" ? recipe.name : "").trim(),
    ingredients,
    servings: servingsMatch ? Math.min(50, Math.max(1, Number(servingsMatch[0]))) : null,
  };
}

async function scrapeRecipe(urlValue) {
  if (typeof urlValue !== "string" || urlValue.length > 2048) {
    throw Object.assign(new Error("Enter a valid recipe URL."), { status: 400 });
  }

  let currentUrl;
  try {
    currentUrl = new URL(urlValue);
  } catch {
    throw Object.assign(new Error("Enter a valid recipe URL."), { status: 400 });
  }

  for (let redirects = 0; redirects <= 5; redirects++) {
    await validateRecipeUrl(currentUrl);
    const page = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "MealSplitter/1.0 (recipe ingredient importer)", Accept: "text/html,application/xhtml+xml" },
    });

    if ([301, 302, 303, 307, 308].includes(page.status)) {
      const location = page.headers.get("location");
      await page.body?.cancel();
      if (!location || redirects === 5) {
        throw Object.assign(new Error("The recipe page redirected too many times."), { status: 502 });
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!page.ok) {
      await page.body?.cancel();
      throw Object.assign(new Error(`The recipe website returned HTTP ${page.status}.`), { status: 502 });
    }
    const contentType = page.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await page.body?.cancel();
      throw Object.assign(new Error("The URL did not return an HTML recipe page."), { status: 415 });
    }

    const recipe = getRecipeFromHtml(await readLimitedResponse(page, 2 * 1024 * 1024));
    if (!recipe) {
      throw Object.assign(new Error("No recipe ingredients were found on that page."), { status: 422 });
    }
    return recipe;
  }
}

async function searchFoods(query) {
  const apiKey = process.env.USDA_FOOD_CENTRAL_API_KEY;
  if (!apiKey) throw Object.assign(new Error("USDA_FOOD_CENTRAL_API_KEY is missing from .env"), { status: 500 });

  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}`;
  let lastError;
  const cleanQuery = String(query || "")
    .replace(/[^a-z0-9\s%/-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  if (!cleanQuery) {
    throw Object.assign(new Error("The cleaned ingredient name is empty."), { status: 400 });
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cleanQuery, pageSize: 10 }),
      });
      const responseText = await response.text();
      let data = {};

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          if (!response.ok) {
            throw Object.assign(
              new Error(`USDA FoodData Central returned ${response.status}: ${responseText.trim()}`),
              { status: response.status }
            );
          }
          throw Object.assign(new Error("USDA FoodData Central returned an invalid response."), { status: 502 });
        }
      }

      if (!response.ok) {
        const message = typeof data.error === "string"
          ? data.error
          : data.error?.message || data.message || `HTTP ${response.status}`;
        throw Object.assign(
          new Error(`USDA FoodData Central request failed (${response.status}): ${message}`),
          { status: response.status }
        );
      }

      return data;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && error.status !== 429) throw error;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastError;
}

const nutrientConfig = {
  1008: { key: "calories", label: "Calories", unit: "kcal" },
  1003: { key: "protein", label: "Protein", unit: "g" },
  1004: { key: "totalFat", label: "Total fat", unit: "g" },
  1005: { key: "carbohydrates", label: "Carbohydrates", unit: "g" },
  1079: { key: "fiber", label: "Fiber", unit: "g" },
  2000: { key: "sugars", label: "Sugars", unit: "g" },
  1093: { key: "sodium", label: "Sodium", unit: "mg" },
  1253: { key: "cholesterol", label: "Cholesterol", unit: "mg" },
};

function parseNumber(value) {
  const mixedMatch = value.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) return Number(mixedMatch[1]) + Number(mixedMatch[2]) / Number(mixedMatch[3]);

  const fractionMatch = value.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) return Number(fractionMatch[1]) / Number(fractionMatch[2]);

  return Number(value);
}

function cleanFoodName(name) {
  return name
    .replace(/\b(boneless|skinless|crushed|peeled|grated|diced|chopped|mild|medium|hot|full fat|fine sea|ground)\b/gi, " ")
    .replace(/,.*$/, "")
    .replace(/\b(cut|into)\b.*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFoodEntry(entry) {
  let cleaned = entry.trim()
    .replace(/^[-*]\s*\[[ xX]\]\s*/, "")
    .replace(/^\s*\[[ xX]\]\s*/, "");

  if (!cleaned) return { query: "", grams: 100, explicitAmount: false };

  cleaned = cleaned.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^((?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?))\s*(kg|kilograms?|g|grams?|mg|milligrams?|cups?|tbsp|tablespoons?|tsp|teaspoons?|l|litres?|ml|millilitres?|ounces?|oz|lbs?|pounds?|breasts?|cloves?|onions?|pieces?|cm|centimetres?|centimeters?)?\s+(.+)$/i);

  if (!match) {
    return { query: cleanFoodName(cleaned.split(",")[0].trim()), grams: 100, explicitAmount: false };
  }

  const amount = parseNumber(match[1]);
  const unit = (match[2] || "").toLowerCase();
  const baseName = cleanFoodName(match[3].split(",")[0].trim());

  const unitGrams = {
    kg: 1000, kilogram: 1000, kilograms: 1000,
    g: 1, gram: 1, grams: 1,
    mg: 0.001, milligram: 0.001, milligrams: 0.001,
    cup: 240, cups: 240,
    tbsp: 15, tablespoon: 15, tablespoons: 15,
    tsp: 5, teaspoon: 5, teaspoons: 5,
    l: 1000, litre: 1000, litres: 1000,
    ml: 1, millilitre: 1, millilitres: 1,
    ounce: 28.35, ounces: 28.35, oz: 28.35,
    lb: 453.59, lbs: 453.59, pound: 453.59, pounds: 453.59,
    breast: 120, breasts: 120,
    clove: 3, cloves: 3,
    onion: 150, onions: 150,
    piece: 100, pieces: 100,
    cm: 15, centimetre: 15, centimetres: 15, centimeter: 15, centimeters: 15,
  };

  let grams;
  if (!unit) {
    const countWeight = /chicken|breast/i.test(baseName) ? 120
      : /garlic/i.test(baseName) ? 3
        : /onion/i.test(baseName) ? 150
          : 100;
    grams = amount * countWeight;
  } else {
    grams = amount * (unitGrams[unit] || 100);
  }

  return {
    query: baseName || cleanFoodName(match[3]),
    grams: Math.max(0, grams),
    explicitAmount: true,
  };
}

function normalizeFoodName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function chooseBestMatch(query, foods) {
  const normalizedQuery = normalizeFoodName(query);
  return foods.reduce((best, food) => {
    const name = normalizeFoodName(food.description || "");
    let score = 0;
    if (name === normalizedQuery) score += 100;
    if (name.startsWith(normalizedQuery)) score += 50;
    if (name.includes(normalizedQuery)) score += 25;

    const queryWords = normalizedQuery.split(" ").filter(Boolean);
    for (const word of queryWords) {
      if (name.includes(word)) score += 10;
    }

    return !best || score > best.score ? { food, score } : best;
  }, null)?.food;
}

function getNutrients(food, grams) {
  const nutrients = {};
  const scale = grams / 100;

  for (const nutrient of food.foodNutrients || []) {
    const config = nutrientConfig[nutrient.nutrientId];
    if (!config || typeof nutrient.value !== "number") continue;
    nutrients[config.key] = (nutrients[config.key] || 0) + nutrient.value * scale;
  }

  return nutrients;
}

const server = http.createServer(async (request, response) => {
  try {
    await dbReady;
    if (request.method === "GET" && request.url === "/api/meals") {
      const meals = await all("SELECT id, name, ingredients, servings, created_at, updated_at FROM meals ORDER BY updated_at DESC");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ meals }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/recipes/import") {
      const { url } = await readJson(request);
      const recipe = await scrapeRecipe(url);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ recipe }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/meals") {
      const { name, ingredients, servings } = await readJson(request);
      const cleanName = typeof name === "string" ? name.trim() : "";
      const cleanIngredients = typeof ingredients === "string" ? ingredients.trim() : "";
      const cleanServings = Math.min(50, Math.max(1, Math.floor(Number(servings) || 1)));

      if (!cleanName) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "A meal name is required." }));
        return;
      }
      if (!cleanIngredients) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Add at least one ingredient." }));
        return;
      }

      const timestamp = new Date().toISOString();
      const result = await run(
        "INSERT INTO meals (name, ingredients, servings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [cleanName, cleanIngredients, cleanServings, timestamp, timestamp]
      );
      const meal = await get(
        "SELECT id, name, ingredients, servings, created_at, updated_at FROM meals WHERE id = ?",
        [result.id]
      );
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ meal }));
      return;
    }

    const mealDeleteMatch = request.url?.match(/^\/api\/meals\/(\d+)$/);
    if (request.method === "DELETE" && mealDeleteMatch) {
      const result = await run("DELETE FROM meals WHERE id = ?", [Number(mealDeleteMatch[1])]);
      if (!result.changes) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Meal not found." }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ deleted: true }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/foods/search") {
      const { query, queries } = await readJson(request);

      if (Array.isArray(queries)) {
        const entries = queries
          .filter((entry) => typeof entry === "string" && entry.trim())
          .slice(0, 20)
          .map(parseFoodEntry)
          .filter((entry) => entry.query);

        if (!entries.length) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Enter at least one food to search." }));
          return;
        }

        const totals = {};
        const foods = [];

        for (const entry of entries) {
          let data;
          try {
            data = await searchFoods(entry.query);
          } catch (error) {
            if (error.status === 400) {
              foods.push({ query: entry.query, grams: entry.grams, match: null });
              continue;
            }
            throw error;
          }
          const match = chooseBestMatch(entry.query, data.foods || []);
          if (!match) {
            foods.push({ query: entry.query, grams: entry.grams, match: null });
            continue;
          }

          const nutrients = getNutrients(match, entry.grams);
          for (const config of Object.values(nutrientConfig)) {
            totals[config.key] = (totals[config.key] || 0) + (nutrients[config.key] || 0);
          }
          foods.push({
            query: entry.query,
            grams: entry.grams,
            match: {
              description: match.description,
              brandOwner: match.brandOwner || null,
              nutrients,
            },
          });
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          foods,
          totals,
          assumedGrams: entries.every((entry) => !entry.explicitAmount),
        }));
        return;
      }

      if (typeof query !== "string" || !query.trim()) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "A food search query is required." }));
        return;
      }

      const data = await searchFoods(query.trim());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
      return;
    }

    const requestedPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
    const filePath = path.join(root, path.normalize(requestedPath).replace(/^[/\\]+/, ""));
    if (!filePath.startsWith(root)) throw new Error("Invalid path");

    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end(error.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(content);
    });
  } catch (error) {
    response.writeHead(error.status || 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Meal Splitter running at http://localhost:${port}`);
});
