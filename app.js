const button = document.querySelector("#search-foods");
const message = document.querySelector("#message");
const results = document.querySelector("#food-results");

button.addEventListener("click", async () => {
  const query = message.value.trim();

  if (!query) {
    results.textContent = "Enter a food to search.";
    results.classList.remove("hidden");
    return;
  }

  button.disabled = true;
  button.textContent = "Searching...";
  results.textContent = "";
  results.classList.add("hidden");

  try {
    const response = await fetch("/api/foods/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
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

    const foods = data.foods?.length
      ? data.foods.map((food) => `${food.description}${food.brandOwner ? ` - ${food.brandOwner}` : ""}`).join("\n")
      : "No foods found.";

    results.textContent = foods;
    results.classList.remove("hidden");
  } catch (error) {
    results.textContent = error.message;
    results.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Search USDA FoodData Central";
  }
});
