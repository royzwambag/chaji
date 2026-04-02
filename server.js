const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3333;
const DATA_FILE = path.join(__dirname, 'teas.json');

app.use(express.json());
app.use(express.static(__dirname));

function loadTeas() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTeas(teas) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(teas, null, 2));
}

app.get('/api/teas', (req, res) => {
  res.json(loadTeas());
});

app.post('/api/teas', (req, res) => {
  const teas = loadTeas();
  const tea = { ...req.body, id: Date.now().toString(), date: new Date().toISOString() };
  teas.unshift(tea);
  saveTeas(teas);
  res.json(tea);
});

app.put('/api/teas/:id', (req, res) => {
  const teas = loadTeas();
  const idx = teas.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  teas[idx] = { ...teas[idx], ...req.body, id: req.params.id };
  saveTeas(teas);
  res.json(teas[idx]);
});

app.delete('/api/teas/:id', (req, res) => {
  const teas = loadTeas();
  const filtered = teas.filter(t => t.id !== req.params.id);
  if (filtered.length === teas.length) return res.status(404).json({ error: 'Not found' });
  saveTeas(filtered);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Cha Ji running at http://localhost:${PORT}`);
});
