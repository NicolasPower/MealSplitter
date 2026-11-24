const button = document.querySelector("#search-foods");
const message = document.querySelector("#message");
const servingsInput = document.querySelector("#servings");
const results = document.querySelector("#food-results");
const savedMealsSelect = document.querySelector("#saved-meals");
const mealNameInput = document.querySelector("#meal-name");
const saveMealButton = document.querySelector("#save-meal");
const deleteMealButton = document.querySelector("#delete-meal");
const recipeUrlInput = document.querySelector("#recipe-url");
const importRecipeButton = document.querySelector("#import-recipe");

let savedMeals = [];

async function readApiResponse(response) {
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The server returned an invalid JSON response.");
    }
  }
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function renderSavedMeals() {
  savedMealsSelect.innerHTML = '<option value="">Select a saved meal</option>';
  for (const meal of savedMeals) {
    const option = document.createElement("option");
    option.value = String(meal.id);
    option.textContent = meal.name;
    savedMealsSelect.append(option);
  }
  deleteMealButton.disabled = !savedMealsSelect.value;
}

async function loadSavedMeals() {
  try {
    const data = await readApiResponse(await fetch("/api/meals"));
    savedMeals = data.meals;
    renderSavedMeals();
  } catch (error) {
    savedMealsSelect.innerHTML = '<option value="">Unable to load saved meals</option>';
  }
}

savedMealsSelect.addEventListener("change", () => {
  const meal = savedMeals.find((item) => item.id === Number(savedMealsSelect.value));
  deleteMealButton.disabled = !meal;
  if (!meal) return;
  message.value = meal.ingredients;
  servingsInput.value = String(meal.servings);
  mealNameInput.value = meal.name;
});

saveMealButton.addEventListener("click", async () => {
  const name = mealNameInput.value.trim();
  const ingredients = message.value.trim();
  if (!name) {
    mealNameInput.focus();
    return;
  }
  if (!ingredients) {
    message.focus();
    return;
  }

  saveMealButton.disabled = true;
  try {
    const data = await readApiResponse(await fetch("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        ingredients,
        servings: servingsInput.value,
      }),
    }));
    savedMeals.unshift(data.meal);
    renderSavedMeals();
    savedMealsSelect.value = String(data.meal.id);
    deleteMealButton.disabled = false;
  } catch (error) {
    results.textContent = error.message;
    results.classList.remove("hidden");
  } finally {
    saveMealButton.disabled = false;
  }
});

deleteMealButton.addEventListener("click", async () => {
  const mealId = Number(savedMealsSelect.value);
  if (!mealId) return;

  deleteMealButton.disabled = true;
  try {
    await readApiResponse(await fetch(`/api/meals/${mealId}`, { method: "DELETE" }));
    savedMeals = savedMeals.filter((meal) => meal.id !== mealId);
    renderSavedMeals();
    mealNameInput.value = "";
  } catch (error) {
    results.textContent = error.message;
    results.classList.remove("hidden");
  } finally {
    deleteMealButton.disabled = !savedMealsSelect.value;
  }
});

loadSavedMeals();

importRecipeButton.addEventListener("click", async () => {
  const url = recipeUrlInput.value.trim();
  if (!url) {
    recipeUrlInput.focus();
    return;
  }

  importRecipeButton.disabled = true;
  importRecipeButton.textContent = "Importing...";
  try {
    const data = await readApiResponse(await fetch("/api/recipes/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }));
    message.value = data.recipe.ingredients.join("\n");
    if (data.recipe.name) mealNameInput.value = data.recipe.name;
    if (data.recipe.servings) servingsInput.value = String(data.recipe.servings);
    results.textContent = `Imported ${data.recipe.ingredients.length} ingredients.`;
    results.classList.remove("hidden");
  } catch (error) {
    results.textContent = error.message;
    results.classList.remove("hidden");
  } finally {
    importRecipeButton.disabled = false;
    importRecipeButton.textContent = "Import";
  }
});

button.addEventListener("click", async () => {
  const queries = message.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  
  if (!queries.length) {
    results.textContent = "Enter a food to search.";
    results.classList.remove("hidden");
    return;
  }

  const servings = Math.min(50, Math.max(1, Math.floor(Number(servingsInput.value) || 1)));
  servingsInput.value = String(servings);

  button.disabled = true;
  button.textContent = "Searching...";
  results.textContent = "";
  results.classList.add("hidden");

  try {
    const response = await fetch("/api/foods/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries }),
    });
    const responseText = await response.text();
    let data = {};

    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        if (!response.ok) {
          throw new Error(`Request failed (${response.status} ${response.statusText || ""}). ${responseText.trim()}`.trim());
        }
        throw new Error("The server returned an invalid JSON response.");
      }
    }

    if (!response.ok) {
      throw new Error(data.error || "The USDA API request failed.");
    }

    const formatNumber = (value, digits = 1) => Number(value || 0).toFixed(digits);
    const escapeHtml = (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
    const dailyValues = {
      calories: 2000,
      protein: 50,
      totalFat: 78,
      carbohydrates: 275,
      fiber: 28,
      sugars: 50,
      sodium: 2300,
      cholesterol: 300,
    };
    const nutrients = [
      ["calories", "Calories", "kcal"],
      ["protein", "Protein", "g"],
      ["totalFat", "Total fat", "g"],
      ["carbohydrates", "Carbs", "g"],
      ["fiber", "Fiber", "g"],
      ["sugars", "Sugars", "g"],
      ["sodium", "Sodium", "mg"],
      ["cholesterol", "Cholesterol", "mg"],
    ];

    const foodLines = data.foods.map((food) => {
      if (!food.match) return `<li><strong>${escapeHtml(food.query)}</strong>: No suitable match found.</li>`;
      const matchedName = escapeHtml(`${food.match.description}${food.match.brandOwner ? ` (${food.match.brandOwner})` : ""}`);
      return `<li><strong>${escapeHtml(food.query)}</strong> &rarr; ${matchedName} [${formatNumber(food.grams, 0)} g]</li>`;
    }).join("");

    const rings = nutrients.map(([key, label, unit]) => {
      const perServing = Number(data.totals?.[key] || 0) / servings;
      const percentage = Math.min(100, (perServing / dailyValues[key]) * 100);
      const digits = unit === "kcal" || unit === "mg" ? 0 : 1;
      return `
        <div class="flex flex-col items-center text-center">
          <div role="img" aria-label="${label}: ${formatNumber(perServing, digits)} ${unit}, ${Math.round(percentage)} percent of daily average"
               style="--ring-progress: ${percentage * 3.6}deg"
               class="grid h-28 w-28 place-items-center rounded-full"
               data-ring>
            <div class="grid h-[88px] w-[88px] place-items-center rounded-full bg-white">
              <div>
                <div class="text-lg font-bold">${formatNumber(perServing, digits)}</div>
                <div class="text-xs text-[#69766d]">${unit}</div>
              </div>
            </div>
          </div>
          <div class="mt-2 text-sm font-bold">${label}</div>
          <div class="text-xs text-[#69766d]">${Math.round(percentage)}% daily</div>
        </div>`;
    }).join("");

    const assumption = data.assumedGrams
      ? "Foods without a gram or kilogram amount are estimated at 100 g."
      : "Uses cleaned quantities and estimated gram weights for common counts and cooking units.";

    results.innerHTML = `
      <h2 class="text-xl font-bold">Nutrition for one of ${servings} ${servings === 1 ? "serving" : "servings"}</h2>
      <div class="mt-4 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4">${rings}</div>
      <details class="mt-5 border-t border-[#d3dacb] pt-4 text-sm">
        <summary class="cursor-pointer font-bold">Matched foods</summary>
        <ul class="mt-2 list-disc space-y-1 pl-5">${foodLines}</ul>
      </details>
      <p class="mt-4 text-xs text-[#69766d]">${assumption} Daily percentages use average adult reference values.</p>`;

    for (const ring of results.querySelectorAll("[data-ring]")) {
      ring.style.background = `conic-gradient(#52705b var(--ring-progress), #dde5d7 0deg)`;
    }
    results.classList.remove("hidden");
  } catch (error) {
    results.textContent = error.message;
    results.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Search USDA FoodData Central";
  }
});
