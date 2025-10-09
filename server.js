import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: "1mb" }));

const allowOrigin = (origin) => {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const h = u.hostname;
    if (h.endsWith('.bismo.me')) return true;
    if (h.endsWith('.onrender.com')) return true;
    if (h === 'localhost' || h === '127.0.0.1') return true;
  } catch {}
  return false;
};
app.use(cors({
  origin: (origin, cb) => allowOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

const API_KEY = process.env.USDA_API_KEY || "RN4eqxGte5HRZyIaAh6rQl98VfcRvcMdbVnOUa5I";
const SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const DETAILS_URL = "https://api.nal.usda.gov/fdc/v1/food";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();
function cacheGet(k){ const e=cache.get(k); if(!e) return null; if(Date.now()-e.at> CACHE_TTL_MS){ cache.delete(k); return null; } return e.value; }
function cacheSet(k,v){ if(cache.size>=CACHE_MAX){ let ok=null,oa=Infinity; for(const [k2,v2] of cache){ if(v2.at<oa){oa=v2.at; ok=k2;} } if(ok) cache.delete(ok); } cache.set(k,{at:Date.now(),value:v}); }

const unitToGrams = {
  "g": 1, "gram": 1, "grams": 1,
  "kg": 1000,
  "mg": 0.001,
  "lb": 453.592, "pound": 453.592, "pounds": 453.592,
  "oz": 28.3495, "ounce": 28.3495, "ounces": 28.3495,
  "tbsp": 14.2, "tablespoon": 14.2, "tablespoons": 14.2,
  "tsp": 4.7, "teaspoon": 4.7, "teaspoons": 4.7,
  "cup": 240, "cups": 240,
  "ml": 1, "milliliter": 1, "millilitre": 1, "milliliters": 1, "millilitres": 1,
  "l": 1000, "liter": 1000, "litre": 1000, "liters": 1000, "litres": 1000
};

function normalize(s){
  return String(s).replace(/½/g,' 1/2').replace(/¼/g,' 1/4').replace(/¾/g,' 3/4').replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
}
function parseNumber(token){
  token = token.trim();
  const range = token.match(/^(\\d+(?:\\.\\d+)?)\\s*(?:-|to)\\s*(\\d+(?:\\.\\d+)?)$/i);
  if(range){ return (parseFloat(range[1])+parseFloat(range[2]))/2; }
  let total = 0;
  for(const part of token.split(/\\s+/)){
    if(/^(\\d+\\/\\d+)$/.test(part)){ const [a,b] = part.split('/').map(Number); total += a/b; }
    else if(!isNaN(parseFloat(part))){ total += parseFloat(part); }
  }
  return total || NaN;
}
function parseLine(line){
  line = normalize(line);
  const m = line.match(/^(\\d[^a-zA-Z]*)\\s*([a-zA-Z]+)?\\s*(.*)$/);
  if(!m) return null;
  const qty = parseNumber(m[1]);
  const unit = (m[2]||'').toLowerCase();
  let name = (m[3]||'').trim();
  if(unit && !unitToGrams[unit] && name && !name.toLowerCase().startsWith(unit)){ name = unit + ' ' + name; }
  return { qty, unit, name };
}

async function usdaSearch(name){
  const key = 'search:'+name.toLowerCase();
  const hit = cacheGet(key); if(hit) return hit;
  const body = { query: name, pageSize: 10 };
  const url = `${SEARCH_URL}?api_key=${API_KEY}`;
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  const data = await r.json();
  const foods = data.foods || [];
  cacheSet(key, foods);
  return foods;
}
async function usdaDetails(fdcId){
  const key = 'food:'+fdcId;
  const hit = cacheGet(key); if(hit) return hit;
  const url = `${DETAILS_URL}/${fdcId}?api_key=${API_KEY}`;
  const r = await fetch(url);
  const data = await r.json();
  cacheSet(key, data);
  return data;
}

function scorePer100g(per){ let s=0; if(per.kcal) s++; if(per.protein_g) s++; if(per.carbs_g) s++; if(per.fat_g) s++; return s; }

function extractPer100gFromFood(food){
  const out = { kcal:0, protein_g:0, carbs_g:0, fat_g:0, sugar_g:0, satfat_g:0, sodium_mg:0 };
  const nlist = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  for(const n of nlist){
    let name = (n.nutrientName ?? n.nutrient?.name ?? '').toLowerCase();
    let unit = (n.unitName ?? n.nutrient?.unitName ?? '').toLowerCase();
    let val  = (typeof n.value === 'number') ? n.value : (typeof n.amount === 'number' ? n.amount : 0);
    if(!name) continue;
    if (name.includes('energy')){ if(unit==='kcal') out.kcal=Math.max(out.kcal,val); if(unit==='kj') out.kcal=Math.max(out.kcal,val/4.184); }
    if (name.startsWith('protein')) out.protein_g=Math.max(out.protein_g, unit==='g'?val:val);
    if (name.includes('carbohydrate')) out.carbs_g=Math.max(out.carbs_g, unit==='g'?val:val);
    if (name==='total lipid (fat)' || (name.includes('fat') && !name.includes('saturated'))) out.fat_g=Math.max(out.fat_g, unit==='g'?val:val);
    if (name.includes('sugars')) out.sugar_g=Math.max(out.sugar_g, unit==='g'?val:val);
    if (name.includes('fatty acids, total saturated') || name.includes('saturated fat')) out.satfat_g=Math.max(out.satfat_g, unit==='g'?val:val);
    if (name.includes('sodium')){ if(unit==='mg') out.sodium_mg=Math.max(out.sodium_mg,val); else if(unit==='g') out.sodium_mg=Math.max(out.sodium_mg,val*1000); }
  }
  const labels = food.labelNutrients;
  if(labels){
    const perServing = {
      kcal: labels.calories?.value ?? 0,
      protein_g: labels.protein?.value ?? 0,
      carbs_g: labels.carbohydrates?.value ?? 0,
      fat_g: labels.fat?.value ?? 0,
      sugar_g: labels.sugars?.value ?? 0,
      satfat_g: labels.saturatedFat?.value ?? 0,
      sodium_mg: (labels.sodium?.value ?? 0) * 1000
    };
    let servingG = null;
    if (Array.isArray(food.foodPortions)) {
      const fp = food.foodPortions.find(p => typeof p.gramWeight === 'number' && p.gramWeight > 0);
      if (fp) servingG = fp.gramWeight;
    }
    if (!servingG && food.servingSize && food.servingSizeUnit) {
      const u = String(food.servingSizeUnit).toLowerCase();
      if (unitToGrams[u]) servingG = food.servingSize * unitToGrams[u];
    }
    if (servingG && servingG > 0) {
      const f = 100 / servingG;
      out.kcal = Math.max(out.kcal, perServing.kcal * f);
      out.protein_g = Math.max(out.protein_g, perServing.protein_g * f);
      out.carbs_g = Math.max(out.carbs_g, perServing.carbs_g * f);
      out.fat_g = Math.max(out.fat_g, perServing.fat_g * f);
      out.sugar_g = Math.max(out.sugar_g, perServing.sugar_g * f);
      out.satfat_g = Math.max(out.satfat_g, perServing.satfat_g * f);
      out.sodium_mg = Math.max(out.sodium_mg, perServing.sodium_mg * f);
    }
  }
  if(!out.kcal && (out.protein_g || out.carbs_g || out.fat_g)){
    out.kcal = out.protein_g*4 + out.carbs_g*4 + out.fat_g*9;
  }
  return out;
}

function resolvePortionGrams(detail, unitToken){
  if(!detail || !Array.isArray(detail.foodPortions)) return null;
  const u = (unitToken||'').toLowerCase();
  const candidates = detail.foodPortions.filter(p=>{
    const desc = (p.portionDescription||'').toLowerCase();
    const mod  = (p.modifier||'').toLowerCase();
    const mu   = (p.measureUnit?.name||'').toLowerCase();
    return [desc,mod,mu].some(x => x && (x.includes(u) || u.includes(x)));
  });
  if(candidates.length){
    const g = candidates[0].gramWeight;
    if(typeof g === 'number' && g>0) return g;
  }
  return null;
}
function scale(per100g, grams){
  const f = grams/100;
  return {
    kcal: per100g.kcal*f,
    protein_g: per100g.protein_g*f,
    carbs_g: per100g.carbs_g*f,
    fat_g: per100g.fat_g*f,
    sugar_g: per100g.sugar_g*f,
    satfat_g: per100g.satfat_g*f,
    sodium_mg: per100g.sodium_mg*f
  };
}

app.post("/analyze", async (req,res)=>{
  try{
    const { title, ingredients, servings } = req.body;
    if(!Array.isArray(ingredients) || !ingredients.length){
      return res.status(400).json({ error: "ingredients array required" });
    }
    const key = crypto.createHash('sha1').update(JSON.stringify({ingredients, servings})).digest('hex');
    const cached = cacheGet(key); if(cached) return res.json(cached);

    let total = { kcal:0, protein_g:0, carbs_g:0, fat_g:0, sugar_g:0, satfat_g:0, sodium_mg:0, weight_g:0 };

    for(const raw of ingredients){
      const p = parseLine(raw);
      if(!p || !p.name || !p.qty) continue;

      const candidates = await usdaSearch(p.name);
      if(!candidates.length) continue;

      const top = candidates.slice(0,5);
      let bestDetail = null, bestPer = null, bestScore = -1;
      for(const c of top){
        const d = await usdaDetails(c.fdcId);
        const per = extractPer100gFromFood(d);
        const s = scorePer100g(per);
        if(s > bestScore){
          bestScore = s; bestDetail = d; bestPer = per;
        }
      }
      if(!bestDetail) continue;

      let grams = null;
      if(p.unit && unitToGrams[p.unit]) grams = p.qty * unitToGrams[p.unit];
      if(grams===null){
        const portion = resolvePortionGrams(bestDetail, p.unit || p.name.split(' ')[0]);
        if(portion) grams = p.qty * portion;
      }
      if(grams===null){
        if(bestDetail.servingSize && bestDetail.servingSizeUnit){
          const u = String(bestDetail.servingSizeUnit).toLowerCase();
          if(unitToGrams[u]) grams = p.qty * unitToGrams[u] * bestDetail.servingSize;
        }
      }
      if(grams===null){
        grams = p.qty;
      }

      const s = scale(bestPer, grams);
      total.kcal += s.kcal;
      total.protein_g += s.protein_g;
      total.carbs_g += s.carbs_g;
      total.fat_g += s.fat_g;
      total.sugar_g += s.sugar_g;
      total.satfat_g += s.satfat_g;
      total.sodium_mg += s.sodium_mg;
      total.weight_g += grams;
    }

    const perServing = servings ? {
      kcal: total.kcal/servings,
      protein_g: total.protein_g/servings,
      carbs_g: total.carbs_g/servings,
      fat_g: total.fat_g/servings,
      sugar_g: total.sugar_g/servings,
      satfat_g: total.satfat_g/servings,
      sodium_mg: total.sodium_mg/servings
    } : null;

    const payload = { title: title||"Recipe", total, perServing, servings: servings||null };
    cacheSet(key, payload);
    res.json(payload);
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.get('/health', (req,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log('USDA nutrition backend listening on', PORT));
