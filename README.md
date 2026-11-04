# E-books still no match for printed books

An interactive data story comparing printed-book and e-book buying across ten markets in 2020.

**Live page:** https://kishorerabhinav.github.io/print-still-wins/

- Four D3.js figures: a sliced-peach chart (with an orange variant), a dumbbell plot, a ratio bar chart and a parity scatter
- Scroll-triggered animations that respect reduced-motion settings
- Light and dark themes, responsive down to phone width

Data: Statista, 2020 consumer survey. Analysis and design: Abhinav KR.
Original Tableau Public viz: https://public.tableau.com/app/profile/kishorerabhinav/viz/E-BooksStillNoMatchforPrintedBooks/E-BooksStillNoMatchforPrintedBooks

## Tableau D3 extension

`extension/` holds a Tableau dashboard extension that renders the animated D3 views inside a Tableau dashboard:

- `peach.trex` → animated sliced-peach grid (peach/orange styles, re-ordering, two-way selection)
- `scatter.trex` → animated distance-from-parity scatter

In Tableau Desktop: drag an **Extension** object onto the dashboard → **Access Local Extensions** → pick a `.trex` file.
The extension reads summary data from any dashboard sheet that has `Country`, `Format` and `Share` fields.
Opened directly in a browser, each view runs on built-in sample data.
