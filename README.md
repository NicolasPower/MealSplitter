# Meal Splitter

A simple static web interface for entering meal text, built with HTML and Tailwind CSS.

## Getting started

Add your USDA FoodData Central API key to `.env`:

```text
USDA_FOOD_CENTRAL_API_KEY=your_api_key_here
```

Then start the included local server:

```powershell
node server.js
```

Then visit `http://localhost:3000`. The button sends the text box value to USDA FoodData Central through `app.js` and `server.js`; the API key stays on the server and is not exposed in browser code.

## Styling

Tailwind CSS is loaded from the Tailwind browser CDN in `index.html`, so no build step or package installation is required.
