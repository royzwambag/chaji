# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm install   # install dependencies (Express only)
npm start     # start server at http://localhost:3333
```

No build step required.

## Architecture

**Cha Ji** (茶記) is a personal Gong Fu Cha tea journal. It's a minimal full-stack app:

- `server.js` — Express REST API on port 3333. Reads/writes all data to `teas.json` (flat file, created at runtime). Serves `index.html` as the static frontend.
- `index.html` — Single-file SPA: all HTML, CSS, and vanilla JS in one file. No framework, no bundler.

### API

```
GET    /api/teas        fetch all entries
POST   /api/teas        create entry
PUT    /api/teas/:id    update entry
DELETE /api/teas/:id    delete entry
```

### Frontend data flow

Page load → `loadFromServer()` → populates `teas[]` array → `render()` updates DOM. User actions call fetch, then update local state and re-render.

### Tea entry schema

```js
{
  id, name, type, origin, vendor, season,
  rating,       // 1–5
  temp,         // °C
  grams, ml,    // brew ratio
  steep,        // first steep in seconds
  notes,
  buyAgain,     // "yes" | "no" | "maybe"
  date          // ISO timestamp, auto-generated
}
```
