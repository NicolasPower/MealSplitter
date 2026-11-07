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
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pageSize: 10 }),
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
    throw Object.assign(new Error(data.error?.message || "USDA FoodData Central request failed"), { status: response.status });
  }

  return data;
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

function parseFoodEntry(entry) {
  const trimmed = entry.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(kg|kilograms?|g|grams?)\s+(.+)$/i);

  if (!match) return { query: trimmed, grams: 100, explicitAmount: false };

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return {
    query: match[3].trim(),
    grams: unit.startsWith("kg") || unit.startsWith("kilogram") ? amount * 1000 : amount,
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
          .map(parseFoodEntry);

        if (!entries.length) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Enter at least one food to search." }));
          return;
        }

        const totals = {};
        const foods = [];

        for (const entry of entries) {
          const data = await searchFoods(entry.query);
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
