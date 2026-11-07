const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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
